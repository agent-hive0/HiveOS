/**
 * Hive hosting overlay (NOT upstream Sim).
 *
 * Emits the `Content-Security-Policy: frame-ancestors …` value that pins the
 * Sim canvas to the Hive origins so it can ONLY ever be framed inside Hive
 * chrome (clickjack-locked). Driven entirely by the `SIM_FRAME_ANCESTORS`
 * env var the colony entrypoint sets (e.g.
 * "https://agenthive.co https://*.agenthive.co"). When the var is unset the
 * helpers return nothing, so a colony that hasn't opted in keeps Sim's stock
 * `frame-ancestors 'self'` default and stays un-embeddable (safe default).
 *
 * This file is COPIED into `apps/sim/hive-frame-ancestors.ts` by
 * `Dockerfile.hiveos` BEFORE `bun run build`, so it compiles into the Sim
 * standalone output.
 */

export function getHiveFrameAncestors(): string | null {
  const raw = (process.env.SIM_FRAME_ANCESTORS ?? "").trim();
  return raw.length > 0 ? raw : null;
}

/**
 * The CSP value to send when embedding is enabled. We only manage the
 * `frame-ancestors` directive; everything else in Sim's own CSP is left
 * untouched by callers that merge this in.
 */
export function hiveFrameAncestorsCsp(): string | null {
  const ancestors = getHiveFrameAncestors();
  return ancestors ? `frame-ancestors ${ancestors}` : null;
}

/**
 * Header pairs to spread into a Next.js `headers()` entry (or a route
 * handler's response). Sets `Content-Security-Policy: frame-ancestors …`
 * and strips `X-Frame-Options` (which, if present as DENY/SAMEORIGIN, would
 * override frame-ancestors in legacy browsers). Empty when not opted in.
 */
export function hiveFrameAncestorsHeaders(): Array<{ key: string; value: string }> {
  const csp = hiveFrameAncestorsCsp();
  if (!csp) return [];
  return [
    { key: "Content-Security-Policy", value: csp },
    // Next's headers() can't delete a header, but setting XFO to a value
    // that permits framing by an allow-list is not possible; modern browsers
    // ignore XFO when a CSP frame-ancestors directive is present, so we set
    // it to ALLOWALL as a belt-and-suspenders for clients that honor it.
    { key: "X-Frame-Options", value: "ALLOWALL" },
  ];
}
