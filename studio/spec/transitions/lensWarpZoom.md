# lensWarpZoom

| | |
|---|---|
| Category | custom |
| Directions | none |
| Duration (frames) | default 24, min 8, max 72 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A lens punch-through: the outgoing clip zooms in with barrel distortion and a zoom blur, the incoming clip arrives zoomed and pin-cushioned and settles to normal, with a red/blue split, a vignette and a thin cool light ring expanding from the zoom centre. The clips swap in the middle third.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| zoomStrength | number | 0 – 2.5 (step 0.05) | 1 | × | zoom amount |
| warpStrength | number | 0 – 2.5 (step 0.05) | 0.75 | × | barrel / pincushion distortion |
| blurStrength | number | 0 – 3 (step 0.05) | 1 | × | zoom-blur length |
| chroma | number | 0 – 2 (step 0.05) | 0.65 | × | red/blue split on the incoming clip |
| vignette | number | 0 – 2 (step 0.05) | 0.7 | × | edge darkening |
| glow | number | 0 – 3 (step 0.05) | 1 | × | light ring |

Sanitised per [T4]; absent → the defaults above.

**Hidden parameters (not in the catalogue):** centerX, centerY, default 0.5 each (zoom centre in uv); used if present as finite numbers. c = (centerX, centerY).

## Progress curve
p_c = clamp(p, 0, 1); env = sin(π p_c).
- punch = smoothstep(0, 0.46, p_c) · (1 − smoothstep(0.58, 1, p_c))
- reveal = smoothstep(0.36, 0.64, p_c)
- zA = 1 + zoomStrength · p_c · 0.42 + 0.18 · punch; zB = 1 + zoomStrength · (1 − p_c) · 0.58
- κ = warpStrength · env; β = blurStrength · env · 0.11

## Geometry
Helpers (a = max(W / max(H, 1), 0.001)):
- ZOOM(x, z) = c + (x − c) / max(z, 0.001)
- BARREL(x, k): d = ((x − c).x · a, (x − c).y); r² = d·d; d' = d · (1 + k r²); return (d'.x / a, d'.y) + c
- ZBLUR(X, x, σ): for i = 0 … 6, τ = i/6, w_i = 1 − |τ − 0.5| · 0.8, P_i = clamp(x + (c − x) · σ · (τ − 0.5), 0, 1); return Σ w_i S(X, P_i) / Σ w_i (four channels)

- qA = BARREL(ZOOM(uv, zA), κ); qB = BARREL(ZOOM(uv, zB), −0.65 κ)
- a = ZBLUR(A, qA, β); bb = ZBLUR(B, qB, 0.82 β)
- n = normalize(uv − c + (0.0001, 0.0001)); off = n · chroma · env · 0.012
- b = (S(B, clamp(qB + off, 0, 1)).r, bb.g, S(B, clamp(qB − off, 0, 1)).b, bb.α) — the red and blue channels of the incoming clip are single, unblurred samples; green and alpha are zoom-blurred.

## Blend
- δ = |uv − c| (uv units, not aspect-corrected)
- ring = exp(−((δ − 0.22 − 0.18 p_c) · 8)²) · glow · env
- vig = 1 − smoothstep(0.36, 0.9, δ) · vignette · env · 0.45
- light = (0.78, 0.9, 1.0) · ring · 0.18
- col = a · (1 − reveal) + b · reveal (four channels)
- RGB = min(col.rgb · vig + light, 1) per channel (SDR limit helper: upper bound only). α = col.α.

## Edges
Every sample position is clamped to the frame (inside ZBLUR and in the two chroma taps), i.e. edge-extend. Zoom factors are ≥ 1 for the catalogue range, but the barrel term (k > 0 for the outgoing clip) pushes corner positions outside the frame, which then read stretched edge texels.

## Alpha
Ring light is added to premultiplied RGB without changing α (discarded where α = 0, amplified where 0 < α < 1); vignette scales premultiplied RGB only. Output converted to straight alpha per [T2].

## Notes
- Endpoints (SDR float route): p = 0: zA = 1, κ = β = 0, reveal = 0, env = 0 → A. p = 1: reveal = 1, zB = 1, κ, β ≈ 0 (sin(π) residual) → B. Both endpoints are identity up to binary32 rounding.
- The ring uses a general power function with exponent 2 on (δ − 0.22 − 0.18 p_c) · 8, which is negative inside the ring; WGSL leaves pow undefined for a negative base. The intended and observed behaviour is plain squaring; implement as x² (implementation-defined in the reference).
- Hidden centerX/centerY are not range-limited; values far outside [0, 1] are implementation-defined.
