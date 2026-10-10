# fade

| | |
|---|---|
| Category | basic |
| Directions | none |
| Duration (frames) | default 30, min 5, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
Equal-power cross-fade (cos² / sin² weights that sum to 1) combined with a 4 % scale drift: the outgoing clip shrinks from 100 % to 96 % while the incoming clip settles from 104 % to 100 %. Where the shrinking outgoing clip no longer covers the frame its contribution is zero (transparent), not edge-stretched.

## Parameters
None. The shader receives only p (and W, H, which it does not use). Any stored property is ignored.

## Progress curve
p_c = clamp(p, 0, 1).
- c = cos(p_c · π / 2)
- wA = c², wB = 1 − c²
- sA = 1 − 0.04 · p_c (outgoing scale), sB = 1.04 − 0.04 · p_c (incoming scale)

## Geometry
Scaling is about the frame centre (0.5, 0.5) in uv:
- uvA = (uv − 0.5) / sA + 0.5
- uvB = (uv − 0.5) / sB + 0.5

Because sA ≤ 1 the outgoing image appears smaller (zoom-out); because sB ≥ 1 the incoming image appears larger (zoom-in) and is always fully in frame.

Coverage masks (1 inside the unit square including its boundary, else 0):
- mA = 1 if 0 ≤ uvA.x ≤ 1 and 0 ≤ uvA.y ≤ 1, else 0; mB likewise for uvB.

Samples: a = S(A, clamp(uvA, 0, 1)), b = S(B, clamp(uvB, 0, 1)) (component-wise clamp to [0, 1] before sampling).

## Blend
With wA' = wA · mA and wB' = wB · mB (premultiplied colour):
- RGB = a.rgb · wA' + b.rgb · wB'
- α = clamp(a.α · wA' + b.α · wB', 0, 1)

No clamp is applied to RGB (the SDR clamp helpers are not called).

## Edges
Outside the shrunk outgoing image (a border that grows to 2 % of each dimension per side at p = 1) only the incoming term remains, so the result there is b weighted by wB alone and is partially transparent where wB < 1.

## Alpha
Premultiplied weighted sum, alpha clamped to [0, 1]; output converted to straight alpha per [T2].

## Notes
- Endpoints (SDR float route, nothing forced): p = 0 gives exactly A (c = 1, sA = 1). p = 1 gives B up to the GPU's cos(π/2) residual (c² ≈ 2·10⁻¹⁵ in binary32; WGSL permits larger absolute error for cos, up to 2⁻¹¹, i.e. c² ≤ 2.4·10⁻⁷).
- Because wA + wB = 1 but the masks differ, the total alpha in the uncovered border is wB (< 1 before the end): the frame edge momentarily becomes semi-transparent. This is the engine's behaviour (implementation-defined, observed).
- The engine comment says this mirrors its Canvas2D fallback; the GPU formula above is the contract.
