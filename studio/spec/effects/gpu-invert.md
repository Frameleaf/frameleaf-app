# gpu-invert

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
Replaces each channel with 1 − value.

## Parameters
None.

## Per-pixel definition
```
c = S(uv)
SDR: out.rgb = 1 - c.rgb                       (no clamp)
HDR: out.rgb = clamp(1 - c.rgb, -65504, 65504)
out.a = c.a
```

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged. RGB is inverted even where alpha = 0.

## SDR and HDR
- SDR: there is no explicit clamp. Inputs in [0, 1] stay in [0, 1]. If an earlier unclamped effect left a value outside [0, 1], the result is outside too. It is then stored per [C3]: kept on the binary16 route, clamped on the 8-bit route.
- HDR: the same affine map in linear light. 1.0 (reference white, 203 cd/m²) maps to 0. Values above white become negative and are kept. The only limit is ±65504.

## Notes
Exact arithmetic; no tolerance concerns.
