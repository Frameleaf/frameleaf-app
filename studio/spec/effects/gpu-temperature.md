# gpu-temperature

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
A simple additive white-balance shift. Temperature trades red against blue. Tint trades green against magenta (red + blue).

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| temperature | number | -1 .. 1 | 0 | — | + warmer (more R, less B) |
| tint | number | -1 .. 1 | 0 | — | + more magenta (less G, more R and B) |

Sanitised per [C9]. Absent keys mean 0.

## Per-pixel definition
In this order (float32):
```
c = S(uv)
r = c.r + temperature * 0.1
b = c.b - temperature * 0.1
g = c.g - tint * 0.1
r = r + tint * 0.05
b = b + tint * 0.05
out.rgb = R(r, g, b),  out.a = c.a
```
R: SDR `clamp01`; HDR clamp to [-65504, 65504].

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged.

## SDR and HDR
- SDR: offsets applied to encoded values, then clamped to [0, 1].
- HDR: the same offsets in linear reference-white units (0.1 = 20.3 cd/m²), signed, with only the binary16 range limit.

## Notes
Purely additive, so the shift is the same at every brightness. The same constants are reused inside gpu-color-wheels, gpu-secondary-qualifier and gpu-power-window, where the UI value is divided by 100 first.
