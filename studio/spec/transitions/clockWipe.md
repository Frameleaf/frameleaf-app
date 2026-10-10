# clockWipe

| | |
|---|---|
| Category | wipe |
| Directions | none |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A clock-hand sweep: starting at 12 o'clock and turning clockwise around the frame centre, the swept sector reveals the incoming clip. The edge of the sector is feathered. In addition both clips get a small scale drift and an opacity dip.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| edgeSoftness | number | 0 – 32 (step 0.5) | 8 | catalogue says px | half-width of the feathered sector edge |

Sanitised per [T4]; absent → 8. Mapping: the value is interpreted by the shader as an **angle in degrees**, φ = edgeSoftness · 2π / 360 radians, despite the catalogue unit "px" (implementation-defined, observed).

## Progress curve
p_c = clamp(p, 0, 1).
- θs = 2π · p_c (swept angle)
- feather f = max(0, min(φ, min(θs, 2π − θs))) — shrinks to 0 at both ends
- sA = 1 − 0.04 · p_c, sB = 1.04 − 0.04 · p_c (scales)
- oA = 1 − 0.1 · p_c, oB = 0.85 + 0.15 · p_c (opacities)

## Geometry
Angle of the pixel, measured in pixel space (aspect-correct): d = (u·W − W/2, v·H − H/2) (y grows downward). θ = atan2(d.x, −d.y), which is 0 at 12 o'clock and increases clockwise; if θ < 0 add 2π, giving θ ∈ [0, 2π).

Sector mask m(θ):
- θs ≤ 0 → 0
- θs ≥ 2π → 1
- f ≤ 0.0001 → 1 if θ ≤ θs else 0
- otherwise m = 1 − smoothstep(θs − f, θs + f, θ)

Scaled sampling about the centre (scale floored at 0.001): uvA = (uv − 0.5)/max(sA, 0.001) + 0.5, uvB = (uv − 0.5)/max(sB, 0.001) + 0.5. a = S(A, uvA), b = S(B, uvB) (clamp-to-edge addressing [C2], no mask).

## Blend
Premultiplied: a' = a · oA (all four channels), b' = b · oB. Output = a' · (1 − m) + b' · m. No clamp.

## Edges
The feather is angular, so it is wider (in pixels) far from the centre. The seam at 12 o'clock (θ = 0 versus θ → 2π) is not feathered on the start side: pixels just left of 12 o'clock have θ near 2π and stay outgoing until the sweep reaches them. The outgoing clip is shrunk (sA < 1), so its outer border reads clamp-to-edge (stretched edge texels), not transparency.

## Alpha
Both clips' alpha is multiplied by their opacity, so mid-transition the result is partially transparent even for opaque inputs (e.g. at p = 0.5, alpha ≈ 0.95 outside and 0.925 inside the sector). Output converted to straight alpha per [T2] (which removes the darkening in RGB but keeps the reduced alpha).

## Notes
- Endpoints (SDR float route): p = 0 gives exactly A (θs = 0, sA = 1, oA = 1). p = 1 gives B (θs = 2π → m = 1, sB = 1, oB = 1, within binary32 rounding of 1.04 − 0.04).
- If W (or H) is odd, the centre pixel has d = (0, 0); its angle is atan2(0, −0), platform-defined (typically π). Implementation-defined.
- The reference evaluates angles in binary32; pixels whose θ equals θs exactly are rare and resolve by the ≤ rule.
