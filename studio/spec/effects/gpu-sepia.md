# gpu-sepia

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
Blends towards the classic sepia colour matrix.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0 .. 1 | 1 | fraction | 0 = unchanged, 1 = full sepia |

Sanitised per [C9]; absent means 1.

## Per-pixel definition
```
c = S(uv)
sR = 0.393·c.r + 0.769·c.g + 0.189·c.b
sG = 0.349·c.r + 0.686·c.g + 0.168·c.b
sB = 0.272·c.r + 0.534·c.g + 0.131·c.b
x  = c.rgb + ((sR, sG, sB) - c.rgb) * amount
out.rgb = R(x),  out.a = c.a
```
R: SDR `clamp01`; HDR clamp to [-65504, 65504].

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged.

## SDR and HDR
- SDR: clamped to [0, 1]. The clamp matters because the R and G rows sum to more than 1 (white → (1.351, 1.203, 0.937) before the clamp).
- HDR: the same matrix on linear values. The only limit is the binary16 range, so white becomes (1.351, 1.203, 0.937).

## Notes
Exact arithmetic.
