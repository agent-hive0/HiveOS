#!/usr/bin/env node
/**
 * Hive hosting overlay wiring (NOT upstream Sim).
 *
 * Injects the frame-ancestors header into Sim's Next config so the canvas
 * PAGES (not just the handoff API route) are framable by the Hive origins.
 * Run by Dockerfile.hiveos BEFORE `bun run build`:
 *
 *   node hosting/sim-embeddable/wire-next-config.mjs vendor/sim/apps/sim
 *
 * Idempotent + tolerant: the file may be next.config.ts/.mjs/.js upstream;
 * we patch whichever exists. If a `headers()` already merges our marker we
 * no-op. The frame-ancestors value itself is read from SIM_FRAME_ANCESTORS
 * at RUNTIME (see hive-frame-ancestors.ts), so this edit is build-once /
 * env-driven and safe when the var is unset (helper returns []).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const appDir = process.argv[2];
if (!appDir) {
  console.error("[wire-next-config] usage: wire-next-config.mjs <apps/sim dir>");
  process.exit(1);
}

const candidates = ["next.config.ts", "next.config.mjs", "next.config.js"];
const configPath = candidates.map((c) => join(appDir, c)).find((p) => existsSync(p));
if (!configPath) {
  console.error(`[wire-next-config] no next.config.* found in ${appDir}`);
  process.exit(1);
}

const MARKER = "__HIVE_FRAME_ANCESTORS__";
let src = readFileSync(configPath, "utf8");

if (src.includes(MARKER)) {
  console.log(`[wire-next-config] ${configPath} already wired — skipping`);
  process.exit(0);
}

const importLine =
  `import { hiveFrameAncestorsHeaders as ${MARKER} } from './hive-frame-ancestors'\n`;

// A headers() entry that applies frame-ancestors to every route. Next merges
// multiple headers() sources; if Sim already defines headers() we append a
// second async arrow is not possible, so we only inject when none exists.
const headersBlock = `
  async headers() {
    const hive = ${MARKER}()
    if (!hive.length) return []
    return [{ source: '/:path*', headers: hive }]
  },`;

const hasHeaders = /\n\s*async\s+headers\s*\(/.test(src) || /\n\s*headers\s*:/.test(src);

src = importLine + src;

if (hasHeaders) {
  console.warn(
    `[wire-next-config] ${configPath} already defines headers(); ` +
      `frame-ancestors is still enforced on the handoff route + via the ` +
      `entrypoint CSP. Leaving existing headers() untouched.`,
  );
  // Still write the import so the symbol exists if a maintainer wires it.
  writeFileSync(configPath, src);
  process.exit(0);
}

const anchor = "const nextConfig: NextConfig = {";
const anchorJs = "const nextConfig = {";
if (src.includes(anchor)) {
  src = src.replace(anchor, anchor + headersBlock);
} else if (src.includes(anchorJs)) {
  src = src.replace(anchorJs, anchorJs + headersBlock);
} else {
  console.error("[wire-next-config] could not find nextConfig object to patch");
  process.exit(1);
}

writeFileSync(configPath, src);
console.log(`[wire-next-config] wired frame-ancestors headers() into ${configPath}`);
