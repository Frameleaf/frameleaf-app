# gpu-lift-gamma-gain

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | refused |

## What it does
Lift, gamma and gain for each channel separately (FL-1559), the primary grade of colour-wheel panels in other editors: lift moves the blacks while keeping white, gain scales the whole signal, and gamma bends the midtones.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| liftR, liftG, liftB | number | −1 .. 1 | 0 | signal | raises (or lowers) black, keeping white |
| gammaR, gammaG, gammaB | number | 0.1 .. 4 | 1 | — | midtone power 1/gamma |
| gainR, gainG, gainB | number | 0 .. 4 | 1 | gain | multiplies the lifted signal |

Sanitised per [C9]. Absent keys mean their defaults.

## Per-pixel definition
```
c = S(uv)
y = gain * (c.rgb + lift * (1 - c.rgb))                         (per channel)
x = pow(max(y, 0), 1 / gamma)                                   (per channel)
out.rgb = clamp01(x),  out.a = c.a
```
lift, gamma and gain are the three-component vectors of the per-channel parameters.

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged.

## SDR and HDR
- SDR: as above; negative values before the power become 0 and the result is clamped to [0, 1].
- HDR: refused [C4]. A native client must refuse it too.

## Notes
The defaults are the identity (within GPU `pow` precision at gamma 1). The colour wheels' single lift, gamma and gain (gpu-color-wheels) act on all channels at once with a different formula; this effect is the per-channel form other editors export.
