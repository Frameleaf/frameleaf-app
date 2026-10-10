# triangleIris

| | |
|---|---|
| Category | iris |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
An equilateral triangle hole, point up, centred on the frame centre (its circumcentre is the frame centre), grows; B is seen through it, A outside.

## Parameters
outgoingDim (0 – 0.12, default 0.06). See arrowIris.md §Shared iris machinery.

## Progress curve
p clamped to [0,1]; s = 1.45 · p · max(W, H). Linear.

## Geometry
Layers, even-odd clip and alphas as arrowIris.md §Shared iris machinery. Aperture: regular 3-gon on the unit circle, vertex k at angle −π/2 + k·2π/3 (k = 0, 1, 2), unit coordinates (cos, sin):

(0, −1) → (0.866025, 0.5) → (−0.866025, 0.5) → close.

Pixels: (cx, cy − s), (cx + 0.866025·s, cy + 0.5·s), (cx − 0.866025·s, cy + 0.5·s). Flat bottom edge at y = cy + 0.5·s.

## Blend
See shared section.

## Edges
Straight edges; clip edges decided at pixel centres [T6].

## Alpha
See shared section.

## Notes
- Full coverage when s ≥ max((√3/2)·W + H/2, H): p_full = max(0.866025·W + 0.5·H, H) / (1.45 · max(W,H)); always ≤ 1 but late for square frames (16:9 → 0.7912; 9:16 → 0.6897; 1:1 → 0.9421; 4:3 → 0.8559).
