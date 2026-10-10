# filmGateSlip

| | |
|---|---|
| Category | custom |
| Directions | none |
| Duration (frames) | default 22, min 8, max 72 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A projector gate slip: the outgoing frame slips downward and the incoming frame arrives slipped downward and settles back, with frame-stepped jitter, lateral shake and a slight roll (shear), a red/blue fringe, exposure flicker, coarse grain, a vignette and bright flashes at the top and bottom gate edges. The clips cross-fade quickly around the midpoint.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| slip | number | 0 – 3 (step 0.05) | 1 | × | vertical slip distance |
| shake | number | 0 – 3 (step 0.05) | 1 | × | random vertical and lateral jitter |
| exposure | number | 0 – 2 (step 0.05) | 0.85 | × | flicker amount |
| gateWidth | number | 0 – 0.2 (step 0.005) | 0.075 | fraction of height | height of the gate-edge flashes |
| grain | number | 0 – 2 (step 0.05) | 0.6 | × | grain amount |
| chroma | number | 0 – 2 (step 0.05) | 0.55 | × | red/blue horizontal fringe |
| roll | number | 0 – 2 (step 0.05) | 0.75 | × | shear wobble |

Sanitised per [T4]; absent → the defaults above.

## Progress curve
p_c = clamp(p, 0, 1); env = sin(π p_c).
- frame index f = floor(18 p_c) (random values are held for 1/18 of the transition)
- jA = HASH((f, 19.7)); jB = HASH((f + 3, 41.3)); jF = HASH((f, 8.1)) ([C6])
- pulse = smoothstep(0.08, 0.22, p_c) · (1 − smoothstep(0.78, 0.96, p_c))
- mix weight t = smoothstep(0.42, 0.58, p_c)

## Geometry
- slipY = (p_c − 0.5) · slip · env · 0.32 + (jA − 0.5) · shake · env · 0.05
- lat = (jB − 0.5) · shake · env · 0.025
- rl = roll · env · 0.04 · sin(4π p_c)
- uvA = (u + lat + rl · (v − 0.5), v + slipY)
- uvB = (u − 0.65 · lat − rl · (v − 0.5), v − 0.55 · slipY)
- fringe o = (chroma · env · 0.006, 0)

FILM(X, q, o): q0 = clamp(q, 0, 1); return (S(X, clamp(q0 + o, 0, 1)).r, S(X, q0).g, S(X, clamp(q0 − o, 0, 1)).b, S(X, q0).α).

a = FILM(A, uvA, o); b = FILM(B, uvB, 0.7 · o).

## Blend
- col = a · (1 − t) + b · t (four premultiplied channels)
- top = smoothstep(gateWidth, 0, v) (reversed edges: 1 at v = 0 falling to 0 at v = gateWidth); bottom = smoothstep(1 − gateWidth, 1, v)
- flash = max(top, bottom) · pulse · 0.2
- flicker = 1 + (jF − 0.42) · exposure · env · 0.38
- gr = (HASH(floor((u · W, v · H) · 0.7) + (f, f)) − 0.5) · grain · env · 0.12 (grain cells ≈ 1.43 px, frame-stepped)
- vig = 1 − |uv − 0.5|² · env · 0.35
- RGB = clamp(col.rgb · flicker · vig + gr + flash, 0, 1) (SDR clamp helper; gr and flash added equally to all channels); α = col.α

## Edges
Displaced positions are clamped to the frame (edge-extend), so the slipped clip shows stretched top/bottom edge rows rather than a frame line or black gap.

## Alpha
Grain and gate flash are added to premultiplied RGB with α unchanged: discarded where α = 0, amplified where 0 < α < 1. Flicker and vignette scale premultiplied RGB only. RGB clamped to [0, 1], not to α. Output converted to straight alpha per [T2].

## Notes
- Endpoints (SDR float route): p = 0: env = 0, pulse = 0, t = 0 → exactly clamp(A.rgb, 0, 1), A.α = A. p = 1: t = 1, pulse = 0, env ≈ −8.7·10⁻⁸ → B up to ~10⁻⁸.
- gateWidth = 0 (allowed by the catalogue) makes both gate smoothsteps degenerate (low = high): division by zero, implementation-defined. Evaluated literally, top = 1 for all v > 0 and bottom = 0 for v < 1, i.e. a uniform 0.2 · pulse flash over the whole frame.
- **GPU-precision dependence:** jitter, flicker and grain all use HASH. Inside HASH the sine argument reaches 10⁵ to 10⁶ radians even for small inputs, because of HASH's own dot products, so these values depend entirely on how the sine is range-reduced. With the reduction of [C6] a clean-room implementation reproduces the canonical goldens; other GPUs differ, which is why these cases are `statistical`.
