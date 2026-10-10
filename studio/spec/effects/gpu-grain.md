# gpu-grain

| | |
|---|---|
| Category | stylize |
| Temporal | yes |
| Pass | single full-frame pass, output size = input size (W × H) |
| HDR | refused [C4] |

## What it does
Adds signed monochrome noise to every pixel, weaker on bright pixels. The noise pattern changes continuously with time.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0 – 0.5 | 0.1 | encoded value | peak noise amplitude on black |
| size | number | 0.5 – 5 | 1 | — | grain scale; larger = coarser lattice of the noise seed (see Notes) |
| speed | number | 0 – 5 | 1 | × | rate at which the pattern changes; 0 freezes it |

Sanitised per [C9] (speed is not animatable). Clock: t from [C8], converted to binary32 before use. Derived (binary32):
- g = t · speed.
- g_w = g − 600 · floor(g / 600) (floored modulo; the time seed repeats every 600 "speed-seconds").
- Grain coordinate scale s = 100 / size.

## Per-pixel definition
Local hash (not [C6] HASH — there is no pre-transform):
GRAINHASH(q) = fract(sin(q.x · 12.9898 + q.y · 78.233) · 43758.5453).

1. c = S(uv) = F(i, j).
2. q = uv · s + (g_w · 0.1, g_w · 0.07).
3. n = GRAINHASH(q) · 2 − 1 (in [−1, 1)).
4. L = LUMA709(c.rgb) [C7].
5. k = amount · (1 − 0.5 · L).
6. RGB_out = clamp(c.rgb + (n·k, n·k, n·k), 0, 1).
7. A_out = c.a.

How t enters: continuously (no step quantisation). Every distinct frame time gives a new pattern unless speed = 0. With speed = 0, g_w = 0 and the pattern is static.

## Edges
Only the pixel's own texel is read.

## Alpha
Alpha passes through. RGB at alpha = 0 receives noise like any other pixel (hidden RGB becomes non-zero noise).

## SDR and HDR
SDR: noise added to sRGB-encoded values and clamped to [0, 1] [C3]. HDR: refused [C4].

## Notes
- **Required precision and what is pinned.** Everything is binary32, one rounding per operation, except the sum q.x·12.9898 + q.y·78.233, which is a dot product as [C6] defines it (the second product fused into the sum). The sine is reduced as [C6] says: turns = argument × R in binary32, fraction only. The argument reaches several thousand radians (≈ 18 000 for size 0.5 at the bottom-right, plus up to ≈ 4 000 from the time term), where one unit in its last place is about 10⁻³ radian; multiplied by 43758.5453 that is a change of about 40 before the fraction is taken. So the noise value of a pixel depends on the last bit of its interpolated uv, which no page fixes, and on which sine follows the reduction. **No sine precision reproduces the canonical pixels**: with the canonical sine of [C6] and every rounding above, a reference still differs from the canonical render in a quarter to a third of the colour channels; with an accurate sine it differs in about four fifths of them. What is pinned, and what the `statistical` goldens check, is the distribution: n uniform in [−1, 1), uncorrelated between neighbouring pixels and between frames, amplitude k, the clamp, and alpha untouched. A native client may use any sine accurate to 10⁻³ after the reduction.
- "size" does not produce visible clumps: the hash is evaluated at every pixel's continuous uv, so neighbouring pixels are uncorrelated at every size; size only changes the seed spacing. Grain is therefore always one-pixel grain whose pattern depends on resolution.
- Brightness weighting uses encoded luma: at white (L = 1) amplitude is half of that at black.
