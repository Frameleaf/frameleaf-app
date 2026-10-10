# gpu-exposure

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
Multiplies by 2^EV, adds an offset, then applies a gamma power.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| exposure | number | -3 .. 3 | 0 | EV (stops) | gain 2^exposure |
| offset | number | -0.5 .. 0.5 | 0 | signal units | added after the gain |
| gamma | number | 0.2 .. 3 | 1 | — | output = x^(1/gamma) |

Sanitised per [C9]. Absent keys mean 0, 0 and 1 respectively. No conversion.

## Per-pixel definition
```
c = S(uv)
x = c.rgb * pow(2, exposure)
x = x + offset
SDR: x = pow(max(x, 0), 1 / gamma)
HDR: x = sign(x) * pow(|x|, 1 / gamma)
out.rgb = R(x),  out.a = c.a
```
R: SDR `clamp01`; HDR clamp to [-65504, 65504].

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged.

## SDR and HDR
- SDR: negatives become 0 before the power (unsigned gamma), then clamp to [0, 1].
- HDR: signed power (odd-symmetric around 0), so negative and above-white values survive; only the binary16 range limit applies.

## Notes
Numeric oracle: `studio/tools/photometric-goldens.mjs` (cases `exposure-lift-gamma`, `exposure-lower-gamma`; it also checks signed vs unsigned gamma). Uses GPU `pow`/`exp2`: allow ~0.2 % relative error (the oracle's tolerance).
