# gpu-twirl

| | |
|---|---|
| Category | distort |
| Temporal | no |
| Pass | 1 fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
Rotates the image inside a circle (in uv space) around a centre, by an angle that is largest at the centre and falls to zero at the circle's edge (quadratic falloff). Outside the circle the image is unchanged.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | −10..10 (step 0.1, animatable) | 1 | radians | twist angle at the centre |
| radius | number | 0.1..1 (step 0.01, animatable) | 0.5 | uv units | radius of the affected circle |
| centerX | number | 0..1 (step 0.01, animatable) | 0.5 | normalised u | centre, horizontal |
| centerY | number | 0..1 (step 0.01, animatable) | 0.5 | normalised v (down) | centre, vertical |

Mapping (after [C9]; missing → default): c = (centerX, centerY); r = radius; r_safe = max(r, 0.0001) (inactive after sanitising since r ≥ 0.1); θ0 = amount.

## Per-pixel definition
For output pixel (i, j) with uv from [C1]:

1. δ = uv − c; ρ = |δ| (Euclidean, uv units).
2. f = 1 − min(ρ / r_safe, 1).
3. θ = θ0 · f².
4. Rotated offset: δ' = (δx·cos θ − δy·sin θ, δx·sin θ + δy·cos θ).
5. Sample point: q = c + δ' if ρ < r (strict), otherwise q = uv.
6. SDR: output S(q) [C2]. HDR: output HDR-OUT(PB(q)) [C4].

Orientation: with v pointing down, step 4 turns the sampling offset clockwise on screen for θ > 0; the visible content therefore appears turned counter-clockwise for positive `amount`.

## Edges
Sample points can leave [0,1]² when the circle extends past the frame; they read the nearest edge texel [C2].

## Alpha
SDR: straight RGBA hardware bilinear sample. HDR: premultiplied bilinear tap; alpha rounded to binary16; RGB = Σ(w·RGB·A)/Σ(w·A); zero coverage → (0,0,0,0). Note that in HDR the HDR-OUT step applies to every pixel, including those outside the circle (which are otherwise unchanged).

## SDR and HDR
Same coordinates in both. SDR: hardware straight-RGBA sampling, encoded values, no clamp. HDR: explicit premultiplied bilinear, HDR-OUT (±65504 clamp, headroom kept).


HDR helpers used above (the [C4] blur sampling and output, stated here so this file is self-contained):
- PB(q), premultiplied bilinear tap at uv q: x = q.u·W − 0.5, y = q.v·H − 0.5; x0 = floor(x), y0 = floor(y), fx = x − x0, fy = y − y0. For dx, dy ∈ {0, 1}: texel T = F(clamp(x0+dx, 0, W−1), clamp(y0+dy, 0, H−1)), weight ω = (dx ? fx : 1−fx)·(dy ? fy : 1−fy). PB(q) = Σ ω·(T.r·T.a, T.g·T.a, T.b·T.a, T.a).
- HDR-OUT(c) for an accumulated premultiplied (r, g, b, a): α = clamp(a, 0, 1); κ = α rounded to the nearest binary16 value, ties to even, with binary16 subnormals kept (multiples of 2⁻²⁴; anything ≤ 2⁻²⁵ becomes 0). If κ ≤ 0 output (0, 0, 0, 0); otherwise output (clamp(r/a, −65504, 65504), clamp(g/a, …), clamp(b/a, …), κ). The division uses the unrounded a.

## Notes
- The circle and the rotation are in uv space, not aspect-corrected: on a non-square frame the affected region is an ellipse (r·W by r·H pixels) and the "rotation" is a rotation in normalised space, which on screen includes shear/stretch (implementation-defined, pinned).
- θ0 up to ±10 rad means sin/cos arguments well outside [−π, π]; WGSL trig accuracy there is GPU-defined, so sample positions near the centre can differ slightly across GPUs. Pixels depend on GPU transcendental precision.
- Identity outside the circle (SDR exact; HDR up to HDR-OUT).
