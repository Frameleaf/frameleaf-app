# nonAdditiveDissolve

| | |
|---|---|
| Category | dissolve |
| Directions | none |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A linear dissolve that gently holds back highlights in the middle of the transition: channels brighter than the mix's luma + 0.18 are pulled down slightly toward that ceiling, so the overlap never looks brighter than the clips.

## Parameters
None.

## Progress curve
p_c = clamp(p, 0, 1). Linear mix weight p_c; guard envelope g = sin(π · p_c) · 0.18 (max 0.18 at p = 0.5).

## Geometry
None: a = S(A, uv), b = S(B, uv).

## Blend
On premultiplied RGB:
- n = a.rgb · (1 − p_c) + b.rgb · p_c
- Y = 0.2126 · n.r + 0.7152 · n.g + 0.0722 · n.b
- ceiling c = min(n, Y + 0.18) per channel
- RGB = clamp(n · (1 − g) + c · g, 0, 1) (SDR clamp helper)

α = a.α · (1 − p_c) + b.α · p_c.

## Edges
None.

## Alpha
Luma and the ceiling are computed on premultiplied values, so the 0.18 offset is relative to premultiplied luma (semi-transparent pixels are guarded more strongly in straight terms). RGB is clamped to [0, 1], not to α. Output converted to straight alpha per [T2].

## Notes
- The guard only lowers channels (c ≤ n); at most 18 % of the excess above Y + 0.18 is removed.
- Endpoints (SDR float route): p = 0 gives clamp(a, 0, 1) = A for in-range input; p = 1 gives B to within binary32 sin(π) (≈ 10⁻⁸ scale).
