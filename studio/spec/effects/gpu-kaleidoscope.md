# gpu-kaleidoscope

| | |
|---|---|
| Category | distort |
| Temporal | no |
| Pass | 1 fragment pass |
| HDR | refused (engine throws HdrRenderUnavailableError for the whole chain; a native client must refuse) [C4] |

## What it does
Folds the polar angle around the frame centre into a single wedge and mirrors it, producing `segments` repeated wedges (each wedge is a mirrored pair of half-wedges) around the centre.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| segments | number | 2..16 (step 1, animatable) | 6 | count | number of wedges around the circle |
| rotation | number | 0..6.28318 (step 0.01, animatable) | 0 | radians | rotates the fold pattern |

Mapping (after [C9]; missing → default):
- N = segments, NOT rounded (fractional values from keyframe interpolation are used as-is, giving a non-repeating last wedge).
- wedge angle β = TAU / N, TAU = 6.28318530718.
- φ = rotation.

## Per-pixel definition
For output pixel (i, j) with uv from [C1]:

1. p = uv − (0.5, 0.5).
2. θ = atan2(p.y, p.x) + φ  (atan2 returns (−π, π]; v points down, so θ increases clockwise on screen).
3. ρ = |p|.
4. a = fract(θ / β) · β   (fract(x) = x − floor(x), so a ∈ [0, β)).
5. If a > β/2: a = β − a.   (now a ∈ [0, β/2])
6. q = (cos a, sin a) · ρ + (0.5, 0.5).
7. Output S(q) [C2].

All output pixels therefore sample the source wedge between angle 0 (the +u axis from the centre) and β/2 (turning clockwise on screen, i.e. into the lower-right), at the same radius. `rotation` turns the fold pattern, not the source wedge: the source wedge stays fixed.

## Edges
q is at radius ρ ≤ ≈0.707 from the centre; for ρ > 0.5 it can leave [0,1]² (e.g. pixels in the frame corners map to points beyond the right edge); those read the nearest edge texel [C2].

## Alpha
Straight RGBA sample, alpha carried through unchanged from the sampled point; nothing cleared.

## SDR and HDR
SDR only (encoded values, hardware bilinear, no clamp). HDR: refused.

## Notes
- Polar coordinates are in uv space, not aspect-corrected: on a 16:9 frame the wedges are stretched horizontally and the "circle" is an ellipse (implementation-defined, pinned).
- At the exact frame centre (only when W and H are both odd, giving p = (0, 0)), atan2(0, 0) is implementation-defined in WGSL; with ρ = 0 the sample is (0.5, 0.5) provided the angle is finite. A native port should treat this pixel as S(0.5, 0.5).
- Along wedge boundaries (θ/β within float rounding of an integer or half-integer) the folding is continuous, so rounding choices produce no visible seam.
- Pixels depend on GPU atan2/sin/cos precision (arguments up to ≈ 2π + π, outside the [−π, π] interval where WGSL guarantees accuracy).
