# flip

| | |
|---|---|
| Category | custom |
| Directions | from-left, from-right, from-top, from-bottom [T3] |
| Duration (frames) | default 30, min 10, max 60 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A card flip without perspective: the outgoing clip is squashed about the frame centre line to zero width (or height), then the incoming clip expands from zero back to full size. The area not covered by the squashed image is opaque black.

## Parameters
None. Only p and the direction are used. The direction only selects the axis: from-left and from-right are identical (horizontal squash, scaling u); from-top and from-bottom are identical (vertical squash, scaling v).

## Progress curve
p is used as received; not clamped.
- Phase 1 (p < 0.5): σ = max(cos(2p · π/2), 0.001) = max(cos(πp), 0.001).
- Phase 2 (p ≥ 0.5): σ = max(sin((2p − 1) · π/2), 0.001).

σ goes 1 → 0.001 over phase 1 and 0.001 → 1 over phase 2; σ = 0.001 exactly at p = 0.5.

## Geometry
Horizontal (from-left, from-right): q = ((u − 0.5)/σ + 0.5, v).
Vertical (from-top, from-bottom): q = (u, (v − 0.5)/σ + 0.5).

Out of bounds: oob = (q.x < 0 or q.x > 1 or q.y < 0 or q.y > 1) (strict comparisons; 0 and 1 are in bounds).

## Blend
- Phase 1: c = S(A, q). Phase 2: c = S(B, q).
- Output = (0, 0, 0, 1) (opaque black) if oob, else c.

No mixing between the clips; no clamp.

## Edges
The squashed image has a hard edge to the black surround (no anti-aliasing); the image itself is minified by bilinear sampling without mipmaps, so it aliases strongly when σ is small.

## Alpha
In-bounds alpha is the clip's alpha; the surround is opaque. Output converted to straight alpha per [T2].

## Notes
- Endpoints (SDR float route): p = 0 gives exactly A (σ = 1). p = 1 gives B (σ = sin(π/2) = 1 within GPU sin precision).
- At p = 0.5 the frame is black except pixel columns (rows) whose centre satisfies |u − 0.5| ≤ 0.0005 (only possible when W ≥ 1000, resp. H ≥ 1000); those show B sampled at q = (u − 0.5)·1000 + 0.5 (implementation-defined consequence of the 0.001 floor).
- Values of p outside [0, 1] are not clamped: p < 0 keeps phase 1 with σ = cos(πp) < 1; p > 1 keeps phase 2 with σ = sin((2p − 1)·π/2) < 1 — the clip is squashed again.
