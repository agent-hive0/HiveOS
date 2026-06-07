# Sim embeddable overlay (hiveos)

Hive **hosting** glue (AGENTS.md §7) that makes the bundled, from-source Sim
canvas embeddable inside Hive chrome. Applied by the `hiveos release` workflow
into the Sim source tree **before** `bun run build`, so it compiles into the
standalone output.

| File | Lands at (in Sim) | Purpose |
|---|---|---|
| `hive-handoff-route.ts` | `apps/sim/app/api/access/hive-handoff/route.ts` | Auth handoff broker. 401 tokenless (so the gateway probe learns it exists), mints a Sim better-auth session on a valid per-colony token, 302s (RELATIVE `Location`) to `to`. |
| `hive-seed-key-route.ts` | `apps/sim/app/api/access/hive-seed-key/route.ts` | Boot seed for Sim's `/api/v1` workspace API key. Token-gated (same token as the handoff). When `HIVE_SIM_SEED_API_KEY=1` + `SIM_API_KEY` set, idempotently upserts the service `user` + `workspace` (`SIM_WORKSPACE_ID`) + `permissions` + `api_key` (`key_hash=sha256hex(SIM_API_KEY)`, `type='workspace'`) so the gateway's native workflows list authenticates. Fail-soft (200 on error). Called by `hiveos-engines.sh` once Sim is serving. |
| `hive-frame-ancestors.ts` | `apps/sim/hive-frame-ancestors.ts` | Reads `SIM_FRAME_ANCESTORS` and emits the `frame-ancestors` CSP (used by the handoff route). |
| `patch-sim-source.mjs` | (edits `csp.ts`, `proxy.ts`, `next.config.ts`, `lib/auth/auth.ts`) | Patches Sim's OWN source so the canvas (`/`, `/workspace/*`, `/w/*`) is framable: frame-ancestors from `SIM_FRAME_ANCESTORS`, no `X-Frame-Options: SAMEORIGIN` on canvas routes, and a `SameSite=None; Secure; Partitioned` session cookie. Idempotent; fails loudly if an upstream anchor moves. |
| `wire-next-config.mjs` | (legacy) | Superseded by `patch-sim-source.mjs`; no longer invoked by the release workflow. Kept for reference. |

No Sim product behaviour is added — only the handoff + framing glue. Two
Sim-version-specific seams to re-validate whenever the pinned Sim ref changes:
the better-auth session mint in the handoff route (`mintSessionResponse`, uses
the PUBLIC `auth.api.signUpEmail` / `signInEmail` with `asResponse: true` and
**no inbound headers** — a trusted server call — and forwards the resulting
`Set-Cookie`; passing the inbound headers makes better-auth re-derive
origin/trustedOrigins/base-URL from the internal bind host and 500 the mint,
and `auth.$context.setSessionCookie` does not exist / silently no-ops), and the
source anchors `patch-sim-source.mjs` keys off (the script aborts the build if
any anchor moves). The release smoke test asserts a valid-token handoff returns
a `Set-Cookie` (and on failure dumps the route's `HiveHandoff` logs), so a
cookieless-mint regression fails the build, not production.
