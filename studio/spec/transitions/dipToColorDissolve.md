# dipToColorDissolve

| | |
|---|---|
| Category | dissolve |
| Directions | none |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
Dissolves the outgoing clip into a solid colour over the first half, then from that colour into the incoming clip over the second half (dip to black by default).

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| color | colour, rgb array | 3 finite numbers, nominal 0 – 1 each | [0, 0, 0] | encoded RGB (same encoding as the clip pixels, sRGB-encoded in SDR) | the midpoint colour |

Sanitised per [T4]: not an array of ≥ 3 finite numbers → [0, 0, 0]. Only the first three entries are used; extra entries are ignored. Components are **not** clamped to [0, 1] on the GPU route (out-of-range components are used as given). Mapping: C = (r, g, b, 1) treated as an opaque premultiplied colour.

## Progress curve
p_c = clamp(p, 0, 1).
- k1 = smoothstep(0, 0.5, p_c), k2 = smoothstep(0.5, 1, p_c)

## Geometry
None: a = S(A, uv), b = S(B, uv).

## Blend
- If p_c < 0.5: Output = a · (1 − k1) + C · k1
- Else: Output = C · (1 − k2) + b · k2

All four premultiplied channels; no clamp.

## Edges
None.

## Alpha
C is opaque, so the result becomes fully opaque at the midpoint even over transparent clips (α = a.α · (1 − k1) + k1 in the first half). Output converted to straight alpha per [T2].

## Notes
- At p_c = 0.5 exactly, the second branch is taken with k2 = 0, giving exactly C. Both halves are continuous there.
- Endpoints (SDR float route): p = 0 gives exactly A; p = 1 gives exactly B.
- Colour components outside [0, 1] (allowed by the sanitiser) produce out-of-range RGB on the float route; behaviour beyond [0, 1] is implementation-defined.
