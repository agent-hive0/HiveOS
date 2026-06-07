# Sim embeddable overlay (hiveos)

Hive **hosting** glue (AGENTS.md §7) that makes the bundled, from-source Sim
canvas embeddable inside Hive chrome. Applied by the `hiveos release` workflow
into the Sim source tree **before** `bun run build`, so it compiles into the
standalone output.

| File | Lands at (in Sim) | Purpose |
|---|---|---|
| `hive-handoff-route.ts` | `apps/sim/app/api/access/hive-handoff/route.ts` | Auth handoff broker. 401 tokenless (so the gateway probe learns it exists), mints a Sim better-auth session on a valid per-colony token, 302s (RELATIVE `Location`) to `to`. |
| `hive-frame-ancestors.ts` | `apps/sim/hive-frame-ancestors.ts` | Reads `SIM_FRAME_ANCESTORS` and emits the `frame-ancestors` CSP (used by the handoff route). |
| `patch-sim-source.mjs` | (edits `csp.ts`, `proxy.ts`, `next.config.ts`, `lib/auth/auth.ts`) | Patches Sim's OWN source so the canvas (`/`, `/workspace/*`, `/w/*`) is framable: frame-ancestors from `SIM_FRAME_ANCESTORS`, no `X-Frame-Options: SAMEORIGIN` on canvas routes, and a `SameSite=None; Secure; Partitioned` session cookie. Idempotent; fails loudly if an upstream anchor moves. |
| `wire-next-config.mjs` | (legacy) | Superseded by `patch-sim-source.mjs`; no longer invoked by the release workflow. Kept for reference. |

No Sim product behaviour is added — only the handoff + framing glue. Two
Sim-version-specific seams to re-validate whenever the pinned Sim ref changes:
the better-auth session mint in the handoff route (`mintSimSession`, uses
`auth.$context`), and the source anchors `patch-sim-source.mjs` keys off (the
script aborts the build if any anchor moves, so a regression is caught at build).
