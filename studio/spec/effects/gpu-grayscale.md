# gpu-grayscale

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
Blends each pixel towards its Rec.601-weighted grey.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0 .. 1 | 1 | fraction | 0 = unchanged, 1 = fully grey |

Sanitised per [C9]; absent means 1.

## Per-pixel definition
```
c = S(uv)
g = LUMA601(c.rgb)
x = c.rgb + (g - c.rgb) * amount        (= mix(c.rgb, g, amount))
SDR: out.rgb = x                         (no clamp)
HDR: out.rgb = clamp(x, -65504, 65504)
out.a = c.a
```

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged.

## SDR and HDR
- SDR: there is no explicit clamp. With in-range input and amount in [0, 1] the result stays in [0, 1]. It is stored per [C3].
- HDR: the same weights on linear BT.709 (an artistic grey, not physical luminance). The only limit is the binary16 range.

## Notes
The weights are LUMA601, not LUMA709 (observed behaviour). Exact arithmetic.
