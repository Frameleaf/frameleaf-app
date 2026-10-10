# wipe

| | |
|---|---|
| Category | motion |
| Directions | from-left, from-right, from-top, from-bottom [T3] |
| Duration (frames) | default 30, min 5, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A hard-edged straight wipe: a line sweeps across the frame from the named side, and everything it has passed shows the incoming clip. Neither clip moves.

## Parameters
None. Only p and the direction are used.

## Progress curve
p is used as received; it is not clamped (values outside [0, 1] simply put the edge outside the frame).

## Geometry
Sweep coordinate s per direction [T3]:
| direction | s |
|---|---|
| from-left (0) | u |
| from-right (1) | 1 − u |
| from-top (2) | v |
| from-bottom (3) | 1 − v |

Both clips are sampled unmoved: a = S(A, uv), b = S(B, uv) (at pixel centres this is the texel value itself).

## Blend
k = 1 if p ≥ s, else 0. Output = a · (1 − k) + b · k, i.e. exactly b where p ≥ s and exactly a elsewhere (all four premultiplied channels).

## Edges
The boundary is a hard step with no anti-aliasing: a pixel switches when the sweep value at its centre, (i + 0.5)/W (or the vertical/mirrored equivalent), is ≤ p. The pixel exactly at s = p shows B.

## Alpha
Alpha follows the selected clip. Output converted to straight alpha per [T2]; no clamping (none needed).

## Notes
- Endpoints (SDR float route): p = 0 gives exactly A (all pixel centres have s > 0); p = 1 gives exactly B (all s < 1).
- from-left and from-right (and from-top / from-bottom) are exact mirror images.
