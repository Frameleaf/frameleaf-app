# diamondIris

| | |
|---|---|
| Category | iris |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
A diamond (square rotated 45°, equal width and height in pixels) hole grows from the frame centre; B is seen through it, A outside.

## Parameters
outgoingDim (0 – 0.12, default 0.06). See arrowIris.md §Shared iris machinery.

## Progress curve
p clamped to [0,1]; s = 1.45 · p · max(W, H). Linear.

## Geometry
Layers, even-odd clip and alphas as arrowIris.md §Shared iris machinery. Aperture: regular 4-gon on the unit circle, first vertex at angle −π/2, vertex k at angle −π/2 + k·π/2 (k = 0 … 3), unit coordinates (cos, sin):

(0, −1) → (1, 0) → (0, 1) → (−1, 0) → close.

Pixels: (cx, cy − s), (cx + s, cy), (cx, cy + s), (cx − s, cy). (Computed with cosine/sine, so the "0" coordinates are ~1e-16 in double precision — irrelevant.)

## Blend
See shared section.

## Edges
45° straight edges; clip edges decided at pixel centres [T6].

## Alpha
See shared section.

## Notes
- Full coverage when W/2 + H/2 ≤ s: p_full = (W + H) / (2.9 · max(W, H)); always ≤ 1 (16:9 → 0.5388; 1:1 → 0.6897; 9:16 → 0.5388).
