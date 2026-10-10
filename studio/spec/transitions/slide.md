# slide

| | |
|---|---|
| Category | motion |
| Directions | from-left, from-right, from-top, from-bottom [T3] |
| Duration (frames) | default 30, min 5, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
Push slide: the incoming clip enters from the named side and pushes the outgoing clip out of the opposite side. Both move together by the same distance p (in frame widths or heights); there is no gap and no overlap.

## Parameters
None. Only p and the direction are used.

## Progress curve
p is used as received; not clamped.

## Geometry
Per direction, sample positions uvA (outgoing), uvB (incoming) and the selector k ∈ {0, 1} (1 = show incoming):

| direction | uvA | uvB | k = 1 when |
|---|---|---|---|
| from-left (0) | (u − p, v) | (u − p + 1, v) | p ≥ u |
| from-right (1) | (u + p, v) | (u − (1 − p), v) | u ≥ 1 − p |
| from-top (2) | (u, v − p) | (u, v − p + 1) | p ≥ v |
| from-bottom (3) | (u, v + p) | (u, v − (1 − p)) | v ≥ 1 − p |

a = S(A, uvA), b = S(B, uvB). Positions outside [0, 1] are read with clamp-to-edge [C2]; they are never selected for display except at the exact boundary column/row (see Edges).

## Blend
Output = a · (1 − k) + b · k (premultiplied, all four channels) — exactly a or exactly b per pixel.

## Edges
The seam is a hard step, no anti-aliasing. Sub-pixel offsets (p · W not an integer) make both clips bilinearly resampled between texel centres; pixels near the frame edges read clamp-to-edge neighbours. The seam pixel rule: from-left/top select B when the coordinate equals p; from-right/bottom select B when the coordinate equals 1 − p.

## Alpha
Alpha follows the selected clip. Output converted to straight alpha per [T2].

## Notes
- Endpoints (SDR float route): p = 0 gives exactly A; p = 1 gives exactly B (uvB = uv).
- from-left/from-right and from-top/from-bottom are exact mirror images.
