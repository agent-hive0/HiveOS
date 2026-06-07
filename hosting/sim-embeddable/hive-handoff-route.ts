/**
 * Hive hosting overlay (NOT upstream Sim) — the authenticated embed handoff
 * the Hive gateway 302s the /workflows iframe to (ADR 0024).
 *
 * This file is COPIED into
 *   apps/sim/app/api/access/hive-handoff/route.ts
 * by Dockerfile.hiveos BEFORE `bun run build`, so it compiles into the Sim
 * standalone output and is served by the bundled Sim at
 *   {colony}:8443/api/access/hive-handoff
 *
 * Contract (mirrors Paperclip's /api/auth/handoff, ADR 0008):
 *   • NO / invalid token  -> 401 (NOT 404). The gateway's `isSimEmbeddable`
 *     probe (apps/gateway/src/lib/sim-client.ts) sends a token; a 401 tells
 *     it the route EXISTS and it then reads framing + Set-Cookie. A 404
 *     would mark the colony un-embeddable forever.
 *   • valid token         -> mint a Sim better-auth session for the colony
 *     user, set Sim's session cookie on the colony host (the 302 carries
 *     `Set-Cookie`), 302 to `to`.
 *
 * The token is the per-colony HIVE_SIM_HANDOFF_TOKEN (entrypoint defaults it
 * to the existing per-colony HIVE_PROXY_TOKEN, so no new secret is required).
 *
 * Every response carries `Content-Security-Policy: frame-ancestors …` from
 * SIM_FRAME_ANCESTORS so the probe can read framing on the handoff path
 * itself.
 *
 * SESSION MINT (the one Sim-version-specific seam). We mint via better-auth's
 * PUBLIC server API — `auth.api.signUpEmail` / `signInEmail` with
 * `asResponse: true` and NO inbound headers (a trusted server call) — and
 * forward the resulting `Set-Cookie` headers onto our redirect. Passing the
 * inbound request headers makes better-auth re-derive origin / trustedOrigins
 * / base-URL from the internal bind host and 500 the mint (the failure the 1.4
 * smoke gate caught); omitting them keeps it a clean server-trusted mint. This
 * also keeps cookie name / signing / SameSite in lockstep with the running
 * better-auth version (1.6.x) instead of re-implementing its cookie crypto.
 * The cross-site `SameSite=None; Secure; Partitioned` attributes come from the
 * `auth.ts` overlay (patch-sim-source.mjs #4), which applies them whenever
 * SIM_FRAME_ANCESTORS is set. A handoff that fails to produce a Set-Cookie
 * returns 500 (LOUD) rather than a cookieless 302 that would silently dump the
 * iframe on Sim's own login page.
 */

import { createHash } from "crypto";
import { createLogger } from "@sim/logger";
import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";
import { hiveFrameAncestorsHeaders } from "../../../../hive-frame-ancestors";

const logger = createLogger("HiveHandoff");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Apply the frame-ancestors CSP (if opted in) to any response we return. */
function withFraming<T extends NextResponse>(res: T): T {
  for (const { key, value } of hiveFrameAncestorsHeaders()) {
    res.headers.set(key, value);
  }
  return res;
}

function unauthorized(reason: string): NextResponse {
  // 401 — NOT 404. The gateway probe relies on this to learn the route exists.
  return withFraming(
    NextResponse.json({ error: "unauthorized", reason }, { status: 401 }),
  );
}

function serverError(reason: string): NextResponse {
  return withFraming(NextResponse.json({ error: "handoff_failed", reason }, { status: 500 }));
}

function expectedToken(): string | null {
  const t = (process.env.HIVE_SIM_HANDOFF_TOKEN ?? process.env.HIVE_PROXY_TOKEN ?? "").trim();
  return t.length > 0 ? t : null;
}

/** Constant-time compare of the presented bearer/query token. */
function tokenValid(presented: string | null): boolean {
  const expected = expectedToken();
  if (!expected || !presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.length === b.length && timingSafeEqualBuf(a, b);
}

/** crypto.timingSafeEqual without importing the named symbol (keeps the
 * overlay's import surface minimal + bun/node portable). */
function timingSafeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a[i] ^ b[i];
  return out === 0;
}

function presentedToken(req: NextRequest): string | null {
  const authz = req.headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ")) return authz.slice(7).trim();
  const q = req.nextUrl.searchParams.get("token");
  return q ? q.trim() : null;
}

/**
 * The colony's single Sim user. The colony is single-tenant (one workspace
 * per Fly machine), so all Hive handoffs resolve to one stable Sim account
 * derived from the colony host. NOTE: this is a fresh address (`sim-ceo@`)
 * distinct from any user an earlier handoff build may have created WITHOUT a
 * credential account — so `signUpEmail` always succeeds on first use and
 * `signInEmail` thereafter, instead of deadlocking on a credential-less user.
 */
function colonyUserEmail(req: NextRequest): string {
  const host = (process.env.SIM_COLONY_HOST ?? req.nextUrl.hostname ?? "colony").toLowerCase();
  return `sim-ceo@${host}`;
}

/**
 * A stable, secret, never-displayed password for the colony Sim user. Derived
 * from the colony's server secret so it survives restarts and is identical
 * across handoffs (so `signInEmail` keeps working) without being stored.
 */
function colonyUserPassword(email: string): string {
  const secret = (
    process.env.BETTER_AUTH_SECRET ??
    process.env.HIVE_SIM_HANDOFF_TOKEN ??
    process.env.HIVE_PROXY_TOKEN ??
    ""
  ).trim();
  return createHash("sha256").update(`hive-sim-handoff:v1:${secret}:${email}`).digest("hex");
}

/** Forward every Set-Cookie from a better-auth Response onto our redirect. */
function forwardSetCookies(from: Response, to: NextResponse): boolean {
  const fromH = from.headers as Headers & { getSetCookie?: () => string[] };
  const list = typeof fromH.getSetCookie === "function" ? fromH.getSetCookie() : [];
  if (list.length > 0) {
    for (const c of list) to.headers.append("set-cookie", c);
    return true;
  }
  const single = from.headers.get("set-cookie");
  if (single) {
    to.headers.append("set-cookie", single);
    return true;
  }
  return false;
}

/** A response is usable only if it's OK AND actually carries a Set-Cookie. */
function responseHasSessionCookie(res: Response): boolean {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function" && h.getSetCookie().length > 0) return true;
  return res.headers.has("set-cookie");
}

/** Best-effort short body snippet for diagnostics (never throws). */
async function bodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.clone().text();
    return text.slice(0, 300);
  } catch {
    return "<unreadable>";
  }
}

/**
 * Mint a Sim session for the colony user and return the better-auth Response
 * that carries its Set-Cookie.
 *
 * CRITICAL: these are TRUSTED SERVER calls — we deliberately do NOT forward
 * the inbound request `headers`. Passing them makes better-auth treat this as
 * if it were handling that HTTP request (origin/trustedOrigins + CSRF + base-URL
 * resolution), which 500s the mint when the colony's `BETTER_AUTH_URL` /
 * trustedOrigins don't line up with the internal bind host (the failure the
 * 1.4 smoke gate caught). Without headers it's a server-trusted call that just
 * creates the session and returns the `Set-Cookie`.
 *
 * Order: signUp FIRST (a colony's Sim DB is fresh on first boot, so the colony
 * user doesn't exist yet → signUp + autoSignIn mints a session). If the user
 * already exists (restart / second handoff), signUp errors and we fall back to
 * signInEmail. Either way we require a real Set-Cookie before returning.
 */
async function mintSessionResponse(req: NextRequest): Promise<Response | null> {
  const email = colonyUserEmail(req);
  const password = colonyUserPassword(email);

  try {
    const signedUp = await auth.api.signUpEmail({
      body: { email, password, name: "Hive CEO" },
      asResponse: true,
    });
    if (signedUp.ok && responseHasSessionCookie(signedUp)) return signedUp;
    logger.info("hive-handoff signUpEmail did not mint a session (will try signIn)", {
      status: signedUp.status,
      hasCookie: responseHasSessionCookie(signedUp),
      body: await bodySnippet(signedUp),
    });
  } catch (err) {
    logger.info("hive-handoff signUpEmail threw (will try signIn)", { err: String(err) });
  }

  try {
    const signedIn = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    if (signedIn.ok && responseHasSessionCookie(signedIn)) return signedIn;
    logger.error("hive-handoff signInEmail did not mint a session", {
      status: signedIn.status,
      hasCookie: responseHasSessionCookie(signedIn),
      body: await bodySnippet(signedIn),
    });
  } catch (err) {
    logger.error("hive-handoff signInEmail threw", { err: String(err) });
  }

  return null;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!tokenValid(presentedToken(req))) {
    return unauthorized("missing or invalid handoff token");
  }

  const to = req.nextUrl.searchParams.get("to") || "/";
  // Only allow same-origin relative redirects.
  const safeTo = to.startsWith("/") && !to.startsWith("//") ? to : "/";

  const minted = await mintSessionResponse(req);
  if (!minted) return serverError("could not establish a Sim session");

  // Emit a RELATIVE Location (e.g. `/`) rather than an absolute URL built from
  // req.nextUrl.origin: behind Fly's proxy the bound origin resolves to the
  // internal bind address (https://0.0.0.0:3000), unreachable from the
  // browser. A relative 302 resolves against the browser's public colony
  // origin, so the iframe lands on the real Sim canvas.
  const res = withFraming(new NextResponse(null, { status: 302, headers: { Location: safeTo } }));

  if (!forwardSetCookies(minted, res)) {
    // A redirect with no session cookie is the exact failure that dumps the
    // iframe on Sim's login page — fail loud so the build smoke test catches
    // it instead of shipping a silent regression.
    logger.error("hive-handoff minted a session but no Set-Cookie was produced");
    return serverError("session established but no cookie was set");
  }

  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
