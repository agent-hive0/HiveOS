# Sim embeddable overlay (hiveos)

Hive **hosting** glue (AGENTS.md §7) that makes the bundled, from-source Sim
canvas embeddable inside Hive chrome. Applied by the `hiveos release` workflow
into the Sim source tree **before** `bun run build`, so it compiles into the
standalone output.

| File | Lands at (in Sim) | Purpose |
|---|---|---|
| `hive-handoff-route.ts` | `apps/sim/app/api/access/hive-handoff/route.ts` | Auth handoff broker. 401 tokenless (so the gateway probe learns it exists), mints a Sim better-auth session on a valid per-colony token, 302s to `to`. |
| `hive-frame-ancestors.ts` | `apps/sim/hive-frame-ancestors.ts` | Reads `SIM_FRAME_ANCESTORS` and emits the `frame-ancestors` CSP. |
| `wire-next-config.mjs` | (edits `apps/sim/next.config.*`) | Injects a `headers()` entry applying frame-ancestors to all pages. |

No Sim product behaviour is added — only the handoff + framing glue. The one
Sim-version-specific seam is the better-auth session mint in the handoff route
(`mintSimSession`), which uses `auth.$context` so the cookie format tracks the
running Sim version. Re-validate it whenever the pinned Sim ref changes.
