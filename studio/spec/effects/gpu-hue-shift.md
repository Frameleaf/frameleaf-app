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
Evaluation order inside the fract: `(shift + flow·t) + h·span`. **This definition is normative, and it is binary32**: t is the clock of [C8] already rounded to binary32; flow·t and h·span are each rounded to binary32, and so is each of the two sums, before the fraction is taken.

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
- Implementation-defined: because flow·t is rounded to binary32 before its fraction is taken, the hue offset is a multiple of the product's unit in the last place: 2⁻²⁴·2^⌈log₂(flow·t)⌉ turns. At flow·t = 100 that is 8 × 10⁻⁶ turn, which changes a channel by at most 5 × 10⁻⁵; at flow·t = 7200 (an hour at flow 2) it is 5 × 10⁻⁴ turn, a channel step of 0.003, still under the `pixel` floor of 2/255. So a native client that computes the fraction of flow·t in higher precision stays within the goldens' tolerance for every item shorter than about two hours at the largest flow, but it does not compute what the engine computes. An earlier version of this note recommended the higher precision; the definition above is the contract, and a native client follows it.
- If the host provides no timeline frame (e.g. a panel thumbnail), the engine falls back to wall-clock time. Export always provides [C8].
- No transcendental functions.
