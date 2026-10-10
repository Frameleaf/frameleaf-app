# blurDissolve

| | |
|---|---|
| Category | dissolve |
| Directions | none |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A cosine cross dissolve in which both clips are softened by a small 5-tap blur whose radius peaks at the midpoint.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| strength | number | 0 – 24 (step 0.5) | 9 | px | blur tap distance at the midpoint |

Sanitised per [T4]; absent → 9. Mapping: tap offset in uv ρ = (strength · e / W, strength · e / H), i.e. strength · e output pixels in each axis.

## Progress curve
p_c = clamp(p, 0, 1). e = sin(π · p_c) (blur envelope). t = 0.5 − 0.5 · cos(π · p_c) (mix weight).

## Geometry
Soft sample SOFT(X, uv, ρ) (X is A or B):
- c0 = S(X, uv)
- c1 = S(X, clamp(uv + (ρx, 0), 0, 1)), c2 = S(X, clamp(uv − (ρx, 0), 0, 1))
- c3 = S(X, clamp(uv + (0, ρy), 0, 1)), c4 = S(X, clamp(uv − (0, ρy), 0, 1))
- SOFT = 0.36 · c0 + 0.16 · (c1 + c2 + c3 + c4) (weights sum to 1; all four premultiplied channels)

(clamp is component-wise to [0, 1] before sampling.)

## Blend
Output = SOFT(A) · (1 − t) + SOFT(B) · t on all four premultiplied channels. No clamp.

## Edges
Taps beyond the frame are clamped to the frame edge, so edge texels are counted more than once (edge-extend).

## Alpha
Blurred in premultiplied space, so transparent regions do not bleed colour. Output converted to straight alpha per [T2].

## Notes
- The blur is a plus-shaped 5-tap kernel, not a Gaussian; at large strength it shows four ghost copies (this is the engine's look).
- Endpoints (SDR float route): p = 0 gives A (ρ = 0, all taps coincide; result equals a up to binary32 rounding of 0.36 + 4 × 0.16). p = 1 gives B within sin/cos precision (ρ ≈ strength · 8.7·10⁻⁸ px).
