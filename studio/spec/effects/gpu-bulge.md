# gpu-bulge

| | |
|---|---|
| Category | distort |
| Temporal | no |
| Pass | 1 fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
Radially remaps distances inside a circle around a centre with a power curve: amount > 1 magnifies the middle (bulge), amount < 1 shrinks it (pinch). Outside the circle the image is unchanged; the circle edge is continuous.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0.1..3 (step 0.1, animatable) | 0.5 | exponent | power applied to normalised distance |
| radius | number | 0.1..1 (step 0.01, animatable) | 0.5 | uv units | radius of the affected circle |
| centerX | number | 0..1 (step 0.01, animatable) | 0.5 | normalised u | centre, horizontal |
| centerY | number | 0..1 (step 0.01, animatable) | 0.5 | normalised v (down) | centre, vertical |

Mapping (after [C9]; missing → default): c = (centerX, centerY); r = radius; γ = amount. Note the default γ = 0.5 is a pinch (content shrinks toward the centre).

## Per-pixel definition
For output pixel (i, j) with uv from [C1]:

1. δ = uv − c; ρ = |δ| (Euclidean, uv units).
2. ρs = max(ρ, 0.0001).
3. n = ρs / r; ρ' = n^γ · r  (pow with positive base).
4. direction e = δ / ρs.
5. candidate q_b = c + e · ρ'.
6. If 0 < ρ < r (both strict): q = q_b; otherwise q = uv.
7. SDR: output S(q) [C2]. HDR: output HDR-OUT(PB(q)) [C4].

So the output at distance ρ < r shows the source at distance r·(ρ/r)^γ along the same direction. γ > 1: source distance < ρ (magnify); γ < 1: source distance > ρ (shrink); γ = 1: identity.

## Edges
The remapped point lies within distance r of c, which can extend outside the frame; such points read the nearest edge texel [C2].

## Alpha
SDR: straight RGBA hardware bilinear. HDR: premultiplied bilinear tap, binary16 coverage, RGB = Σ(w·RGB·A)/Σ(w·A), zero coverage → (0,0,0,0); HDR-OUT applies to all pixels including those outside the circle.

## SDR and HDR
Same coordinates. SDR: hardware straight sampling of encoded values, no clamp. HDR: explicit premultiplied bilinear + HDR-OUT.


HDR helpers used above (the [C4] blur sampling and output, stated here so this file is self-contained):
- PB(q), premultiplied bilinear tap at uv q: x = q.u·W − 0.5, y = q.v·H − 0.5; x0 = floor(x), y0 = floor(y), fx = x − x0, fy = y − y0. For dx, dy ∈ {0, 1}: texel T = F(clamp(x0+dx, 0, W−1), clamp(y0+dy, 0, H−1)), weight ω = (dx ? fx : 1−fx)·(dy ? fy : 1−fy). PB(q) = Σ ω·(T.r·T.a, T.g·T.a, T.b·T.a, T.a).
- HDR-OUT(c) for an accumulated premultiplied (r, g, b, a): α = clamp(a, 0, 1); κ = α rounded to the nearest binary16 value, ties to even, with binary16 subnormals kept (multiples of 2⁻²⁴; anything ≤ 2⁻²⁵ becomes 0). If κ ≤ 0 output (0, 0, 0, 0); otherwise output (clamp(r/a, −65504, 65504), clamp(g/a, …), clamp(b/a, …), κ). The division uses the unrounded a.

## Notes
- Implementation-defined (pinned) near the centre: for 0 < ρ < 0.0001 the direction e = δ/0.0001 is shorter than unit length, so q = c + δ·(0.0001/r)^γ·r/0.0001 rather than a true radial remap; effect is sub-pixel at practical sizes. At ρ = 0 exactly (possible only when the centre lands exactly on a pixel centre) the pixel samples uv itself.
- Circle and distances are in uv space, not aspect-corrected: on a non-square frame the region is an ellipse.
- pow is computed by the GPU (typically via exp2/log2); results depend on GPU transcendental precision, especially for γ far from 1 near the centre.
