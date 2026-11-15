# crossZoom

| | |
|---|---|
| Category | motion |
| Directions | none |
| Duration (frames) | default 24, min 8, max 72 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
The outgoing clip zooms in towards the frame centre while the incoming clip zooms out from close up to its normal size, both blurred along the radius from the centre; the clips cross in the middle (FL-1564).

## Parameters
| Name | Default | Range | Meaning |
|---|---|---|---|
| strength | 0.4 | 0 … 1 | How far the clips zoom and how strong the radial blur is. |

## Progress curve
p′ = clamp(p, 0, 1). Blur amount β = strength · sin(π p′). Zooms z_A = 1 + 2·strength·p′ and z_B = 1 + 2·strength·(1 − p′). Mix weight m = p′²(3 − 2p′).

## Geometry
With centre c = (0.5, 0.5) in uv (no aspect correction), twelve taps i = 0 … 11 with k_i = 1 − β·(i/11):

- a = (1/12)·Σ S(A, c + (uv − c)·k_i / z_A)
- b = (1/12)·Σ S(B, c + (uv − c)·k_i / z_B)

Every tap lies between uv and c, so no tap leaves the frame when uv is inside it. The taps are sampled with an explicit level 0 (no mipmaps).

## Blend
Output = a·(1 − m) + b·m on the four premultiplied channels. No clamp.

## Edges
None.

## Alpha
Alpha follows the same taps and mix. The result is converted to straight alpha per [T2].

## Notes
- Endpoints: p = 0 gives A (β = 0, z_A = 1, every tap at uv); p = 1 gives B (β = sin π, within GPU sin precision of 0, and z_B = 1).
- With strength 0 the transition is a smoothstep cross dissolve.
