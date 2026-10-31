# chromatic

| | |
|---|---|
| Category | custom |
| Directions | from-left, from-right, from-top, from-bottom [T3] |
| Duration (frames) | default 25, min 10, max 60 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A soft directional wipe combined with chromatic aberration: during the transition the red and blue channels of both clips are pulled apart along the wipe direction (plus a slight radial lens component), and a faint brightening runs along the wipe front.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| spread | number | 0 – 5 (step 0.05) | 1.5 | × | channel separation along the direction |
| intensity | number | 0 – 3 (step 0.05) | 1 | × | aberration strength (spread and radial) |

Sanitised per [T4]; absent → 1.5 and 1.

## Progress curve
p is used as received (**not clamped**). env = sin(π p); str = env · intensity.
Wipe weight (see Blend) uses the window [1.3 p − 0.15, 1.3 p + 0.15].

## Geometry
Direction vector δ and sweep coordinate s [T3]:
| direction | δ | s |
|---|---|---|
| from-left (0) | (1, 0) | u |
| from-right (1) | (−1, 0) | 1 − u |
| from-top (2) | (0, 1) | v |
| from-bottom (3) | (0, −1) | 1 − v |

- k = spread · str · 0.02; radial r = (uv − 0.5) · str · 0.01.
- PR = clamp(uv + δ · k + r, 0, 1); PG = clamp(uv, 0, 1); PB = clamp(uv − δ · k − r, 0, 1).
- For X ∈ {A, B}: X' = (S(X, PR).r, S(X, PG).g, S(X, PB).b, S(X, uv).α).

## Blend
- t = smoothstep(1.3 p − 0.15, 1.3 p + 0.15, s); col = B' · (1 − t) + A' · t (all four premultiplied channels). The outgoing clip remains ahead of the front (large s), the incoming clip appears behind it.
- glow = exp(−40 · (s − p)²) · 0.08 · env (scalar, added to all three channels).
- RGB = min(col.rgb + glow, 1) per channel (SDR limit helper: upper bound only; no lower clamp). α = col.α.

## Edges
Aberrated samples are clamped to the frame (edge-extend). Note the wipe front (centre at s = 1.3 p) and the glow line (s = p) are not at the same place.

## Alpha
Channel offsets apply to premultiplied channels while α is sampled unshifted, so near alpha edges colour fringes can exceed α; after un-premultiplying [T2] straight values can exceed 1 there (only the upper limit 1 is applied, to premultiplied RGB). The glow added to pixels with α = 0 is discarded.

## Notes
- **p = 0 endpoint is not identity (SDR float route, observed):** env = 0, so no aberration and no glow, but t = smoothstep(−0.15, 0.15, s) < 1 for s < 0.15: the strip within 15 % of the entering edge already shows a mix of B (t = 0.5 at s = 0). The transition-semantics file flags this ("sdrEndpointOffset"). p = 1: t = smoothstep(1.15, 1.45, s) = 0 everywhere, giving B (env ≈ 0).
- from-left/from-right and from-top/from-bottom are exact mirrors (the radial term is symmetric).
- p outside [0, 1]: env changes sign, so the aberration and glow invert (glow can become negative); not clamped.
