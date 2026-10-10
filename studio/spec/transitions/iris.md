# iris

| | |
|---|---|
| Category | iris |
| Directions | none |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A circle centred on the frame grows from nothing until it is larger than the frame, revealing the incoming clip inside it. The circle is round in pixels (aspect-correct) and its edge is feathered. Both clips also get a small scale drift and an opacity dip.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| edgeSoftness | number | 0 – 32 (step 0.5) | 6 | px | half-width of the feathered circle edge |

Sanitised per [T4]; absent → 6. Used directly in output pixels.

## Progress curve
p_c = clamp(p, 0, 1).
- R = 1.2 · sqrt((W/2)² + (H/2)²) (1.2 × half-diagonal)
- r = p_c · R
- feather f = max(0, min(edgeSoftness, min(r, R − r)))
- sA = 1 − 0.04 · p_c, sB = 1.04 − 0.04 · p_c
- oA = 1 − 0.1 · p_c, oB = 0.85 + 0.15 · p_c

## Geometry
Distance of the pixel centre from the frame centre in pixels: δ = length((u·W, v·H) − (W/2, H/2)).

Circle mask m:
- r ≤ 0 → 0
- f ≤ 0.001 → 1 if δ ≤ r else 0
- otherwise m = 1 − smoothstep(r − f, r + f, δ)

Scaled sampling about the centre (scale floored at 0.001): uvA = (uv − 0.5)/max(sA, 0.001) + 0.5, uvB = (uv − 0.5)/max(sB, 0.001) + 0.5. a = S(A, uvA), b = S(B, uvB) (clamp-to-edge [C2]).

## Blend
a' = a · oA, b' = b · oB (all four premultiplied channels). Output = a' · (1 − m) + b' · m. No clamp.

## Edges
The outgoing clip is shrunk (sA < 1); its border reads clamp-to-edge (stretched edge texels), not transparency.

## Alpha
Alpha is scaled by the opacities as for clockWipe; opaque inputs give alpha < 1 mid-transition (minimum 0.9 outside, 0.85 + 0.15p inside). Output converted to straight alpha per [T2].

## Notes
- Endpoints (SDR float route): p = 0 gives exactly A (r = 0). p = 1 gives B: r = R exceeds every δ, f = 0, hard test δ ≤ R → m = 1; sB = 1 and oB = 1 within binary32 rounding.
