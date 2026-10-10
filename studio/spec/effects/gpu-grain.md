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
- **Not bit-reproducible across GPUs.** The sine argument q.x·12.9898 + q.y·78.233 reaches several thousand radians (≈ 18 000 for size 0.5 at the bottom-right, plus up to ≈ 4 000 from the time term). Binary32 sin at such arguments has implementation-specific error that is amplified by ×43758.5453 and fract, so per-pixel noise values differ between GPUs/drivers. A native implementation should reproduce the formula in binary32; only statistical properties (roughly uniform n in [−1, 1), uncorrelated between neighbouring pixels) are guaranteed to match.
- "size" does not produce visible clumps: the hash is evaluated at every pixel's continuous uv, so neighbouring pixels are uncorrelated at every size; size only changes the seed spacing. Grain is therefore always one-pixel grain whose pattern depends on resolution.
- Brightness weighting uses encoded luma: at white (L = 1) amplitude is half of that at black.
