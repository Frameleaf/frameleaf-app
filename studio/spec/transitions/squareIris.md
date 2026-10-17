# squareIris

| | |
|---|---|
| Category | iris |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
A square hole (equal width and height in pixels, axis-aligned) grows from the frame centre; B is seen through it, A outside.

## Parameters
outgoingDim (0 – 0.12, default 0.06). See arrowIris.md §Shared iris machinery.

## Progress curve
p clamped to [0,1]; s = 1.45 · p · max(W, H). Linear.

## Geometry
Layers, even-odd clip and alphas as arrowIris.md §Shared iris machinery. Aperture: closed polygon in unit coordinates

(−1, −1) → (1, −1) → (1, 1) → (−1, 1) → close,

i.e. the pixel square [cx − s, cx + s] × [cy − s, cy + s].

## Blend
See shared section.

## Edges
Axis-aligned straight edges; clip edges decided at pixel centres [T6].

## Alpha
See shared section.

## Notes
- Full coverage when s ≥ max(W,H)/2: p_full = 1/2.9 = 0.344828 for every aspect ratio. From then on A is fully clipped out and the layer is just B at global alpha 0.9 + 0.1·p, i.e. still slightly translucent (lower tracks show through) until p = 1.
