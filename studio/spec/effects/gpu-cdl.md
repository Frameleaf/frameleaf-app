# gpu-cdl

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | refused |

## What it does
The ASC Color Decision List (FL-1559): slope, offset and power per channel, then saturation, the exchange grade that other editors and colour pipelines write into projects and CDL files.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| slopeR, slopeG, slopeB | number | 0 .. 4 | 1 | gain | multiplies the channel |
| offsetR, offsetG, offsetB | number | −1 .. 1 | 0 | signal | added after the slope |
| powerR, powerG, powerB | number | 0.1 .. 4 | 1 | exponent | applied after slope and offset |
| saturation | number | 0 .. 4 | 1 | gain | about Rec. 709 luma |

Sanitised per [C9]. Absent keys mean their defaults.

## Per-pixel definition
```
c = S(uv)
v = pow(max(c.rgb * slope + offset, 0), power)                 (per channel)
L = 0.2126 v.r + 0.7152 v.g + 0.0722 v.b
x = L + saturation * (v - L)                                    (per channel)
out.rgb = clamp01(x),  out.a = c.a
```
slope, offset and power are the three-component vectors of the per-channel parameters.

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged.

## SDR and HDR
- SDR: as above. Negative values before the power become 0, as the ASC CDL specification requires; the only other clamp is the final one to [0, 1].
- HDR: refused [C4]. A native client must refuse it too.

## Notes
- The defaults are the identity (within GPU `pow` precision at power 1).
- ASC CDL values from a `.cdl`, `.cc` or `.ccc` file or an EDL comment map one to one onto the ten parameters.
