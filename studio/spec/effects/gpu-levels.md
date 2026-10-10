# gpu-levels

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | refused |

## What it does
Classic levels: remap the input black/white range to 0..1, apply gamma, then remap to the output black/white range.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| inputBlack | number | 0 .. 1 | 0 | signal | input value mapped to 0 |
| inputWhite | number | 0 .. 1 | 1 | signal | input value mapped to 1 |
| gamma | number | 0.1 .. 3 | 1 | — | midtone power 1/gamma |
| outputBlack | number | 0 .. 1 | 0 | signal | output for normalised 0 |
| outputWhite | number | 0 .. 1 | 1 | signal | output for normalised 1 |

Sanitised per [C9]. Absent keys mean 0, 1, 1, 0 and 1. inputBlack > inputWhite and outputBlack > outputWhite are allowed and invert the mapping.

## Per-pixel definition
```
c = S(uv)
span = inputWhite - inputBlack
if |span| < 1e-4:  span = (span >= 0) ? 1e-4 : -1e-4        (collapsed range = hard threshold)
n = clamp01((c.rgb - inputBlack) / span)                      (per channel)
n = pow(max(n, 0), 1 / gamma)
x = outputBlack + (outputWhite - outputBlack) * n             (= mix(outputBlack, outputWhite, n))
out.rgb = clamp01(x),  out.a = c.a
```

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged.

## SDR and HDR
- SDR: as above. Both clamps are to [0, 1].
- HDR: refused [C4]. The shader has an extended-range variant (signed range limit instead of the inner clamp, plus a signed power), but it can never run because the engine refuses this effect in HDR. A native client must refuse it too.

## Notes
Numeric oracle: `studio/tools/photometric-goldens.mjs` (cases `levels-linear`, `levels-gamma`; `photometricSdrExpected` is the SDR form). Uses GPU `pow`. At gamma 0.1 the exponent is 10, so expect a larger absolute error near n = 1.
