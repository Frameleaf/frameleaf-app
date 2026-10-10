# smoothCut

| | |
|---|---|
| Category | dissolve |
| Directions | none |
| Duration (frames) | default 18, min 6, max 45 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A short "morph-cut" style dissolve for hiding jump cuts: both clips are warped in opposite directions by a smooth noise field (mostly horizontal, banded), slightly softened and nudged sideways, while a cross-fade centred on the midpoint swaps them. The warp fades out near the frame borders and vanishes at both ends.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| strength | number | 0 – 2 (step 0.05) | 0.9 | — | warp, drift, softening and cross-fade width |

Sanitised per [T4]; absent → 0.9. Inside the shader σ = clamp(strength, 0, 2).

## Progress curve
p_c = clamp(p, 0, 1); e = sin(π · p_c).
- warpMix = smoothstep(0.12, 0.85, e)
- blend width w = 0.18 + 0.18 · σ (linear mix of 0.18 and 0.36 by σ)
- t = smoothstep(0.5 − w, 0.5 + w, p_c)

## Geometry
Warp field Wp(uv) (FBM, NOISE per [C6]; TAU = 2π):
- L = FBM((2.4 u, 1.8 v) + (1.15 p_c, −0.8 p_c))
- M = FBM((6.2 u, 4.8 v) + (−1.65 p_c, 1.25 p_c))
- h = 0.62 · sin(2π · (4.6 u + 1.8 L + 1.25 p_c)) + 0.28 · sin(2π · (8.2 u + 0.22 v + 1.1 M − 0.9 p_c)) + 0.48 · (L − 0.5) + 0.22 · (M − 0.5)
- vw = 0.14 · (M − 0.5)
- edge fade F = smoothstep(0.03, 0.18, u) · smoothstep(0.97, 0.82, u) · smoothstep(0.03, 0.18, v) · smoothstep(0.97, 0.82, v) (the second and fourth factors have reversed edges, i.e. they fall from 1 to 0 as the coordinate goes from 0.82 to 0.97; smoothstep is evaluated by its formula with low > high)
- Wp = (h, vw) · e · σ · 0.052 · F

Drift D = ((p_c − 0.5) · 0.018 · e · σ, 0). Soft radius ρ = (1/W, 1/H) · e · σ · 2.4 (i.e. 2.4·e·σ pixels).

SOFT(X, q, ρ): with c0 = S(X, q), c1,2 = S(X, clamp(q ± (ρx, 0), 0, 1)), c3,4 = S(X, clamp(q ± (0, ρy), 0, 1)): SOFT = 0.36 · c0 + 0.16 · (c1 + c2 + c3 + c4).

- aW = SOFT(A, clamp(uv + Wp − D, 0, 1), ρ)
- bW = SOFT(B, clamp(uv − Wp + D, 0, 1), ρ)
- aC = S(A, uv), bC = S(B, uv)
- a = aC · (1 − warpMix) + aW · warpMix; b = bC · (1 − warpMix) + bW · warpMix

## Blend
Output = a · (1 − t) + b · t on all four premultiplied channels. No clamp.

## Edges
Warped positions are clamped to the frame (edge-extend); the edge fade F brings the warp to zero within 3 % of each border, so the outermost 3 % is unwarped (only drift and softening apply there).

## Alpha
All operations are linear on premultiplied values; output converted to straight alpha per [T2].

## Notes
- Endpoints (SDR float route): e = 0 at p = 0 and 1, so warp, drift and softening are zero and warpMix = 0. For σ ≤ 16/9 (w ≤ 0.5) t is exactly 0 at p = 0 and 1 at p = 1, giving A and B. For σ > 16/9 the cross-fade window extends beyond [0, 1] and the endpoints are not pure: at σ = 2 (w = 0.54), t(0) = smoothstep(−0.04, 1.04, 0) ≈ 0.0040 and t(1) ≈ 0.9960 (implementation-defined, observed).
- Pixel values depend on FBM/NOISE (HASH-based); the warp is smooth, but each lattice value comes from HASH. Inside HASH the sine argument reaches 10⁵ to 10⁶ radians even for small inputs, because of HASH's own dot products, so these values depend entirely on how the sine is range-reduced. With the reduction of [C6] a clean-room implementation reproduces the canonical goldens; other GPUs differ.
