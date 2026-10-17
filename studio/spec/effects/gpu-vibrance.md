# gpu-vibrance

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
A saturation change weighted towards less-saturated pixels. Already-saturated colours change less.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | -1 .. 1 | 0 | — | + boosts, − mutes |

Sanitised per [C9]; absent means 0.

## Per-pixel definition
```
c = S(uv)
mx = max(c.r, c.g, c.b),  mn = min(c.r, c.g, c.b)
SDR: w = 1 - (mx - mn) / (mx + 0.001)
HDR: m = max(|c.r|, |c.g|, |c.b|, 0.000001)
     w = 1 - clamp01((mx - mn) / m)
k = 1 + amount * w
g = LUMA601(c.rgb)
x = g + (c.rgb - g) * k                     (= mix(g, c.rgb, k))
out.rgb = R(x),  out.a = c.a
```
R: SDR `clamp01`; HDR clamp to [-65504, 65504].

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged.

## SDR and HDR
- SDR: the saturation estimate uses a +0.001 denominator guard. It is not clamped, so for in-range input w is in (0, 1]. Black gives w = 1. The result is clamped to [0, 1].
- HDR: the saturation estimate uses the largest absolute channel (floor 1e-6) and is clamped to [0, 1]. That keeps it bounded for negative wide-gamut channels and for black. The result is signed, and the only limit is the binary16 range.

## Notes
Exact arithmetic (one division). The SDR and HDR weight formulas differ slightly even for in-range input (the 0.001 guard versus the absolute-max normaliser). Implement both as written.
