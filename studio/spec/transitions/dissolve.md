# dissolve

| | |
|---|---|
| Category | dissolve |
| Directions | none |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
Cross dissolve: a straight per-pixel mix of the two clips with a cosine (ease-in-out) weight. Nothing moves.

## Parameters
None.

## Progress curve
t = 0.5 − 0.5 · cos(π · clamp(p, 0, 1)).

## Geometry
None: a = S(A, uv), b = S(B, uv) (texel values at pixel centres).

## Blend
Output = a · (1 − t) + b · t on all four premultiplied channels. No clamp.

## Edges
None.

## Alpha
Alpha mixes with the same weight; the premultiplied mix followed by un-premultiplying [T2] gives the correct straight-alpha cross dissolve of partially transparent clips.

## Notes
- Endpoints (SDR float route): p = 0 gives exactly A. p = 1 gives B within GPU cos precision (cos(π) evaluated in binary32; WGSL's permitted cos error is up to 2⁻¹¹ absolute, typical hardware is far better).
- This is unrelated to the "dissolve" blend mode (dithered opacity, engine patch 0040); that patch does not touch this transition.
