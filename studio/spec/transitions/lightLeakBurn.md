# lightLeakBurn

| | |
|---|---|
| Category | custom |
| Directions | from-left, from-right, from-top, from-bottom [T3] |
| Duration (frames) | default 26, min 8, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A film light-leak / burn wipe: a ragged soft front advances from the named side, surrounded by a warm halo and a white-hot core that over-expose the image (soft exponential roll-off) with a little grain. Neither clip moves.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| intensity | number | 0 – 3 (step 0.05) | 1.25 | × | warm halo brightness |
| spread | number | 0.2 – 3 (step 0.05) | 1 | × | raggedness of the front |
| warmth | number | 0 – 2 (step 0.05) | 0.75 | × | halo hue (0 = pale gold, 1 = deep orange; > 1 extrapolates) |
| burn | number | 0 – 3 (step 0.05) | 1.1 | × | white-hot core strength and extra exposure |
| grain | number | 0 – 2 (step 0.05) | 0.5 | × | grain amount |

Sanitised per [T4]; absent → the defaults above.

**Hidden parameter (not in the catalogue):** edgeSoftness, default 0.16 (uv units along the axis); used if present as a finite number. Call it ε.

## Progress curve
p_c = clamp(p, 0, 1); env = sin(π p_c).

## Geometry
Axis s per direction [T3]: from-left u; from-right 1 − u; from-top v; from-bottom 1 − v.
- org = FBM((4 u, 3 v) + (2.7 p_c, −1.9 p_c)) ([C6])
- fine = NOISE((u · W, v · H) · 0.45 + (431 p_c, 431 p_c))
- s' = s + (org − 0.5) · spread · 0.28
- reveal = smoothstep(p_c − ε, p_c + ε, s')

a = S(A, uv), b = S(B, uv) (no displacement).

## Blend
- base = b · (1 − reveal) + a · reveal (four premultiplied channels; outgoing ahead of the front)
- fd = |s' − p_c|
- core = exp(−fd² / max(0.0001, 0.38 ε²)); halo = exp(−fd² / max(0.0001, 3.5 ε²))
- warm = (1, 0.88, 0.58) · (1 − warmth) + (1, 0.48, 0.16) · warmth
- hot = (1, 0.96, 0.86)
- g = (fine − 0.5) · grain · env · 0.08 (scalar, added to all channels)
- light = warm · halo · intensity · env · 1.15 + hot · core · burn · env · 1.35
- over = 1 − exp(−(base.rgb + light + g) · (1 + core · burn)) (per channel)
- m = clamp((halo + core) · env, 0, 1)
- RGB = clamp(base.rgb · (1 − m) + over · m, 0, 1) (SDR clamp helper); α = base.α

## Edges
No geometric edges; the front is soft (width 2ε) and ragged by org. Grain is value noise at about 0.45 cycles per pixel (cell size ≈ 2.2 px), evaluated at pixel centres.

## Alpha
All light is added to premultiplied RGB with α unchanged (base.α): it is discarded where α = 0 and amplified by un-premultiplying where 0 < α < 1. RGB clamped to [0, 1], not to α. Output converted to straight alpha per [T2].

## Notes
- **Endpoints are not identity (SDR float route, observed):** env = 0 at both ends, so m = 0 and RGB = clamp(base.rgb, 0, 1), but base itself is a blend: at p = 0, reveal = smoothstep(−ε, ε, s') with s' ragged by ±0.14 · spread, so pixels with s' < ε near the entering edge already show B (fully B where s' ≤ −ε). At p = 1, reveal = smoothstep(1 − ε, 1 + ε, s') > 0 where s' > 1 − ε, so some A remains near the far edge. The transition-semantics file flags this ("sdrEndpointOffset").
- Hidden edgeSoftness = 0 makes the reveal smoothstep degenerate (low = high): division by zero, implementation-defined; core/halo use the 0.0001 floor.
- warmth > 1 extrapolates the halo colour (blue component goes negative at warmth > 0.58/0.42 ≈ 1.381); kept as observed.
- Pixel values depend on FBM/NOISE ([C6]); the fine-grain NOISE argument reaches ≈ 0.45 · max(W, H) + 431 (≈ 2 100 at 3840 px), so grain is strongly GPU-precision dependent, and so is the reveal front shaped by FBM. Inside HASH the sine argument reaches 10⁵ to 10⁶ radians even for small inputs, because of HASH's own dot products, so these values depend entirely on how the sine is range-reduced. With the reduction of [C6] a clean-room implementation reproduces the canonical goldens; other GPUs differ, which is why these cases are `statistical`.
