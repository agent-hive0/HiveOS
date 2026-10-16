# Paperclip marketing site

A story-driven, **frame-by-frame** scrolling landing page for Paperclip — an
Apple-style scroll experience where vertical scroll does not move the page, it
scrubs a single pinned `<canvas>` timeline that is rendered every frame.

## Experience

The page is one fixed canvas. Scroll advances a `0..1` timeline through six beats:

| Range | Beat | Visual |
| ----- | ---- | ------ |
| 0.00–0.16 | Hero | Real generated video frames — a chrome paperclip push-in |
| 0.18–0.34 | The problem | Procedural: ~21 scattered "terminals" jittering in the dark |
| 0.34–0.52 | The shift | The terminals collapse into an org chart |
| 0.52–0.70 | In motion | Goals/work pulses travel the tree; heartbeats blink |
| 0.70–0.90 | The economy | Real generated video frames — a fly-through over a grid of company nodes |
| 0.90–1.00 | Finale | The hero paperclip returns behind the call to action |

Everything is drawn every animation frame, so particles, pulses and glow stay
alive even when the user is not scrolling.

## Assets

Imagery was generated with the **Higgsfield MCP**:

- `nano_banana` produced the cinematic stills (hero paperclip + node grid).
- `veo3` image-to-video animated those stills into the hero and economy shots.
- Frames were extracted at 12fps with `ffmpeg` and stored as WebP sequences in
  `assets/hero/` and `assets/scale/` (listed in `assets/manifest.js`).

## Run it

It is a static site — serve the folder over HTTP (ES modules require it):

```sh
cd marketing
python3 -m http.server 8080
# open http://localhost:8080
```

Append `?p=0.45` to jump the timeline to a fixed position (handy for review).

## Accessibility & fallback

- `prefers-reduced-motion` and no-JS visitors get a normal, static stacked page
  (`.static-fallback`) with the same copy and key imagery.
- Copy lives as real, selectable HTML layered over the canvas (good for SEO).
