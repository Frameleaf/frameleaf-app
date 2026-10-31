# sparkles

| | |
|---|---|
| Category | custom |
| Directions | none |
| Duration (frames) | default 24, min 8, max 72 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A noise-threshold dissolve driven by two layers of procedurally placed, twinkling four/eight-point star sparkles. Each sparkle ignites at its own moment, drifts and orbits, leaves a trail and dust, and locally pushes the dissolve ahead; warm glow is added along the dissolve front, and the whole result is passed through a soft highlight compression.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| sparkleScale | number | 0.25 – 3 (step 0.05) | 1 | × | sparkle size; also widens the dissolve edge |
| intensity | number | 0 – 2.5 (step 0.05) | 1 | × | sparkle flash, edge glow, sparkle push |
| density | number | 0.2 – 3 (step 0.05) | 1 | × | sparkle grid density and noise frequency |
| glow | number | 0 – 3 (step 0.05) | 1 | × | glow veil, edge glow, glow push |

Sanitised per [T4]; each absent → 1. Abbreviations below: k = sparkleScale, I = intensity, d = density, G = glow.

## Progress curve
p is used as received (**not clamped**). env = sin(π p).
- dissolveCurve = smoothstep(0.03, 0.97, p)
- window = smoothstep(0.02, 0.28, p) · (1 − smoothstep(0.8, 1, p))

## Geometry
Aspect-scaled coordinates q = (u · W / max(H, 1), v). Rotation R(x, γ) = (x.x cos γ − x.y sin γ, x.x sin γ + x.y cos γ).

Star shape SHAPE(l, s), with |l| the vector length and l_x, l_y components:
- core = smoothstep(0.34 s, 0, |l|)
- hor = smoothstep(0.14 s, 0, |l_y|) · smoothstep(s, 0, |l_x|)
- ver = smoothstep(0.14 s, 0, |l_x|) · smoothstep(s, 0, |l_y|)
- dA = smoothstep(0.22 s, 0, |l_x − l_y|) · smoothstep(0.9 s, 0, |l|); dB = smoothstep(0.22 s, 0, |l_x + l_y|) · smoothstep(0.9 s, 0, |l|)
- SHAPE = max(core, hor, ver, 0.7 · max(dA, dB))

(All these smoothsteps have reversed edges — high edge 0 — and are evaluated by the smoothstep formula, giving 1 at 0 falling to 0 at the first edge.)

Sparkle layer LAYER(D, s0, sv, m, θ, φ) → (main, reveal, glow, seed), evaluated per pixel:
1. c = q · D; cell = floor(c); l = fract(c) − (0.5, 0.5).
2. seed = HASH(cell + (1.37 φ, 2.11 φ)); cs = (HASH(cell + (φ + 1.7, φ + 6.2)), HASH(cell + (φ + 8.4, φ + 3.1))) − (0.5, 0.5); ss = HASH(cell + (φ + 2.4, φ + 9.7)); os = HASH(cell + (φ + 4.6, φ + 11.2)).
3. ig = clamp(0.04 + 0.72 seed + 0.16 · NOISE(0.17 · cell + (0.31 φ, 0.67 φ)), 0.04, 0.94); dur = 0.14 + 0.18 ss; ip = clamp((p − ig) / dur, 0, 1).
4. pulse = smoothstep(0, 0.16, ip) · (1 − smoothstep(0.3, 0.95, ip)); after = smoothstep(0.06, 0.72, ip).
5. α0 = seed · 2π; dir = (cos α0, sin α0); me = pulse · (0.6 + 0.4 sin(π p)).
6. drift = dir · m · (0.42 + 1.45 ss) · me; orbit = R((0, 1), α0 + ip · (1.5 + 2.6 os) · π) · m · 0.62 · (0.28 + os) · me.
7. ctr = 0.72 cs + drift + orbit; rot = seed · 2π + ip · (1.2 + 3.1 ss) · π; size = s0 + ss · sv.
8. tw = 0.35 + 0.65 · (sin(2π · (ip · (2.8 + 4.5 ss) + seed)) + 1) · 0.5; act = smoothstep(θ, 1, seed).
9. main = SHAPE(R(l − ctr, rot), size) · act · tw · pulse.
10. tc = ctr − dir · m · (0.6 + ss) · (0.25 + 0.95 pulse); tl = R(l − tc, rot − 0.4); trail = SHAPE((1.7 tl_x, 0.58 tl_y), 0.72 size) · act · tw · pulse · (0.42 + 0.28 ss).
11. dn = NOISE(0.85 · cell + (4.2 ip + φ, 0.37 φ)); dust = smoothstep(0.62, 1, dn) · after · act · (0.16 + 0.34 ss).
12. reveal = clamp(0.72 main + 0.34 trail + 0.24 · after · act + 0.12 dust, 0, 1); glow = max(main, 0.88 trail) · (0.65 + 0.75 ss) + 0.3 dust.

Two layers:
- coarse = LAYER(5.5 + 5 d, 0.15 k, 0.28 k, 0.18, 0.58, 3.7)
- micro = LAYER(10 + 9 d, 0.06 k, 0.14 k, 0.09, 0.7, 11.4)

Combination:
- hero = 1 if coarse.glow ≥ micro.glow else 0; heroSeed = hero ? coarse.seed : micro.seed
- core = max(coarse.main, 0.78 micro.main); field = max(coarse.reveal, 0.86 micro.reveal); gF = max(coarse.glow, 0.74 micro.glow)
- macro = FBM(q · (2.6 + 0.9 d) + (0, 0.7 p))
- dN = NOISE(q · (13 + 7 d) + (5.2 p + 3.1 heroSeed, 7.4 heroSeed))
- dustF = smoothstep(0.58, 1, dN) · (0.12 + 0.88 field) · env
- thr = clamp(0.58 macro + 0.14 dN + 0.18 (1 − field) + 0.08 (1 − gF), 0, 1)
- dp = clamp(1.08 · dissolveCurve − 0.04 + field · (0.28 + 0.12 I) · window + gF · (0.1 + 0.08 G) + 0.12 dustF, 0, 1)
- edge = 0.075 + 0.018 k
- λA = 1 − smoothstep(thr − edge, thr + edge, dp); λB = 1 − λA

## Blend
a = S(A, uv), b = S(B, uv) (no displacement).
- col = b · (1 − λA) + a · λA (all four premultiplied channels)
- dEdge = clamp(4 λA λB, 0, 1)
- edgeGlow = dEdge · gF · I · G · (0.5 + 0.4 env)
- flash = core · (0.38 + 0.52 I) · (0.62 + 0.38 env)
- gc = (1, 0.97, 0.88) · (1 − heroSeed) + (1, 0.82, 0.56) · heroSeed
- veil = gc · gF · G · (0.06 + 0.12 λB)
- lift = b.rgb · (gF · λB · 0.05 · G)
- L = col.rgb + veil + lift + 0.95 · gc · edgeGlow + 0.72 · gc · flash
- K = 1 − exp(−L · (1 + 0.45 edgeGlow)) (per channel)
- RGB = clamp(0.54 · L + 0.46 · K, 0, 1) (SDR clamp helper); α = col.α

## Edges
No geometric displacement of the clips. Cells are anchored at the top-left of the aspect-scaled plane, so the sparkle grid is square in pixels and its phase depends on W/H.

## Alpha
Glows are added to premultiplied RGB without changing α, so on semi-transparent pixels the straight colour is boosted more, and on fully transparent pixels (α = 0) all glow is discarded by [T2]. RGB is clamped to [0, 1], not to α.

## Notes
- **Endpoints are not identity (SDR float route, observed):** at p = 0 every sparkle is dormant (ip = 0), dp = 0 and λA = 1, so col = A, but the highlight compression still applies: RGB = clamp(0.54 · a + 0.46 · (1 − exp(−a)), 0, 1) (a mid-grey 0.5 becomes ≈ 0.451). At p = 1, dp = 1 but λA > 0 wherever thr > 1 − edge, and late-igniting sparkles (ig up to 0.94) can still be alive, so the result is a compressed B with possible residual A, glow and sparkles. The transition-semantics file flags this as "sdrEndpointOffset".
- p outside [0, 1] is not clamped; sparkle timing and the sine envelopes extrapolate.
- **Strong GPU-precision dependence:** sparkle placement, timing, size and orientation all come from HASH of cell indices (up to ≈ 10 + 27 = 37 cells per unit height at d = 3, plus phase offsets up to ≈ 24) and NOISE/FBM; not bit-reproducible across GPUs. Structure, constants and envelopes are exact.
