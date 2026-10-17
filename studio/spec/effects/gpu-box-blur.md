# gpu-box-blur

| | |
|---|---|
| Category | blur |
| Temporal | no |
| Pass | 1 fragment pass (single 2-D gather; NOT separable) |
| HDR | linear-display-bt709-v1 |

## What it does
Replaces each pixel with the unweighted mean of the (2n+1)×(2n+1) block of texels centred on it.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| radius | number | 0..20 (step 1, animatable) | 5 | output pixels | half-width of the square box |

Mapping (after [C9]; a missing parameter takes its default):
- R = radius.
- n = trunc(R) (truncation toward zero; fractional radii from keyframe interpolation step down to the integer below).

## Per-pixel definition
For output pixel (i, j) with uv from [C1]:

1. If R < 0.5: output S(uv) [C2] unchanged (identity). Stop.
2. For every integer pair (x, y), x in −n..n (outer loop), y in −n..n (inner loop):
   - tap position p = uv + (x/W, y/H), i.e. exactly the centre of texel (i+x, j+y);
   - SDR: accumulate S(p); HDR: accumulate PB(p) [C4].
3. Divide by the tap count (2n+1)².
4. SDR: write the result. HDR: write HDR-OUT of the result [C4].

Because every tap lands on a texel centre, S(p) is the exact fetch F(clamp(i+x), clamp(j+y)) (up to interpolation precision of uv, see Notes), and the result is a plain box mean.

Special case: 0.5 ≤ R < 1 gives n = 0, a single tap at the pixel itself. SDR: identity. HDR: the single tap still passes through PB and HDR-OUT, so the only changes are binary16 coverage rounding (no-op for values already stored in binary16) and RGB forced to 0 where alpha is 0.

## Edges
Clamp-to-edge [C2]: out-of-frame taps read the nearest edge texel; the divisor stays (2n+1)² (edge texels are weighted repeatedly).

## Alpha
SDR: straight RGBA averaged component-wise (transparent texels' RGB is included in the mean).
HDR: premultiplied mean; output alpha = mean alpha rounded to binary16; RGB = Σ(RGB·A)/ΣA; zero coverage gives (0,0,0,0).

## SDR and HDR
Same taps and weights in both. SDR averages sRGB-encoded straight values with no clamp; HDR averages linear premultiplied light and applies HDR-OUT (±65504 RGB clamp, no upper clamp at 1.0). The R < 0.5 identity path bypasses HDR-OUT.


HDR helpers used above (the [C4] blur sampling and output, stated here so this file is self-contained):
- PB(q), premultiplied bilinear tap at uv q: x = q.u·W − 0.5, y = q.v·H − 0.5; x0 = floor(x), y0 = floor(y), fx = x − x0, fy = y − y0. For dx, dy ∈ {0, 1}: texel T = F(clamp(x0+dx, 0, W−1), clamp(y0+dy, 0, H−1)), weight ω = (dx ? fx : 1−fx)·(dy ? fy : 1−fy). PB(q) = Σ ω·(T.r·T.a, T.g·T.a, T.b·T.a, T.a).
- HDR-OUT(c) for an accumulated premultiplied (r, g, b, a): α = clamp(a, 0, 1); κ = α rounded to the nearest binary16 value, ties to even, with binary16 subnormals kept (multiples of 2⁻²⁴; anything ≤ 2⁻²⁵ becomes 0). If κ ≤ 0 output (0, 0, 0, 0); otherwise output (clamp(r/a, −65504, 65504), clamp(g/a, …), clamp(b/a, …), κ). The division uses the unrounded a.

## Notes
- Tap count up to 41² = 1681.
- Taps are at texel centres, so hardware filter precision does not matter in SDR provided the interpolated uv lands on the centre; a GPU's barycentric uv interpolation can be off by a few ulp, which at worst mixes a vanishing fraction of a neighbour. Treat the result as the exact box mean.
- The step from n to n+1 happens at integer radius values; there is no sub-pixel blending between box sizes.
