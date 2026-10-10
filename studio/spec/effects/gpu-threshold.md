# gpu-threshold

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single full-frame pass, output size = input size |
| HDR | refused [C4] |

## What it does
Converts each pixel to pure black or pure white according to whether its BT.709 luma is above a level.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| level | number | 0 – 1 | 0.5 | encoded luma | pixels with luma strictly above this become white |

Sanitised per [C9]; used directly (binary32).

## Per-pixel definition
1. c = S(uv) = F(i, j) [C2].
2. L = LUMA709(c.rgb) [C7] = 0.2126·R + 0.7152·G + 0.0722·B (on encoded values).
3. v = 1 if L > level, else 0 (strict comparison: L = level gives 0).
4. RGB_out = (v, v, v); A_out = c.a.

## Edges
Only the pixel's own texel is read.

## Alpha
Alpha passes through. RGB at alpha = 0 is computed from the stored straight RGB (hidden colour), so a transparent pixel may carry white RGB.

## SDR and HDR
SDR: luma is computed on sRGB-encoded values [C3]; output is exactly 0 or 1. HDR: refused [C4].

## Notes
- level = 0: every pixel with any positive luma becomes white; pure black stays black.
- level = 1: only pixels with luma > 1 (possible only if an earlier effect produced out-of-range values, since passes are stored in binary16 [C3]) become white.
- Luma is a weighted sum in binary32; for pixels whose luma lies within rounding error of `level` the result may differ between implementations.
