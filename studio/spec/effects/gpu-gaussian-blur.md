# gpu-gaussian-blur

| | |
|---|---|
| Category | blur |
| Temporal | no |
| Pass | 1 fragment pass (single 2-D gather; NOT separable) |
| HDR | linear-display-bt709-v1 |

## What it does
Blurs the frame with a square grid of (2n+1)² taps around each output pixel, weighted by a Gaussian of the tap's grid index. The grid spacing stretches with `radius`, so `samples` sets tap density, not reach.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| radius | number | 0..50 (step 1, animatable) | 10 | output pixels | reach of the outermost tap from the centre, per axis |
| samples | number | 1..64 (step 1, not animatable, quality) | 5 | taps | half-width n of the tap grid |

Mapping (after [C9]; a parameter missing from the instance takes its default):
- R = radius (not rounded; fractional values from keyframe interpolation are used as-is).
- n = trunc(clamp(samples, 1, 64)) (truncation toward zero).
- Grid step in pixels: g = R / n.
- σ = R / 3, in grid-index units (see Notes).
- W, H = output size in pixels.

## Per-pixel definition
For output pixel (i, j) with uv from [C1]:

1. If R < 0.5: output S(uv) [C2] unchanged (identity, both SDR and HDR, see below). Stop.
2. For every integer pair (x, y) with x in −n..n and y in −n..n (x is the outer loop, y the inner loop, both ascending):
   - tap position: p = uv + (x·g/W, y·g/H)  (i.e. offset x·g pixels horizontally, y·g pixels vertically);
   - weight: w(x, y) = exp(−(x² + y²) / (2σ²)) = GAUSS applied to the index distance with σ = R/3 [C7];
   - SDR: accumulate w·S(p) over all four channels (straight RGBA).
   - HDR: accumulate w·PB(p), the premultiplied bilinear tap of [C4].
3. Divide the accumulated 4-vector by Σw (sum over all (2n+1)² weights).
4. SDR: write the result directly. HDR: write HDR-OUT of the result [C4] (straight alpha recovered, binary16 coverage rounding, zero RGB at zero coverage, RGB clamped to ±65504).

## Edges
Taps outside the frame use clamp-to-edge [C2] (SDR hardware sampler; HDR: each of the four bilinear texel indices is clamped to [0, W−1] × [0, H−1]). The edge row/column is therefore repeated; there is no renormalisation for out-of-frame taps.

## Alpha
SDR: alpha is blurred with the same weights as RGB, and RGB is averaged in straight (non-premultiplied) form, so colour of fully transparent texels bleeds into the result (pinned upstream behaviour).
HDR: accumulation is premultiplied; output alpha is the weighted mean alpha rounded to binary16; RGB is (Σ w·RGB·A)/(Σ w·A); where the rounded coverage is 0 the output is (0,0,0,0).

## SDR and HDR
- SDR: sRGB-encoded values [C3]; hardware bilinear filtering of straight RGBA; no range clamp is applied by the effect.
- HDR: linear values [C4]; taps are computed by explicit premultiplied bilinear interpolation; output through HDR-OUT. Kernel, tap positions and parameters are identical to SDR.
- The R < 0.5 identity path returns S(uv) at the texel centre in both modes; in HDR it does not go through HDR-OUT (RGB under zero alpha is not cleared there).


HDR helpers used above (the [C4] blur sampling and output, stated here so this file is self-contained):
- PB(q), premultiplied bilinear tap at uv q: x = q.u·W − 0.5, y = q.v·H − 0.5; x0 = floor(x), y0 = floor(y), fx = x − x0, fy = y − y0. For dx, dy ∈ {0, 1}: texel T = F(clamp(x0+dx, 0, W−1), clamp(y0+dy, 0, H−1)), weight ω = (dx ? fx : 1−fx)·(dy ? fy : 1−fy). PB(q) = Σ ω·(T.r·T.a, T.g·T.a, T.b·T.a, T.a).
- HDR-OUT(c) for an accumulated premultiplied (r, g, b, a): α = clamp(a, 0, 1); κ = α rounded to the nearest binary16 value, ties to even, with binary16 subnormals kept (multiples of 2⁻²⁴; anything ≤ 2⁻²⁵ becomes 0). If κ ≤ 0 output (0, 0, 0, 0); otherwise output (clamp(r/a, −65504, 65504), clamp(g/a, …), clamp(b/a, …), κ). The division uses the unrounded a.

## Notes
- Implementation-defined (pinned): the Gaussian is evaluated on the integer grid index, not on the pixel distance. The effective σ in pixels is σ_px = (R/3)·(R/n) = R²/(3n); the kernel is truncated to the square |x| ≤ n, |y| ≤ n, i.e. at n/σ = 3n/R standard deviations along each axis. Example, defaults R=10, n=5: taps every 2 px out to ±10 px, σ_px ≈ 6.67 px, truncated at 1.5σ. With n > R the step g is below one pixel.
- Tap count is (2n+1)² (up to 16 641 at n=64); no separable decomposition is used and none is equivalent, because the kernel is truncated to a square.
- SDR taps at fractional pixel offsets rely on hardware bilinear filtering whose sub-texel weight precision is GPU-defined (commonly 8 fractional bits); not exactly specifiable. HDR taps use full float weights.
- exp() precision is GPU-defined; weights differ in the last bits across GPUs.
- Accumulation is in 32-bit float in the loop order given; the result is stored to binary16 (or 8-bit on the legacy route) [C3].
