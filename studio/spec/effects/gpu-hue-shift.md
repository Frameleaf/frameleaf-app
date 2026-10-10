# gpu-hue-shift

| | |
|---|---|
| Category | color |
| Temporal | yes (only when flow > 0) |
| Pass | single fragment pass |
| HDR | refused |

## What it does
Rotates, compresses or expands hue in HSV space. It can also cycle the hue over time.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| shift | number | 0 .. 1 | 0 | turns (1 = 360°) | constant hue offset |
| span | number | 0 .. 2 | 1 | — | hue scale. 1 = plain rotation, 0 = every pixel gets hue `shift` (a monochrome tint), 2 = hue range doubled (wraps) |
| flow | number | 0 .. 2 | 0 | turns per second | hue drift over time (not animatable) |

Sanitised per [C9]. Absent keys mean 0, 1 and 0. The clock t comes from [C8] (seconds, item-relative).

## Per-pixel definition
```
c = S(uv)
(h, s, v) = RGB→HSV(c.rgb)                       [C7], h in turns
h' = fract(shift + flow * t + h * span)
out.rgb = HSV→RGB(h', s, v)
out.a   = c.a
```
Evaluation order inside the fract: `(shift + flow·t) + h·span`.

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged; RGB processed regardless of alpha.

## SDR and HDR
- SDR: no explicit clamp. For inputs in [0, 1] the HSV round trip stays in [0, 1]. Storage follows [C3]: the binary16 route keeps whatever comes out, the 8-bit route clamps on store.
- HDR: refused [C4].

## Notes
- Grey pixels (s = 0) are unaffected by any hue change. The [C7] RGB→HSV of an achromatic input gives h = 0, so it simply stays grey.
- When flow = 0 the result does not depend on t.
- Implementation-defined: `flow·t` is computed in float32. For very long items (t in the thousands of seconds) the fractional part loses precision, so hue steps become visible. A native port should compute `fract(flow·t)` in double precision and then add it. That gives identical results for normal durations.
- If the host provides no timeline frame (e.g. a panel thumbnail), the engine falls back to wall-clock time. Export always provides [C8].
- No transcendental functions.
