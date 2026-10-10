# gpu-sharpen

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single full-frame pass, output size = input size (W × H) |
| HDR | refused [C4] |

## What it does
Unsharp mask: subtracts a Gaussian-weighted 7 × 7 blur from the pixel and adds the difference back, scaled by `amount`.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0 – 5 | 1 | gain | how much of the high-pass detail is added back |
| radius | number | 0.5 – 5 | 1 | pixels per tap | spacing between the blur taps, and (via σ) the tap weighting |

Sanitised per [C9]. Derived quantities (binary32):
- Pixel size (Δu, Δv) = (1/W, 1/H) [C1].
- σ = 0.5 · radius + 0.5.
- Tap grid: integer offsets x, y each in −3 … 3 inclusive (49 taps).

## Per-pixel definition
1. c = S(uv) = F(i, j).
2. For every tap (x, y), x outer loop −3 … 3, y inner loop −3 … 3:
   - position p = uv + (x · Δu · radius, y · Δv · radius);
   - weight w = exp(−(x² + y²) / (2σ²)) — note the distance is the integer tap index, not the scaled pixel distance;
   - B += w · S(p) (all four channels, straight alpha, no premultiplication); Wsum += w.
3. B = B / Wsum.
4. RGB_out = clamp(c.rgb + (c.rgb − B.rgb) · amount, 0, 1).
5. A_out = c.a.

When radius is not an integer the taps fall between texels and are bilinearly filtered [C2].

## Edges
Taps that leave the frame read clamp-to-edge [C2], so the edge row/column is effectively repeated.

## Alpha
Output alpha is the centre pixel's alpha. The blur averages straight RGB without weighting by alpha, so hidden RGB under transparent neighbours (alpha = 0) contributes to the blur and can create halos at matte edges. RGB at alpha = 0 is computed by the same formula.

## SDR and HDR
SDR: operates on sRGB-encoded values [C3] and clamps to [0, 1]. HDR: refused [C4].

## Notes
- The 49-tap sum order (x outer, y inner) is given for completeness; differences from a different summation order are within binary32 rounding.
- `amount` = 0 returns the input RGB (clamped to [0, 1]).
- The weights are separable (exp(−x²/2σ²)·exp(−y²/2σ²)), but the taps use bilinear filtering of the 2-D input; a two-pass separable implementation is only equivalent within rounding if its intermediate is kept in at least binary32 and both passes use the same tap positions.
