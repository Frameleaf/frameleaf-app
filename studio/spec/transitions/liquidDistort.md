# liquidDistort

| | |
|---|---|
| Category | custom |
| Directions | from-left, from-right, from-top, from-bottom [T3] |
| Duration (frames) | default 28, min 10, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A liquid wipe: a noisy, soft front advances from the named side; both clips are refracted by a flowing noise field and a gentle swirl, the incoming clip gets a red/blue refraction split, and a cool caustic shine glints along the front.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| intensity | number | 0 – 2.5 (step 0.05) | 1 | × | refraction strength and front raggedness |
| scale | number | 1 – 12 (step 0.1) | 4.5 | × | noise frequency |
| turbulence | number | 0 – 3 (step 0.05) | 1 | × | curl component of the flow |
| chroma | number | 0 – 2 (step 0.05) | 0.75 | × | red/blue split on the incoming clip |
| swirl | number | 0 – 2.5 (step 0.05) | 0.8 | × | rotation about the centre |
| shine | number | 0 – 3 (step 0.05) | 1 | × | caustic highlight |

Sanitised per [T4]; absent → the defaults above.

**Hidden parameter (not in the catalogue):** edgeSoftness, default 0.18 (uv units along the wipe axis); used if present as a finite number. ε = max(edgeSoftness, 0.001).

## Progress curve
p_c = clamp(p, 0, 1); env = sin(π p_c).

## Geometry
Axis coordinate s per direction [T3]: from-left u; from-right 1 − u; from-top v; from-bottom 1 − v.

Flow field (FBM, NOISE per [C6]):
- aspect a = max(W / max(H, 1), 0.001); P = (u · a, v) · max(scale, 0.001)
- slow = FBM(P + (1.8 p_c, −1.15 p_c)); fast = FBM(1.9 · P + (−2.7 p_c, 1.55 p_c))
- cx = NOISE(P + (2.5 slow, 3 p_c)) − 0.5; cy = NOISE(P + (−2 p_c, 2.5 fast)) − 0.5
- flow = (cx, cy) · turbulence + (slow − 0.5, fast − 0.5) · 0.45

Swirl: c = uv − 0.5; γ = swirl · env · 0.42; rot = (c.x cos γ − c.y sin γ, c.x sin γ + c.y cos γ); sw = (rot − c) · 0.32.

Offsets: β = intensity · env · 0.052; offA = (flow + sw) · β; offB = (−0.82 · flow + 0.55 · sw) · β.

Front: fN = FBM(uv · max(0.72 · scale, 0.001) + (2.2 p_c, −1.7 p_c)) (not aspect-corrected); front = s + (fN − 0.5) · 0.28 · intensity · env. reveal = smoothstep(p_c − ε, p_c + ε, front).

Samples:
- PA = clamp(uv + offA, 0, 1); PB = clamp(uv + offB, 0, 1); a = S(A, PA); b = S(B, PB)
- ch = flow · chroma · env · 0.018; b' = (S(B, clamp(PB + ch, 0, 1)).r, b.g, S(B, clamp(PB − ch, 0, 1)).b, b.α)

## Blend
- col = b' · (1 − reveal) + a · reveal (premultiplied, four channels) — outgoing ahead of the front, incoming behind
- caustic = (max(0, 1 − |front − p_c| / max(2.5 ε, 0.001)))²
- shim = FBM(uv · max(2.4 · scale, 0.001) + (5 p_c, −4 p_c))
- shineRGB = (0.72, 0.88, 1.0) · caustic · shim · shine · env · 0.22
- gm = smoothstep(0, 1, 0.65 · caustic + 0.2 · env)
- RGB = min(col.rgb + gm · shineRGB, 1) per channel (SDR limit helper: upper bound only). α = col.α.

## Edges
Refracted samples are clamped to the frame (edge-extend). The front, flow and shine are continuous; no hard edges.

## Alpha
Shine is added to premultiplied RGB without changing α; it is discarded where α = 0 and amplified by un-premultiplying where 0 < α < 1. The upper limit 1 is applied to premultiplied RGB. Output converted to straight alpha per [T2].

## Notes
- **Endpoints are not identity (SDR float route, observed):** with the default ε = 0.18, at p = 0 env = 0 (no refraction, no shine) but reveal = smoothstep(−0.18, 0.18, s) < 1 for s < 0.18, so the first 18 % along the axis already shows a mix of B (half B at s = 0). At p = 1, reveal = smoothstep(0.82, 1.18, s) > 0 for s > 0.82, so the far 18 % still shows some A (up to ≈ 0.5 at the far edge). The transition-semantics file flags this ("sdrEndpointOffset").
- Hidden edgeSoftness = 0 is floored to 0.001 (a nearly hard front).
- Pixel values depend on FBM/NOISE (HASH-based, [C6]); the field is smooth in its input, but each lattice value comes from HASH. Inside HASH the sine argument reaches 10⁵ to 10⁶ radians even for small inputs, because of HASH's own dot products, so these values depend entirely on how the sine is range-reduced. With the reduction of [C6] a clean-room implementation reproduces the canonical goldens; other GPUs differ.
