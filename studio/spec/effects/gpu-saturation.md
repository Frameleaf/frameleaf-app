# gpu-saturation

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
Moves every pixel towards (amount < 1) or away from (amount > 1) its Rec.601-weighted grey.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0 .. 3 | 1 | gain | 0 = grey, 1 = unchanged |

Sanitised per [C9]; absent means 1.

## Per-pixel definition
```
c = S(uv)
g = LUMA601(c.rgb)
x = g + (c.rgb - g) * amount          (= mix(g, c.rgb, amount))
out.rgb = R(x),  out.a = c.a
```
R: SDR `clamp01`; HDR clamp to [-65504, 65504].

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged.

## SDR and HDR
- SDR: on encoded R'G'B', then clamped to [0, 1].
- HDR: the same 0.299/0.587/0.114 weights are applied to linear BT.709 values (an artistic grey, not physical luminance); binary16 range limit only.

## Notes
Numeric oracle: `studio/tools/photometric-goldens.mjs` (linear cases `saturation-expand`, `saturation-contract`). The weights are Rec.601 (LUMA601), not LUMA709. This is the observed behaviour.
