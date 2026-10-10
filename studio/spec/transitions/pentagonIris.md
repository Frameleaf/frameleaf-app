# pentagonIris

| | |
|---|---|
| Category | iris |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
A regular pentagon hole, point up, grows from the frame centre; B is seen through it, A outside.

## Parameters
outgoingDim (0 – 0.12, default 0.06). See arrowIris.md §Shared iris machinery.

## Progress curve
p clamped to [0,1]; s = 1.45 · p · max(W, H). Linear.

## Geometry
Layers, even-odd clip and alphas as arrowIris.md §Shared iris machinery. Aperture: regular 5-gon on the unit circle, vertex k at angle −π/2 + k·2π/5 (k = 0 … 4), unit coordinates (cos, sin):

(0, −1) → (0.951057, −0.309017) → (0.587785, 0.809017) → (−0.587785, 0.809017) → (−0.951057, −0.309017) → close.

Pixels: (cx + u·s, cy + v·s). Circumradius s, apothem cos 36°·s = 0.809017·s. Flat bottom edge at y = cy + 0.809017·s.

## Blend
See shared section.

## Edges
Straight edges; clip edges decided at pixel centres [T6].

## Alpha
See shared section.

## Notes
- Full coverage when s ≥ max(0.293893·W + 0.404508·H, 0.475528·W + 0.154508·H, 0.5·H) / 0.809017; always reached before p = 1 (16:9 → 0.4795; 9:16 → 0.4857; 1:1 → 0.5954).
