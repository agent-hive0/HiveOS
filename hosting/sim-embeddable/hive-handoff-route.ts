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
 *     probe (apps/gateway/src/lib/sim-client.ts) sends NO token; a 401 tells
 *     it the route EXISTS and it then reads the frame-ancestors header. A 404
 *     would mark the colony un-embeddable forever.
 *   • valid token         -> mint/load a Sim better-auth session for the
 *     colony user, set Sim's session cookie on the colony host, 302 to `to`.
 *
 * The token is the per-colony HIVE_SIM_HANDOFF_TOKEN (entrypoint defaults it
 * to the existing per-colony HIVE_PROXY_TOKEN, so no new secret is required).
 *
 * Every response carries `Content-Security-Policy: frame-ancestors …` from
 * SIM_FRAME_ANCESTORS so the probe can read framing on the handoff path
 * itself.
 */

import { createHash, timingSafeEqual } from "crypto";
import { db } from "@sim/db";
import * as schema from "@sim/db/schema";
import { createLogger } from "@sim/logger";
import { generateId } from "@sim/utils/id";
import { eq } from "drizzle-orm";
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
  return a.length === b.length && timingSafeEqual(a, b);
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
 * derived from the colony host. Created on first handoff.
 */
function colonyUserEmail(req: NextRequest): string {
  const host = (process.env.SIM_COLONY_HOST ?? req.nextUrl.hostname ?? "colony").toLowerCase();
  return `ceo@${host}`;
}

async function ensureColonyUser(email: string): Promise<string> {
  const existing = await db.query.user.findFirst({ where: eq(schema.user.email, email) });
  if (existing) return existing.id;
  const now = new Date();
  const id = generateId();
  await db.insert(schema.user).values({
    id,
    name: "Hive CEO",
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/**
 * HIVE-SESSION-SEAM (the one Sim-version-specific piece).
 *
 * Mints a better-auth session for `userId` and writes Sim's session cookie
 * onto `res` using better-auth's server context. `auth.$context` exposes the
 * internal adapter + cookie helpers better-auth itself uses, which keeps the
 * cookie name/signing/format in lockstep with the running Sim version instead
 * of us re-implementing better-auth's cookie crypto.
 */
async function mintSimSession(userId: string, res: NextResponse, req: NextRequest): Promise<void> {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId, {
    headers: req.headers,
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    userAgent: req.headers.get("user-agent") ?? undefined,
  } as never);
  // setSessionCookie signs + sets the better-auth session cookie on the
  // response, matching this Sim's auth config (cookie name, secret, maxAge).
  await ctx.setSessionCookie?.(
    { session, user: { id: userId } } as never,
    { res, request: req } as never,
  );
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!tokenValid(presentedToken(req))) {
    return unauthorized("missing or invalid handoff token");
  }

  const to = req.nextUrl.searchParams.get("to") || "/";
  // Only allow same-origin relative redirects.
  const safeTo = to.startsWith("/") && !to.startsWith("//") ? to : "/";

  try {
    const email = colonyUserEmail(req);
    const userId = await ensureColonyUser(email);
    const res = withFraming(NextResponse.redirect(new URL(safeTo, req.nextUrl.origin), 302));
    await mintSimSession(userId, res, req);
    return res;
  } catch (err) {
    logger.error("hive-handoff failed to mint Sim session", { err: String(err) });
    return withFraming(
      NextResponse.json({ error: "handoff_failed" }, { status: 500 }),
    );
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
