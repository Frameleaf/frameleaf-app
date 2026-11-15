# cubeSpin

| | |
|---|---|
| Category | flip |
| Directions | from-left, from-right, from-top, from-bottom [T3] |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
The two clips are adjacent faces of a box seen in perspective. The box turns a quarter turn, carrying the outgoing clip away and bringing the incoming clip, which enters from the named side, to face the viewer (FL-1564). Where neither face covers the frame, the output is opaque black.

## Parameters
None. Only p and the direction are used.

## Progress curve
θ = clamp(p, 0, 1) · π/2.

## Geometry
Screen coordinates: x = 2u − 1, y = 1 − 2v. They are rotated into spin coordinates (s, o), so that the incoming clip always enters from negative s:

| direction | s | o |
|---|---|---|
| from-left (0) | x | y |
| from-right (1) | −x | y |
| from-top (2) | −y | x |
| from-bottom (3) | y | x |

The eye is at E = (0, 0, 3) and the ray through the pixel is r = (s, o, −3) in (s, o, z) space. The box has centre C = (0, 0, −1); each face is the square of half-size 1 about its centre, so the outgoing face fills the frame exactly at θ = 0. With c = cos θ and σ = sin θ:

| face | normal n | centre | right axis ρ |
|---|---|---|---|
| A (outgoing) | (σ, 0, c) | C + n | (c, 0, −σ) |
| B (incoming) | (−c, 0, σ) | C + n | (σ, 0, c) |

For a face: d = r·n. If d ≥ 0 the face is missed. Otherwise τ = ((centre − E)·n)/d and the hit is H = E + τ·r, with local coordinates l_s = (H − centre)·ρ and l_o = H.o. The face is hit when τ > 0, |l_s| ≤ 1 and |l_o| ≤ 1. If both faces are hit the one with the smaller τ is used (A on a tie).

The local coordinates map back to the clip's own coordinates (x′, y′):

| direction | x′ | y′ |
|---|---|---|
| from-left | l_s | l_o |
| from-right | −l_s | l_o |
| from-top | l_o | −l_s |
| from-bottom | l_o | l_s |

and the clip is sampled at q = ((x′ + 1)/2, (1 − y′)/2), with an explicit level 0.

## Blend
Output = S(A, q) where A is used, S(B, q) where B is used, otherwise opaque black (0, 0, 0, 1). The clips are not mixed.

## Edges
Face outlines are hard (no anti-aliasing); a face seen at a steep angle is minified by bilinear sampling without mipmaps and aliases.

## Alpha
The used face's alpha; the surround is opaque. Converted to straight alpha per [T2].

## Notes
- Endpoints: p = 0 gives A exactly (θ = 0); p = 1 gives B (θ = π/2, within GPU cos and sin precision).
- At θ = π/4 the near edge of the box is the vertical (or horizontal) centre line of the frame, and the outer corners reach about 6 % beyond the frame's sides.
