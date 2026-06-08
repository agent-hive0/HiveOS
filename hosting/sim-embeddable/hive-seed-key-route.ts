/**
 * Hive hosting overlay (NOT upstream Sim) — boot-time seed for the colony's
 * Sim `/api/v1` workspace API key. Lands at
 * `apps/sim/app/api/access/hive-seed-key/route.ts`.
 *
 * WHY: the Hive Gateway lists/runs a colony's workflows through Sim's STABLE
 * `/api/v1/*` endpoints (`X-API-Key`), which require an `api_key` row whose
 * `key_hash = sha256hex(SIM_API_KEY)` scoped to a workspace. A headless colony
 * has no Sim dashboard, so nobody can click "Settings → Keys → Create". This
 * route mints that key (idempotently) from values the colony already controls.
 *
 * It runs INSIDE Sim's Next runtime, so it imports Sim's own `db`, schema, and
 * api-key crypto — guaranteeing the encrypted `key` blob + `key_hash` exactly
 * match what `/api/v1` auth expects, instead of re-implementing the crypto in a
 * loose script that can't resolve Sim's `@/`/`@sim/` aliases.
 *
 * AUTH: same per-colony token as the handoff (HIVE_SIM_HANDOFF_TOKEN /
 * HIVE_PROXY_TOKEN). GATE: only acts when HIVE_SIM_SEED_API_KEY=1 and
 * SIM_API_KEY is set; otherwise it's an inert 200 {skipped}. Fail-soft: any
 * error is logged and returns 200 so it never blocks boot (the gateway just
 * shows an empty workflows list until the key exists).
 *
 * The four rows /api/v1/workflows needs (verified against the pinned Sim ref):
 *   1. user            — api_key.user_id FK (NOT NULL)
 *   2. workspace       — the id the gateway queries (SIM_WORKSPACE_ID="hive")
 *   3. permissions     — validateWorkspaceAccess() denies if the user has no
 *                        'workspace' permission row on that workspace
 *   4. api_key         — type='workspace', key_hash=sha256hex(SIM_API_KEY)
 */

import { createHash } from "crypto";
import { db } from "@sim/db";
import { apiKey, permissions, user, workspace } from "@sim/db/schema";
import { createLogger } from "@sim/logger";
import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { encryptApiKey, hashApiKey } from "@/lib/api-key/crypto";
import { auth } from "@/lib/auth/auth";

const logger = createLogger("HiveSeedKey");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// WORKSPACE UNIFICATION: the seed user MUST be the SAME principal the embed
// handoff signs in (hive-handoff-route.ts → SIM_HANDOFF_USER_EMAIL, default
// sim-ceo@colony.agenthive.co). One user owns the workspace, owns the api_key,
// AND is the session the gateway writes/canvas runs as — so the CEO (api_key)
// and the session see the SAME workflows with the SAME permissions.
const SERVICE_USER_ID = "hive-ceo";
const SERVICE_USER_EMAIL =
  (process.env.SIM_HANDOFF_USER_EMAIL ?? "").trim() || "sim-ceo@colony.agenthive.co";
const SERVICE_KEY_ID = "hive-gateway-ws";
const SERVICE_PERM_ID = "hive-gateway-ws-perm";

function expectedToken(): string | null {
  const t = (process.env.HIVE_SIM_HANDOFF_TOKEN ?? process.env.HIVE_PROXY_TOKEN ?? "").trim();
  return t.length > 0 ? t : null;
}

function timingSafeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a[i] ^ b[i];
  return out === 0;
}

function tokenValid(presented: string | null): boolean {
  const expected = expectedToken();
  if (!expected || !presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.length === b.length && timingSafeEqualBuf(a, b);
}

function presentedToken(req: NextRequest): string | null {
  const authz = req.headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ")) return authz.slice(7).trim();
  const q = req.nextUrl.searchParams.get("token");
  return q ? q.trim() : null;
}

/**
 * Derive the same password the handoff route uses for `signInEmail`. This
 * keeps the seed and handoff in lockstep — the seed creates the account, the
 * handoff signs in with the same derived password.
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

function workspaceId(): string {
  return (process.env.SIM_WORKSPACE_ID ?? "hive").trim() || "hive";
}

async function seed(): Promise<{ status: string; detail?: string }> {
  const plain = (process.env.SIM_API_KEY ?? "").trim();
  if (process.env.HIVE_SIM_SEED_API_KEY !== "1" || plain === "") {
    return { status: "skipped" };
  }
  const wsId = workspaceId();
  const now = new Date();

  // 1) Colony principal (api_key.user_id FK + handoff session). Created via
  //    better-auth's signUpEmail so BOTH the `user` row AND the `account` row
  //    (with password hash) exist — the handoff route's signInEmail then works
  //    on the first gateway write call. Idempotent: if the user already exists
  //    (handoff ran first, or a prior boot seeded it), we query the existing
  //    row and proceed.
  const password = colonyUserPassword(SERVICE_USER_EMAIL);
  let svcUserId = SERVICE_USER_ID;
  const [existingUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, SERVICE_USER_EMAIL))
    .limit(1);
  if (existingUser) {
    svcUserId = existingUser.id;
  } else {
    try {
      const signedUp = await auth.api.signUpEmail({
        body: { email: SERVICE_USER_EMAIL, password, name: "Hive CEO" },
        asResponse: false,
      });
      if (signedUp?.user?.id) svcUserId = signedUp.user.id;
    } catch {
      // signUp threw (e.g. user already exists via race). Fall through to
      // direct insert so the api_key FK is still satisfiable.
      await db
        .insert(user)
        .values({
          id: SERVICE_USER_ID,
          name: "Hive CEO",
          email: SERVICE_USER_EMAIL,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      const [fallback] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, SERVICE_USER_EMAIL))
        .limit(1);
      if (fallback) svcUserId = fallback.id;
    }
  }

  // 2) Workspace with the fixed id the gateway queries.
  await db
    .insert(workspace)
    .values({
      id: wsId,
      name: "Agent Hive",
      ownerId: svcUserId,
      billedAccountUserId: svcUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  // 3) Workspace permission for the service user (validateWorkspaceAccess gate).
  await db
    .insert(permissions)
    .values({
      id: SERVICE_PERM_ID,
      userId: svcUserId,
      entityType: "workspace",
      entityId: wsId,
      permissionType: "admin",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  // 4) The workspace API key, matched by hash. Idempotent + rotation-safe:
  //    if the current SIM_API_KEY is already seeded, do nothing; otherwise
  //    replace any existing workspace key so a rotated secret takes effect.
  const keyHash = hashApiKey(plain);
  const existing = await db
    .select({ id: apiKey.id })
    .from(apiKey)
    .where(eq(apiKey.keyHash, keyHash))
    .limit(1);
  if (existing.length > 0) {
    return { status: "exists" };
  }

  const { encrypted } = await encryptApiKey(plain);
  await db
    .delete(apiKey)
    .where(and(eq(apiKey.workspaceId, wsId), eq(apiKey.type, "workspace")));
  await db.insert(apiKey).values({
    id: SERVICE_KEY_ID,
    userId: svcUserId,
    workspaceId: wsId,
    createdBy: svcUserId,
    name: "hive-gateway",
    key: encrypted,
    keyHash,
    type: "workspace",
    createdAt: now,
    updatedAt: now,
  });
  return { status: "seeded" };
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!tokenValid(presentedToken(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await seed();
    return NextResponse.json({ ok: true, ...result, workspaceId: workspaceId() });
  } catch (err) {
    // Fail-soft: never block boot. The gateway degrades to an empty list.
    logger.error("hive-seed-key failed", { err: String(err) });
    return NextResponse.json({ ok: false, status: "error", error: String(err) });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
