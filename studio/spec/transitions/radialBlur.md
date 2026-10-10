# radialBlur

| | |
|---|---|
| Category | custom |
| Directions | none |
| Duration (frames) | default 25, min 10, max 60 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
Both clips get a combined zoom-and-spin blur about the frame centre that peaks at the midpoint, while they cross-fade; a light vignette darkens the corners during the peak.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| blurStrength | number | 0 – 3 (step 0.05) | 1 | × | length of the zoom/spin streaks |
| spin | number | −1.5 – 1.5 (step 0.05) | 0.3 | × | rotational component (sign = direction) |

Sanitised per [T4]; absent → 1 and 0.3.

**Hidden parameter (not in the catalogue):** samples, default 12. The shader reads it if present as a finite number (undeclared properties are kept per [T4]); N = conversion of samples to an unsigned integer (truncation toward zero; negative values become 0).

## Progress curve
p is used as received (**not clamped**). env = sin(π p).
- σ = env · blurStrength · 0.15 (zoom/spin length)
- ω = env · spin · 0.3 (spin angle range, radians)
- t = smoothstep(0.3, 0.7, p) (cross-fade)

## Geometry
Blur of clip X at uv, with d = uv − (0.5, 0.5) (uv units, not aspect-corrected):
for i = 0 … N − 1:
- τ = i / (N − 1) − 0.5 ∈ [−0.5, 0.5]
- zoom = d · τ · σ
- spinOff = (R(d, τ ω) − d) · σ, where R(d, γ) = (d.x cos γ − d.y sin γ, d.x sin γ + d.y cos γ)
- P_i = clamp(uv + zoom + spinOff, 0, 1)
- w_i = exp(−4 τ²)

BLUR(X) = Σ w_i · S(X, P_i) / Σ w_i (all four premultiplied channels).

Note the spin offset is additionally scaled by σ (it is R(d, τω) − d multiplied by the same strength), so spin has no effect when blurStrength = 0.

## Blend
- col = BLUR(A) · (1 − t) + BLUR(B) · t
- vig = 1 − |uv − 0.5|² · env · 0.5 (|·|² = squared length in uv)
- RGB = col.rgb · vig, α = col.α. No clamp.

## Edges
Samples are clamped to the frame (edge-extend). In uv space the blur and vignette are elliptical on non-square frames.

## Alpha
Blur and cross-fade on premultiplied values. The vignette darkens premultiplied RGB only, so on semi-transparent pixels it darkens the straight colour by the same factor. Output converted to straight alpha per [T2].

## Notes
- Endpoints (SDR float route): p = 0: σ = 0, all samples at uv, result A (weighted average of identical samples; binary32 rounding only). p = 1: σ ≈ −1.3·10⁻⁸ · blurStrength (binary32 sin(π) residual), t = 1, vig ≈ 1, result B.
- Hidden samples edge cases: N = 1 divides 0 by 0 for τ (NaN), N = 0 divides 0 by 0 for the average (NaN) — implementation-defined, avoid. Very large N runs a very long loop.
- p outside [0, 1]: env becomes negative, reversing the zoom/spin and turning the vignette into a brightening; not clamped.
