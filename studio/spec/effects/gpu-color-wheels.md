# gpu-color-wheels

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | refused |

## What it does
A primary colour-correction stage in one pass:
- tone-zoned hue tints (shadows, midtones, highlights, global offset);
- temperature and tint;
- exposure, contrast around a pivot, and midtone "detail";
- lift, gain, offset and gamma;
- black and white points;
- shadow and highlight lifts;
- saturation and colour boost;
- hue rotation and luminance mix.

## Parameters
| name | type | range | default | unit | internal value |
|---|---|---|---|---|---|
| shadowsHue | number | 0 .. 360 | 0 | degrees | hS = shadowsHue/360 |
| shadowsAmount | number | 0 .. 1 | 0 | fraction | aS |
| midtonesHue | number | 0 .. 360 | 0 | degrees | hM = midtonesHue/360 |
| midtonesAmount | number | 0 .. 1 | 0 | fraction | aM |
| highlightsHue | number | 0 .. 360 | 0 | degrees | hH = highlightsHue/360 |
| highlightsAmount | number | 0 .. 1 | 0 | fraction | aH |
| offsetHue | number | 0 .. 360 | 0 | degrees | hO = offsetHue/360 |
| offsetAmount | number | 0 .. 1 | 0 | fraction | aO |
| temperature | number | -100 .. 100 | 0 | percent | T = temperature/100 |
| tint | number | -100 .. 100 | 0 | percent | Ti = tint/100 |
| saturation | number | -100 .. 100 | 0 | percent | sat = 1 + saturation/100 |
| exposure | number | -3 .. 3 | 0 | EV | gainE = 2^exposure |
| contrast | number | 0 .. 2 | 1 | gain | as is |
| pivot | number | 0 .. 1 | 0.5 | signal | as is |
| lift | number | -2 .. 2 | 0 | signal | as is |
| gamma | number | 0 .. 4 | 1 | — | exponent 1/max(gamma, 0.05) |
| gain | number | 0 .. 16 | 1 | gain | as is |
| offset | number | -2 .. 2 | 0 | signal | as is |
| blackPoint | number | 0 .. 0.5 | 0 | signal | as is |
| whitePoint | number | 0.5 .. 1.5 | 1 | signal | as is |
| midDetail | number | -100 .. 100 | 0 | percent | md = midDetail/100 |
| colorBoost | number | -100 .. 100 | 0 | percent | cb = colorBoost/100 |
| shadows | number | -100 .. 100 | 0 | percent | sh = shadows/100 |
| highlights | number | -100 .. 100 | 0 | percent | hl = highlights/100 |
| hue | number | 0 .. 100 | 50 | percent, 50 = none | dh = (hue − 50)/100 turns |
| lumMix | number | 0 .. 100 | 100 | percent | lm = clamp01(lumMix/100) |

Sanitised per [C9]. Any key that is absent or not a number takes the default above.

## Per-pixel definition
All steps run in float32 in this order. `c` is a running RGB triple.
```
c0 = S(uv),  c = c0.rgb
Y  = LUMA601(c)                               (from the input, used for all masks below)
mS = 1 - smoothstep(0, 0.5, Y)                (shadow mask)
mH = smoothstep(0.5, 1, Y)                    (highlight mask)
mM = 1 - mS - mH                              (midtone mask)

TINT(c, h, a, m):  if a < 0.001: return c
                   k = HSV→RGB(h, 1, 1)                 [C7]
                   return mix(c, c * mix(1, k, a), m)   (per channel)
c = TINT(c, hS, aS, mS)
c = TINT(c, hM, aM, mM)
c = TINT(c, hH, aH, mH)
c = TINT(c, hO, aO, 1)

c.r += T*0.1,  c.b -= T*0.1
c.g -= Ti*0.1, c.r += Ti*0.05, c.b += Ti*0.05

c = c * 2^exposure
c = (c - pivot) * contrast + pivot

if |midDetail| > 0.001:
    d = LUMA601(c)
    c = mix(c, d + (c - d) * (1 + md), mM)

c = (c + lift + offset) * gain
c = pow(max(c, 0), 1 / max(gamma, 0.05))                (SDR form, per channel)
c = (c - blackPoint) / max(whitePoint - blackPoint, 0.001)
c = c + sh * mS
c = c + hl * mH

g = LUMA601(c),  c = mix(g, c, sat)

if |cb| > 0.001:
    g = LUMA601(c),  q = c - g
    c = g + q * (1 + cb * (1 - clamp01(|q|)))           (|q| = Euclidean length of the 3-vector q)

if |hue - 50| > 0.001:
    (h, s, v) = RGB→HSV(c),  c = HSV→RGB(fract(h + dh), s, v)

g = LUMA601(c),  c = mix(g, c, lm)

out.rgb = clamp01(c),  out.a = c0.a
```

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged; RGB processed regardless of alpha.

## SDR and HDR
- SDR: there is no clamping between steps. The gamma step zeroes negatives (`max(c, 0)`). The only final clamp is to [0, 1].
- HDR: refused [C4]. The extended-range variant (a signed gamma power and a range limit of ±65504) never runs.

## Notes
These are observed behaviours, all implementation-defined:
- `lift` and `offset` are mathematically identical: both are added before `gain`.
- The tone masks come from the *input* luma and are not recomputed after the earlier stages.
- "Mid/Detail" is a midtone-weighted saturation scale, not a spatial detail filter. No neighbours are read.
- `lumMix` blends towards grey: 100 means unchanged and 0 means fully grey (LUMA601).
- A hue of 360 equals 0.
- The catalogue allows gamma = 0, but the internal floor of 0.05 makes everything below 0.05 behave like 0.05 (an exponent of 20).

Between steps, values can leave [0, 1] (for example with gain 16). The RGB→HSV/HSV→RGB round trip in the hue step is then evaluated on out-of-range values exactly as the [C7] formulas give.

Precision: `pow` (gamma step) and `exp2` (exposure) are GPU transcendentals. At extreme gamma (an exponent of up to 20, or as low as 0.25) small input differences are strongly amplified. Pixel goldens need a loose tolerance at the extremes (suggest ≥ 2/255) and the normal 1/255 near the defaults.
