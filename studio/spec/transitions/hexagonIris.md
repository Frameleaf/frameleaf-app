# hexagonIris

| | |
|---|---|
| Category | iris |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
A regular hexagon hole (pointed at left and right, flat top and bottom) grows from the frame centre; B is seen through it, A outside.

## Parameters
outgoingDim (0 – 0.12, default 0.06). See arrowIris.md §Shared iris machinery.

## Progress curve
p clamped to [0,1]; s = 1.45 · p · max(W, H). Linear.

## Geometry
Layers, even-odd clip and alphas as arrowIris.md §Shared iris machinery. Aperture: regular 6-gon on the unit circle, vertex k at angle k·π/3 (k = 0 … 5, first vertex at angle 0, increasing clockwise on screen), unit coordinates (cos, sin):

(1, 0) → (0.5, 0.866025) → (−0.5, 0.866025) → (−1, 0) → (−0.5, −0.866025) → (0.5, −0.866025) → close.

Pixels: (cx + u·s, cy + v·s). Circumradius s, apothem (√3/2)·s.

## Blend
See shared section.

## Edges
Straight edges; clip edges decided at pixel centres [T6].

## Alpha
See shared section.

## Notes
- Full coverage when s ≥ max(H/√3, W/2 + H/(2√3)): p_full = max(H/√3, W/2 + H/(2√3)) / (1.45 · max(W,H)); always ≤ 1 (16:9 → 0.4568; 9:16 → 0.3982; 1:1 → 0.5439).
