/*
 * Paperclip — frame-by-frame scroll experience.
 *
 * The whole page is a single pinned <canvas>. Vertical scroll does not move any
 * DOM content; it advances a 0..1 timeline that is rendered frame-by-frame:
 *
 *   0.00 – 0.16  HERO      real veo3 video frames (chrome paperclip push-in)
 *   0.18 – 0.34  CHAOS     procedural: ~21 scattered "terminals" jittering
 *   0.34 – 0.52  ORG       procedural: terminals collapse into an org chart
 *   0.52 – 0.70  MOTION    procedural: goals/work pulses flow along the tree
 *   0.70 – 0.90  SCALE     real veo3 video frames (network fly-through)
 *   0.90 – 1.00  FINALE    hero frame returns + CTA
 *
 * Everything is drawn every animation frame, so the scene is alive even when the
 * user is not scrolling (particles drift, pulses travel, glow breathes).
 */

import { HERO_FRAMES, SCALE_FRAMES } from "./assets/manifest.js";

/* --------------------------------------------------------------- helpers --- */
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => {
  t = clamp(t);
  return t * t * (3 - 2 * t);
};
// local 0..1 progress of `p` inside [a,b]
const seg = (p, a, b) => clamp((p - a) / (b - a));
// trapezoid: 0 before a, ramps to 1 by b, holds, ramps to 0 from c to d
const band = (p, a, b, c, d) => {
  if (p <= a || p >= d) return 0;
  if (p < b) return smoothstep((p - a) / (b - a));
  if (p > c) return smoothstep(1 - (p - c) / (d - c));
  return 1;
};
const rand = (seed) => {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/* ----------------------------------------------------------- asset load --- */
function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function loadSequence(list) {
  const imgs = await Promise.all(list.map(loadImage));
  return imgs.filter(Boolean);
}

/* --------------------------------------------------------------- canvas --- */
const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d", { alpha: false });
let W = 0,
  H = 0,
  DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}

function drawCover(img, scale = 1, ox = 0, oy = 0, alpha = 1) {
  if (!img || alpha <= 0) return;
  const ir = img.width / img.height;
  const cr = W / H;
  let dw, dh;
  if (ir > cr) {
    dh = H * scale;
    dw = dh * ir;
  } else {
    dw = W * scale;
    dh = dw / ir;
  }
  const dx = (W - dw) / 2 + ox;
  const dy = (H - dh) / 2 + oy;
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.globalAlpha = 1;
}

/* ----------------------------------------------------- particle starfield --- */
const PARTICLES = Array.from({ length: 90 }, (_, i) => ({
  x: rand(i * 2.1),
  y: rand(i * 3.7),
  z: 0.3 + rand(i * 5.3) * 0.7,
  s: 0.4 + rand(i * 7.9) * 1.8,
}));

function drawParticles(t, alpha) {
  if (alpha <= 0) return;
  ctx.save();
  for (const p of PARTICLES) {
    const drift = (t * 0.01 * p.z) % 1;
    const y = (p.y + drift) % 1;
    const px = p.x * W;
    const py = y * H;
    const tw = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.002 + p.x * 30));
    ctx.globalAlpha = alpha * 0.5 * tw * p.z;
    ctx.fillStyle = p.z > 0.75 ? "#9cc0ff" : "#3d5fa8";
    ctx.beginPath();
    ctx.arc(px, py, p.s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ------------------------------------------------------------ node system --- */
const ACCENT = "#2563eb";
const ACCENT_SOFT = "#4f83ff";
const paperclipPath = new Path2D(
  "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"
);

function buildNodes() {
  const nodes = [];
  const edges = [];
  // Root (CEO)
  nodes.push({ role: "root", ox: 0.5, oy: 0.16 });
  // Execs
  const execX = [0.2, 0.4, 0.6, 0.8];
  const execIdx = [];
  execX.forEach((x) => {
    const id = nodes.length;
    execIdx.push(id);
    nodes.push({ role: "exec", ox: x, oy: 0.44 });
    edges.push([0, id]);
  });
  // Leaves
  const leafCounts = [4, 4, 4, 4];
  execIdx.forEach((eid, k) => {
    const n = leafCounts[k];
    const cx = execX[k];
    for (let j = 0; j < n; j++) {
      const spread = (j - (n - 1) / 2) * 0.06;
      const id = nodes.length;
      nodes.push({ role: "leaf", ox: clamp(cx + spread, 0.06, 0.94), oy: 0.72 });
      edges.push([eid, id]);
    }
  });
  // Chaos positions + jitter seeds
  nodes.forEach((nd, i) => {
    nd.cx = 0.08 + rand(i * 1.7) * 0.84;
    nd.cy = 0.16 + rand(i * 9.1) * 0.7;
    nd.seed = rand(i * 4.4) * 100;
    nd.blink = rand(i * 6.2);
  });
  return { nodes, edges };
}
const NET = buildNodes();

// layout box maps normalized node coords into the centre of the viewport
function layoutBox() {
  const bw = Math.min(W * 0.82, 1040);
  const bh = Math.min(H * 0.74, 640);
  return { x: (W - bw) / 2, y: (H - bh) / 2 + H * 0.02, w: bw, h: bh };
}

function nodePos(nd, assembly, t) {
  const box = layoutBox();
  // chaos position (screen-wide) vs org position (inside layout box)
  const chaosX = nd.cx * W + Math.sin(t * 0.001 + nd.seed) * (1 - assembly) * 26;
  const chaosY = nd.cy * H + Math.cos(t * 0.0013 + nd.seed) * (1 - assembly) * 22;
  const orgX = box.x + nd.ox * box.w;
  const orgY = box.y + nd.oy * box.h;
  const e = smoothstep(assembly);
  return { x: lerp(chaosX, orgX, e), y: lerp(chaosY, orgY, e) };
}

function drawTerminal(x, y, scale, alpha) {
  if (alpha <= 0) return;
  const w = 108 * scale;
  const h = 68 * scale;
  const r = 8 * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x - w / 2, y - h / 2);
  // body
  ctx.fillStyle = "rgba(14,17,24,0.92)";
  ctx.strokeStyle = "rgba(120,150,220,0.35)";
  ctx.lineWidth = 1;
  roundRect(0, 0, w, h, r);
  ctx.fill();
  ctx.stroke();
  // title bar
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  roundRect(0, 0, w, 14 * scale, r);
  ctx.fill();
  ctx.fillStyle = "#ff5f57";
  dot(10 * scale, 7 * scale, 2.2 * scale);
  ctx.fillStyle = "#febc2e";
  dot(18 * scale, 7 * scale, 2.2 * scale);
  ctx.fillStyle = "#28c840";
  dot(26 * scale, 7 * scale, 2.2 * scale);
  // code lines
  for (let i = 0; i < 4; i++) {
    const lw = (0.3 + rand(x + y + i) * 0.55) * (w - 16 * scale);
    ctx.fillStyle = i % 3 === 0 ? "rgba(79,131,255,0.7)" : "rgba(200,210,230,0.35)";
    ctx.fillRect(8 * scale, (22 + i * 10) * scale, lw, 3 * scale);
  }
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function dot(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function glowDot(x, y, r, color, intensity = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 6);
  g.addColorStop(0, color);
  g.addColorStop(0.4, `rgba(79,131,255,${0.35 * intensity})`);
  g.addColorStop(1, "rgba(79,131,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawNetworkNodes(p, t, alpha) {
  if (alpha <= 0) return;
  const assembly = smoothstep(seg(p, 0.34, 0.52));
  const edgeA = smoothstep(seg(p, 0.4, 0.55)) * alpha;
  const pulse = smoothstep(seg(p, 0.52, 0.62)) * alpha;
  const positions = NET.nodes.map((nd) => nodePos(nd, assembly, t));

  // edges
  if (edgeA > 0) {
    ctx.save();
    ctx.lineCap = "round";
    NET.edges.forEach(([a, b], i) => {
      const pa = positions[a];
      const pb = positions[b];
      const grad = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
      grad.addColorStop(0, `rgba(79,131,255,${0.5 * edgeA})`);
      grad.addColorStop(1, `rgba(37,99,235,${0.16 * edgeA})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();

      // travelling pulses: goals flow down (a->b), work flows up (b->a)
      if (pulse > 0) {
        const td = (t * 0.00045 + i * 0.17) % 1;
        const tu = (t * 0.0004 + 0.5 + i * 0.23) % 1;
        const d = { x: lerp(pa.x, pb.x, td), y: lerp(pa.y, pb.y, td) };
        const u = { x: lerp(pb.x, pa.x, tu), y: lerp(pb.y, pa.y, tu) };
        glowDot(d.x, d.y, 2.1, "#dbe7ff", pulse);
        glowDot(u.x, u.y, 1.6, "#7ea6ff", pulse * 0.8);
      }
    });
    ctx.restore();
  }

  // nodes (terminal -> dot morph)
  NET.nodes.forEach((nd, i) => {
    const pos = positions[i];
    const termA = (1 - smoothstep(seg(p, 0.3, 0.46))) * alpha;
    const dotA = smoothstep(seg(p, 0.42, 0.54)) * alpha;
    if (termA > 0.01) {
      const s = lerp(1, 0.4, assembly);
      drawTerminal(pos.x, pos.y, s * (nd.role === "root" ? 1.15 : 1), termA);
    }
    if (dotA > 0.01) {
      const blink =
        nd.role === "leaf"
          ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.004 + nd.blink * 12))
          : 1;
      if (nd.role === "root") {
        drawRootClip(pos.x, pos.y, dotA);
      } else {
        const r = nd.role === "exec" ? 4.2 : 2.8;
        glowDot(pos.x, pos.y, r, "#eaf1ff", dotA * blink);
      }
    }
  });
}

function drawRootClip(x, y, alpha) {
  const size = 44;
  ctx.save();
  ctx.globalAlpha = alpha;
  // glow halo
  const g = ctx.createRadialGradient(x, y, 0, x, y, size * 1.4);
  g.addColorStop(0, "rgba(79,131,255,0.5)");
  g.addColorStop(1, "rgba(79,131,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, size * 1.4, 0, Math.PI * 2);
  ctx.fill();
  // paperclip glyph centered
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = "#eaf1ff";
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(paperclipPath);
  ctx.restore();
}

/* --------------------------------------------------------- video frames --- */
let heroSeq = [];
let scaleSeq = [];

function drawSequence(seq, local, alpha, scale = 1) {
  if (!seq.length || alpha <= 0) return;
  const idx = Math.min(seq.length - 1, Math.floor(local * (seq.length - 1) + 0.0001));
  drawCover(seq[idx], scale, 0, 0, alpha);
}

/* --------------------------------------------------------- scroll state --- */
let targetP = 0;
let renderP = 0;

function computeTarget() {
  const driver = document.getElementById("scrollDriver");
  const max = driver.offsetTop + driver.offsetHeight - window.innerHeight;
  const st = window.scrollY || window.pageYOffset;
  targetP = clamp(st / Math.max(1, max));
}

/* --------------------------------------------------------------- beats --- */
const beatEls = Array.from(document.querySelectorAll(".beat"));
const beatWindows = [
  [0.0, 0.03, 0.11, 0.15],
  [0.18, 0.22, 0.31, 0.35],
  [0.37, 0.41, 0.49, 0.53],
  [0.55, 0.59, 0.67, 0.71],
  [0.74, 0.78, 0.86, 0.9],
  [0.92, 0.95, 1.01, 1.02],
];
function updateBeats(p) {
  beatEls.forEach((el) => {
    const i = Number(el.dataset.beat);
    const [a, b, c, d] = beatWindows[i];
    const o = band(p, a, b, c, d);
    el.style.opacity = o.toFixed(3);
    el.style.transform = `translate(-50%, ${lerp(-40, -52, o).toFixed(1)}%)`;
    if (el.classList.contains("beat--final")) {
      el.classList.toggle("is-live", o > 0.6);
    }
  });
}

/* ----------------------------------------------------------------- draw --- */
function render(t) {
  renderP = lerp(renderP, targetP, 0.09);
  const p = renderP;

  ctx.fillStyle = "#050506";
  ctx.fillRect(0, 0, W, H);

  const heroA = band(p, -0.01, 0.0, 0.14, 0.19);
  const finaleA = smoothstep(seg(p, 0.9, 0.95));
  const nodesA = band(p, 0.16, 0.21, 0.68, 0.73);
  const scaleA = band(p, 0.7, 0.75, 0.99, 1.01);

  // HERO video frames (dolly handled in the clip; add micro settle scale)
  if (heroA > 0) {
    const local = seg(p, 0.0, 0.16);
    drawSequence(heroSeq, local, heroA, 1.02);
  }

  // procedural node story
  drawNetworkNodes(p, t, nodesA);

  // SCALE video frames
  if (scaleA > 0) {
    const local = seg(p, 0.7, 0.9);
    drawSequence(scaleSeq, local, scaleA, 1.0);
  }

  // FINALE — hero paperclip returns and holds behind the CTA
  if (finaleA > 0) {
    const last = heroSeq[0] || null;
    const breathe = 1.0 + Math.sin(t * 0.0015) * 0.01;
    drawCover(last, 1.02 * breathe, 0, 0, finaleA);
  }

  // particle atmosphere across the whole journey
  const atmo = Math.max(heroA * 0.8, nodesA, scaleA * 0.6, finaleA * 0.8);
  drawParticles(t, atmo);

  updateBeats(p);

  // progress rail + nav state
  progressBar.style.width = (p * 100).toFixed(2) + "%";
  nav.classList.toggle("is-scrolled", (window.scrollY || 0) > 40);
  if (!hintHidden && (window.scrollY || 0) > 60) {
    scrollHint.classList.add("is-hidden");
    hintHidden = true;
  }

  requestAnimationFrame(render);
}

/* -------------------------------------------------------------- bootstrap --- */
const progressBar = document.getElementById("progressBar");
const nav = document.getElementById("nav");
const scrollHint = document.getElementById("scrollHint");
let hintHidden = false;

function setDriverHeight() {
  // generous scroll distance for a slow, deliberate scrub
  const vh = window.innerHeight;
  document.getElementById("scrollDriver").style.height = vh * 8 + "px";
}

const prefersReduced = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

async function init() {
  if (prefersReduced) {
    document.body.classList.add("is-reduced");
    return; // static fallback shown via CSS
  }
  resize();
  setDriverHeight();
  window.addEventListener("resize", () => {
    resize();
    setDriverHeight();
  });
  window.addEventListener("scroll", computeTarget, { passive: true });
  computeTarget();

  // Debug: ?p=0.45 snaps the timeline to a fixed position (used for headless
  // screenshot verification). No effect during normal use.
  const forced = new URLSearchParams(location.search).get("p");
  if (forced !== null) {
    const pv = clamp(parseFloat(forced));
    const driver = document.getElementById("scrollDriver");
    const max = driver.offsetTop + driver.offsetHeight - window.innerHeight;
    window.scrollTo(0, pv * max);
    targetP = renderP = pv;
  }

  // Preload sequences (hero first so the opening is instant)
  heroSeq = await loadSequence(HERO_FRAMES);
  requestAnimationFrame(render);
  scaleSeq = await loadSequence(SCALE_FRAMES);
}

init();
