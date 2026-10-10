# gpu-scanlines

| | |
|---|---|
| Category | stylize |
| Temporal | yes |
| Pass | single full-frame pass, output size = input size |
| HDR | refused [C4] |

## What it does
Multiplies the picture by a horizontal sinusoidal line pattern; the pattern can scroll vertically over time.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| density | number | 1 – 20 | 5 | — | line frequency; ≈ 15.9 · density dark lines per frame height |
| opacity | number | 0 – 1 | 0.3 | fraction | darkness of the dark phase of each line |
| speed | number | 0 – 5 | 0 | — | scroll speed (frame heights per 10 s); 0 = static |

Sanitised per [C9] (speed not animatable). Clock: t from [C8], as binary32. Derived:
- o = t · speed · 0.1 (scroll offset in normalised frame heights; continuous, no quantisation, no wrapping).
- ω = density · 100 (radians per frame height).

## Per-pixel definition
1. c = S(uv) = F(i, j).
2. s = sin((v + o) · ω) · 0.5 + 0.5, with v = uv.y [C1].
3. m = 1 − opacity · (1 − s).
4. RGB_out = c.rgb · m; A_out = c.a.

No clamp; 1 − opacity ≤ m ≤ 1.

The line period is 2π / ω in v, i.e. H · 2π / (density · 100) pixels. Because o is added to v, the pattern moves **upward** (towards smaller v) as t increases, at speed · 0.1 frame heights per second.

## Edges
Only the pixel's own texel is read.

## Alpha
Alpha unchanged. RGB at alpha = 0 is multiplied like any other pixel.

## SDR and HDR
SDR: multiplicative on sRGB-encoded values [C3], unclamped (cannot raise values). HDR: refused [C4].

## Notes
- **Required precision.** o, ω and (v + o)·ω are binary32, one rounding per operation, and the sine is reduced as [C6] says (turns = argument × R in binary32, fraction only). The sine is used at face value, so an error δ in it changes m by at most opacity·δ/2: the canonical sine's error of 1.9 × 10⁻⁴ and any sine accurate to 10⁻³ are far inside the `pixel` floor, and both pass every golden. Unlike the HASH effects, these cases are `pixel` cases.
- **Long-clip precision (implementation-defined):** o is not wrapped. With speed > 0 the sine argument grows as t · speed · density · 10; at t = 1 h, speed = 5, density = 20 it is ≈ 3.6 million radians, where binary32 resolution of the argument is ≈ 0.25 rad and GPU sin error is implementation-specific. Line phase therefore becomes imprecise on long clips; the visible pattern stays a line pattern but its exact phase is not reproducible. With speed = 0 (default) the argument is at most ω ≈ 2000 rad and the result is stable.
- Line count does not depend on resolution; line thickness in pixels does.
