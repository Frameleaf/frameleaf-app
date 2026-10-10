# gpu-brightness

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
Adds a constant to every colour channel.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | -1 .. 1 | 0 | signal units | value added to R, G and B |

Sanitised per [C9]. If the key is absent the value 0 is used. No further conversion.

## Per-pixel definition
```
c = S(uv)                       (same-size pass, so c = F(i, j))
x = c.rgb + amount              (per channel)
out.rgb = R(x)
out.a   = c.a
```
R is the range limit: SDR `clamp01`; HDR clamp each channel to [-65504, 65504].

## Edges
No neighbourhood access; clamp-to-edge [C2] is irrelevant.

## Alpha
Passed through unchanged. RGB is processed the same way where alpha = 0 (straight alpha, [C5]).

## SDR and HDR
- SDR [C3]: `out.rgb = clamp01(c.rgb + amount)` on encoded values.
- HDR [C4]: `out.rgb = clamp(c.rgb + amount, -65504, 65504)` on linear values (1.0 = 203 cd/m²); negatives and values above 1 are kept.

## Notes
Numeric oracle: `studio/tools/photometric-goldens.mjs` (cases `brightness-lift`, `brightness-lower`; tolerance per channel max(0.004, 0.002·|v|)). No transcendental functions.
