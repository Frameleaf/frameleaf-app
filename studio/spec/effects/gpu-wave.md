# gpu-wave

| | |
|---|---|
| Category | distort |
| Temporal | no (static; does not use the effect clock) |
| Pass | 1 fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
Displaces the sampling point with two sine waves: a vertical displacement that varies along x, then a horizontal displacement that varies along the already-displaced y.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amplitudeX | number | 0..0.1 (step 0.001, animatable) | 0.02 | uv (v units) | amplitude of the vertical displacement (driven by u) |
| amplitudeY | number | 0..0.1 (step 0.001, animatable) | 0.02 | uv (u units) | amplitude of the horizontal displacement (driven by v) |
| frequencyX | number | 1..20 (step 0.5, animatable) | 5 | cycles per frame width | frequency of the wave along u |
| frequencyY | number | 1..20 (step 0.5, animatable) | 5 | cycles per frame height | frequency of the wave along v |

Mapping (after [C9]; missing → default): values are used directly. TAU = 6.28318530718 (2π).

Note the naming (pinned): `amplitudeX`/`frequencyX` produce a VERTICAL displacement whose phase depends on the horizontal position; `amplitudeY`/`frequencyY` produce a HORIZONTAL displacement whose phase depends on the vertical position.

## Per-pixel definition
For output pixel (i, j) with uv = (u, v) from [C1]:

1. v1 = v + sin(u · frequencyX · TAU) · amplitudeX.
2. u1 = u + sin(v1 · frequencyY · TAU) · amplitudeY.   (uses the displaced v1, not v — order matters)
3. q = (u1, v1).
4. SDR: output S(q) [C2]. HDR: output HDR-OUT(PB(q)) [C4].

The phase is zero at u = 0 (resp. v1 = 0) with no time term; the pattern is constant over the clip.

## Edges
Displaced points near the borders can leave [0,1]² by up to the amplitude; they read the nearest edge texel [C2].

## Alpha
SDR: straight RGBA hardware bilinear sample. HDR: premultiplied bilinear tap, binary16 coverage, RGB = Σ(w·RGB·A)/Σ(w·A), zero coverage → (0,0,0,0).

## SDR and HDR
Same coordinates. SDR: hardware straight sampling of encoded values, no clamp. HDR: explicit premultiplied bilinear + HDR-OUT (±65504, headroom kept).


HDR helpers used above (the [C4] blur sampling and output, stated here so this file is self-contained):
- PB(q), premultiplied bilinear tap at uv q: x = q.u·W − 0.5, y = q.v·H − 0.5; x0 = floor(x), y0 = floor(y), fx = x − x0, fy = y − y0. For dx, dy ∈ {0, 1}: texel T = F(clamp(x0+dx, 0, W−1), clamp(y0+dy, 0, H−1)), weight ω = (dx ? fx : 1−fx)·(dy ? fy : 1−fy). PB(q) = Σ ω·(T.r·T.a, T.g·T.a, T.b·T.a, T.a).
- HDR-OUT(c) for an accumulated premultiplied (r, g, b, a): α = clamp(a, 0, 1); κ = α rounded to the nearest binary16 value, ties to even, with binary16 subnormals kept (multiples of 2⁻²⁴; anything ≤ 2⁻²⁵ becomes 0). If κ ≤ 0 output (0, 0, 0, 0); otherwise output (clamp(r/a, −65504, 65504), clamp(g/a, …), clamp(b/a, …), κ). The division uses the unrounded a.

## Notes
- Displacements are in uv units (amplitude 0.02 = 2 % of the frame height for the vertical wave, 2 % of the width for the horizontal one).
- sin arguments reach up to ≈ 20·2π·1.1 ≈ 138 rad, far outside [−π, π] where WGSL guarantees trig accuracy; GPU sin range reduction at such arguments varies, so sample positions (and pixels) depend on GPU transcendental precision.
