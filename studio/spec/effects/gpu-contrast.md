# gpu-contrast

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
Scales every channel's distance from a fixed pivot of 0.5.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0 .. 3 | 1 | gain | 1 = unchanged, 0 = flat 0.5 grey |

Sanitised per [C9]; an absent key means 1. No conversion.

## Per-pixel definition
```
c = S(uv)
x = (c.rgb - 0.5) * amount + 0.5      (per channel)
out.rgb = R(x),  out.a = c.a
```
R: SDR `clamp01`; HDR clamp to [-65504, 65504].

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged; RGB processed regardless of alpha.

## SDR and HDR
- SDR: pivot 0.5 in encoded values, result clamped to [0, 1].
- HDR: same equation in linear light (pivot 0.5 = 101.5 cd/m²), signed binary16 range limit only.

## Notes
Numeric oracle: `studio/tools/photometric-goldens.mjs` (cases `contrast-expand`, `contrast-contract`). No transcendental functions.
