#!/usr/bin/env node
/**
 * Hive hosting overlay (NOT upstream Sim).
 *
 * Patches the bundled-from-source Sim app so the Workflows CANVAS (not just the
 * chat/form embeds) can be framed inside the Hive app shell. Run by the
 * `hiveos release` workflow's "Apply Sim embed overlay" step, BEFORE
 * `bun run build`, so the edits compile into the standalone output:
 *
 *   node hosting/sim-embeddable/patch-sim-source.mjs vendor/sim/apps/sim
 *
 * Everything is driven by the per-colony `SIM_FRAME_ANCESTORS` env var (set by
 * scripts/hiveos-engines.sh, default "https://agenthive.co https://*.agenthive.co").
 * The patches are env-gated so that with the var unset the app keeps stock Sim
 * behavior (frame-ancestors 'self', X-Frame-Options: SAMEORIGIN, SameSite=Lax).
 *
 * Four edits — see ADR 0024 (Hive Workflows embed):
 *   1. lib/core/security/csp.ts  — frame-ancestors includes SIM_FRAME_ANCESTORS
 *      (runtime middleware CSP) + a getCanvasEmbedCSPPolicy() for build-time
 *      baked canvas routes.
 *   2. proxy.ts (middleware)     — drop X-Frame-Options:SAMEORIGIN on the canvas
 *      routes (/, /workspace/*, /login, /signup) when embedding is enabled.
 *   3. next.config.ts            — drop X-Frame-Options + apply the canvas embed
 *      CSP on /w/* and exclude /w/* + /api/access from the strict header block.
 *   4. lib/auth/auth.ts          — session cookie SameSite=None; Secure;
 *      Partitioned so it is sent inside the cross-site iframe.
 *
 * Idempotent: each edit checks for its `// __HIVE_EMBED__` marker first. Fails
 * LOUDLY if an upstream Sim change moves an anchor, so the embed never silently
 * regresses to "No workflows yet".
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const appDir = process.argv[2]
if (!appDir) {
  console.error('[patch-sim-source] usage: patch-sim-source.mjs <apps/sim dir>')
  process.exit(1)
}

const MARKER = '__HIVE_EMBED__'

/** Read a file, asserting it exists. */
function read(rel) {
  const p = join(appDir, rel)
  if (!existsSync(p)) {
    console.error(`[patch-sim-source] missing file: ${p}`)
    process.exit(1)
  }
  return { p, src: readFileSync(p, 'utf8') }
}

/** Replace exactly one occurrence of `anchor`, asserting it is present & unique. */
function replaceOnce(src, anchor, replacement, label) {
  const idx = src.indexOf(anchor)
  if (idx === -1) {
    console.error(`[patch-sim-source] anchor not found (${label}). Upstream Sim moved? Aborting.`)
    process.exit(1)
  }
  if (src.indexOf(anchor, idx + anchor.length) !== -1) {
    console.error(`[patch-sim-source] anchor not unique (${label}). Aborting.`)
    process.exit(1)
  }
  return src.slice(0, idx) + replacement + src.slice(idx + anchor.length)
}

// ---------------------------------------------------------------------------
// 1. csp.ts — frame-ancestors from SIM_FRAME_ANCESTORS
// ---------------------------------------------------------------------------
{
  const { p, src: orig } = read('lib/core/security/csp.ts')
  if (orig.includes(MARKER)) {
    console.log('[patch-sim-source] csp.ts already patched — skipping')
  } else {
    let src = orig

    const importAnchor =
      "import { isDev, isHosted, isReactGrabEnabled } from '../config/feature-flags'\n"
    src = replaceOnce(
      src,
      importAnchor,
      importAnchor +
        `
// ${MARKER} Hive hosting overlay: the Hive app shell frames the Sim canvas, so
// frame-ancestors must admit the Hive origins. Driven by SIM_FRAME_ANCESTORS
// (space-separated origins) at request time; unset => stock 'self' only.
const HIVE_DEFAULT_FRAME_ANCESTORS = 'https://agenthive.co https://*.agenthive.co'
function hiveFrameAncestors(useHiveDefault: boolean): string[] {
  const raw = (getEnv('SIM_FRAME_ANCESTORS') ?? '').trim()
  const value = raw.length > 0 ? raw : useHiveDefault ? HIVE_DEFAULT_FRAME_ANCESTORS : ''
  const extra = value.length > 0 ? value.split(/\\s+/) : []
  return ["'self'", ...extra]
}
`,
      'csp.ts import',
    )

    // Runtime middleware CSP (/, /workspace/*, /login, /signup) — env-driven.
    const runtimeAnchor =
      "  const runtimeDirectives: CSPDirectives = {\n    ...buildTimeCSPDirectives,\n\n    'img-src': [...STATIC_IMG_SRC],\n"
    src = replaceOnce(
      src,
      runtimeAnchor,
      "  const runtimeDirectives: CSPDirectives = {\n    ...buildTimeCSPDirectives,\n\n" +
        `    // ${MARKER} let the Hive app shell frame the canvas (runtime env)\n` +
        "    'frame-ancestors': hiveFrameAncestors(false),\n\n    'img-src': [...STATIC_IMG_SRC],\n",
      'csp.ts runtimeDirectives',
    )

    // Build-time baked CSP for canvas routes handled in next.config (/w/*).
    const formFnAnchor =
      'export function getFormEmbedCSPPolicy(): string {\n  return getEmbedCSPPolicy()\n}\n'
    src = replaceOnce(
      src,
      formFnAnchor,
      formFnAnchor +
        `
/**
 * ${MARKER} CSP for the Sim Workflows canvas routes embedded by Hive. Clickjack-
 * locked to the Hive origins (frame-ancestors), not the wildcard chat/form embed
 * policy. Build-time baked (next.config headers()) — SIM_FRAME_ANCESTORS is unset
 * during \`next build\`, so it falls back to the Hive default origins.
 */
export function getCanvasEmbedCSPPolicy(): string {
  return buildCSPString({
    ...buildTimeCSPDirectives,
    'frame-ancestors': hiveFrameAncestors(true),
  })
}
`,
      'csp.ts getFormEmbedCSPPolicy',
    )

    writeFileSync(p, src)
    console.log('[patch-sim-source] csp.ts patched')
  }
}

// ---------------------------------------------------------------------------
// 2. proxy.ts (middleware) — drop X-Frame-Options on canvas routes
// ---------------------------------------------------------------------------
{
  const { p, src: orig } = read('proxy.ts')
  if (orig.includes(MARKER)) {
    console.log('[patch-sim-source] proxy.ts already patched — skipping')
  } else {
    let src = orig

    // Rewrite the canvas-route X-Frame-Options call sites FIRST (3 of them:
    // /login+/signup, /workspace/*, /), before inserting the helper — otherwise
    // the replace would also clobber the helper's own body (it sets SAMEORIGIN).
    const xfo = "response.headers.set('X-Frame-Options', 'SAMEORIGIN')"
    if (!src.includes(xfo)) {
      console.error('[patch-sim-source] proxy.ts X-Frame-Options anchor not found. Aborting.')
      process.exit(1)
    }
    src = src.split(xfo).join('applyHiveFrameOptions(response)')

    const loggerAnchor = "const logger = createLogger('Proxy')\n"
    src = replaceOnce(
      src,
      loggerAnchor,
      loggerAnchor +
        `
// ${MARKER} Hive hosting overlay: when the colony Sim is embedded in the Hive app
// shell (SIM_FRAME_ANCESTORS set), the canvas is framed cross-origin, so we must
// NOT pin X-Frame-Options: SAMEORIGIN (which blanks the frame). The runtime CSP
// frame-ancestors directive governs framing instead. Unset => stock SAMEORIGIN.
function applyHiveFrameOptions(response: NextResponse): void {
  if ((getEnv('SIM_FRAME_ANCESTORS') ?? '').trim().length > 0) return
  response.headers.set('X-Frame-Options', 'SAMEORIGIN')
}

// ${MARKER} Hive hosting overlay: NEVER let Sim's own /login or /signup render
// inside the Hive embed. When embedding is enabled (SIM_FRAME_ANCESTORS set) and
// an unauthenticated request hits a canvas/auth route (/, /w/*, /workspace/*,
// /login, /signup), bounce ONCE through the colony's authenticated handoff
// (/api/access/hive-handoff, which mints a Sim session cookie) and come back. The
// one-shot _hs marker rides on the return target, so if the session STILL isn't
// present after the round-trip (e.g. the cross-site cookie was blocked) we render
// a minimal Hive "Reconnecting…" page instead of Sim's email/password form.
// Unset SIM_FRAME_ANCESTORS => inert (stock Sim auth behavior).
const HIVE_EMBED_HANDOFF_PATH = '/api/access/hive-handoff'
const HIVE_EMBED_MARKER = '_hs'

function hiveEmbedEnabled(): boolean {
  return (getEnv('SIM_FRAME_ANCESTORS') ?? '').trim().length > 0
}

function hiveHandoffToken(): string {
  return (getEnv('HIVE_SIM_HANDOFF_TOKEN') ?? getEnv('HIVE_PROXY_TOKEN') ?? '').trim()
}

function hiveFrameAncestorsCspValue(): string {
  const extra = (getEnv('SIM_FRAME_ANCESTORS') ?? '').trim()
  return extra.length > 0 ? "frame-ancestors 'self' " + extra : "frame-ancestors 'self'"
}

function isHiveGuardedPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/w' ||
    pathname.startsWith('/w/') ||
    pathname === '/workspace' ||
    pathname.startsWith('/workspace/')
  )
}

function hiveReconnectingHtml(): string {
  return "<!doctype html><html lang='en'><head>" +
    "<meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>Reconnecting</title>" +
    "<style>html,body{height:100%;margin:0}" +
    "body{display:flex;align-items:center;justify-content:center;" +
    "font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;" +
    "background:#0b0b0f;color:#e9e9ee}" +
    ".card{text-align:center;max-width:24rem;padding:2rem}" +
    ".dot{width:.5rem;height:.5rem;border-radius:9999px;background:#f5b301;" +
    "display:inline-block;margin:0 .18rem;animation:hb 1s infinite ease-in-out}" +
    ".dot:nth-child(2){animation-delay:.15s}.dot:nth-child(3){animation-delay:.3s}" +
    "@keyframes hb{0%,80%,100%{opacity:.25}40%{opacity:1}}" +
    "h1{font-size:1.05rem;font-weight:600;margin:1rem 0 .35rem}" +
    "p{font-size:.85rem;color:#a8a8b3;margin:0}" +
    "a{color:#f5b301;font-size:.8rem;text-decoration:none}</style></head>" +
    "<body><div class='card'>" +
    "<div><span class='dot'></span><span class='dot'></span><span class='dot'></span></div>" +
    "<h1>Reconnecting your workspace...</h1>" +
    "<p>Securing your session. This page refreshes automatically.</p>" +
    "<p style='margin-top:1rem'><a href='/'>Try again</a></p>" +
    "</div>" +
    "<script>try{if(!sessionStorage.getItem('hiveReconnectTried')){sessionStorage.setItem('hiveReconnectTried','1');setTimeout(function(){location.replace('/')},3000)}}catch(e){}</script>" +
    "</body></html>"
}

function hiveReconnectingResponse(): NextResponse {
  return new NextResponse(hiveReconnectingHtml(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': hiveFrameAncestorsCspValue(),
      'X-Frame-Options': 'ALLOWALL',
    },
  })
}

function applyHiveEmbedLoginGuard(
  request: NextRequest,
  hasActiveSession: boolean,
): NextResponse | null {
  if (!hiveEmbedEnabled() || hasActiveSession) return null
  const url = request.nextUrl
  if (!isHiveGuardedPath(url.pathname)) return null

  // Already round-tripped through the handoff and still unauthenticated: the
  // session cookie didn't stick. Show the Hive reconnect page — NEVER Sim login.
  if (url.searchParams.has(HIVE_EMBED_MARKER)) {
    return hiveReconnectingResponse()
  }

  const token = hiveHandoffToken()
  if (!token) return null // no handoff token configured — can't mint; don't loop

  // Return target carries the one-shot marker so the next pass detects a failed
  // mint instead of looping forever. Location is RELATIVE so it resolves against
  // the browser's public colony origin (not Fly's internal bind host).
  const sep = url.search ? '&' : '?'
  const to = url.pathname + url.search + sep + HIVE_EMBED_MARKER + '=1'
  const loc =
    HIVE_EMBED_HANDOFF_PATH +
    '?token=' +
    encodeURIComponent(token) +
    '&to=' +
    encodeURIComponent(to)
  const res = new NextResponse(null, { status: 302 })
  res.headers.set('Location', loc)
  res.headers.set('Cache-Control', 'no-store')
  return res
}
`,
      'proxy.ts logger',
    )

    // Run the never-show-login guard right after the session check, before any
    // stock redirect can send the embedded iframe to Sim's /login.
    const sessionAnchor =
      '  const hasActiveSession = isAuthDisabled || !!sessionCookie\n'
    src = replaceOnce(
      src,
      sessionAnchor,
      sessionAnchor +
        `
  // ${MARKER} Hive embed: bounce unauthenticated canvas/auth routes through the
  // authenticated handoff (or show the Hive reconnect page) — never Sim's login.
  const hiveLoginGuard = applyHiveEmbedLoginGuard(request, hasActiveSession)
  if (hiveLoginGuard) return track(request, hiveLoginGuard)
`,
      'proxy.ts session guard call',
    )

    writeFileSync(p, src)
    console.log('[patch-sim-source] proxy.ts patched')
  }
}

// ---------------------------------------------------------------------------
// 3. next.config.ts — canvas embed headers for /w/* + exclude from strict block
// ---------------------------------------------------------------------------
{
  const { p, src: orig } = read('next.config.ts')
  if (orig.includes(MARKER)) {
    console.log('[patch-sim-source] next.config.ts already patched — skipping')
  } else {
    let src = orig

    const importAnchor =
      "import {\n  getChatEmbedCSPPolicy,\n  getFormEmbedCSPPolicy,\n  getMainCSPPolicy,\n  getWorkflowExecutionCSPPolicy,\n} from './lib/core/security/csp'"
    src = replaceOnce(
      src,
      importAnchor,
      "import {\n  getCanvasEmbedCSPPolicy,\n  getChatEmbedCSPPolicy,\n  getFormEmbedCSPPolicy,\n  getMainCSPPolicy,\n  getWorkflowExecutionCSPPolicy,\n} from './lib/core/security/csp'",
      'next.config.ts import',
    )

    // Exclude /w/* and /api/access (hive-handoff) from the strict SAMEORIGIN block.
    const strictAnchor = "source: '/((?!workspace|chat|form|login|signup|$).*)',"
    src = replaceOnce(
      src,
      strictAnchor,
      "source: '/((?!workspace|chat|form|login|signup|w/|api/access|$).*)', // __HIVE_EMBED__ excl canvas + handoff",
      'next.config.ts strict block source',
    )

    // Insert a canvas embed header block (no XFO, Hive-locked frame-ancestors).
    const insertAnchor =
      '      // Apply security headers to routes not handled by middleware runtime CSP'
    src = replaceOnce(
      src,
      insertAnchor,
      `      // ${MARKER} Sim canvas editor (/w/*) — framable by the Hive app shell.
      // No X-Frame-Options; CSP frame-ancestors is clickjack-locked to Hive.
      // (COEP/COOP for /w/* are already set by the permissive block above.)
      {
        source: '/w/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Content-Security-Policy', value: getCanvasEmbedCSPPolicy() },
        ],
      },
` + insertAnchor,
      'next.config.ts headers insert',
    )

    writeFileSync(p, src)
    console.log('[patch-sim-source] next.config.ts patched')
  }
}

// ---------------------------------------------------------------------------
// 4. auth.ts — cross-site session cookie (SameSite=None; Secure; Partitioned)
// ---------------------------------------------------------------------------
{
  const { p, src: orig } = read('lib/auth/auth.ts')
  if (orig.includes(MARKER)) {
    console.log('[patch-sim-source] auth.ts already patched — skipping')
  } else {
    let src = orig

    const authAnchor = 'export const auth = betterAuth({\n  baseURL: getBaseUrl(),\n'
    src = replaceOnce(
      src,
      authAnchor,
      'export const auth = betterAuth({\n  baseURL: getBaseUrl(),\n' +
        `  // ${MARKER} Hive hosting overlay: when the colony Sim is embedded in the
  // Hive app shell (SIM_FRAME_ANCESTORS set), the better-auth session cookie is
  // set + sent inside a cross-site iframe, so it must be SameSite=None; Secure.
  // Partitioned (CHIPS) keeps it working under Chrome's partitioned third-party
  // storage. Unset => stock Sim cookie behavior (SameSite=Lax).
  ...(((process.env.SIM_FRAME_ANCESTORS ?? '').trim().length > 0)
    ? {
        advanced: {
          defaultCookieAttributes: {
            sameSite: 'none' as const,
            secure: true,
            partitioned: true,
          },
        },
      }
    : {}),
`,
      'auth.ts betterAuth baseURL',
    )

    writeFileSync(p, src)
    console.log('[patch-sim-source] auth.ts patched')
  }
}

console.log('[patch-sim-source] all Sim embed patches applied')
