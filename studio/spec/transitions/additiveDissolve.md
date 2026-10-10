# additiveDissolve

| | |
|---|---|
| Category | dissolve |
| Directions | none |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A linear dissolve with an additive brightness flash: around the midpoint, a fraction of the sum of both clips is added on top, so the image brightens (and highlights clip) through the middle of the transition.

## Parameters
None.

## Progress curve
p_c = clamp(p, 0, 1). Mix weight is linear (p_c), flash envelope e = sin(π · p_c).

## Geometry
None: a = S(A, uv), b = S(B, uv).

## Blend
On premultiplied RGB:
- base = a.rgb · (1 − p_c) + b.rgb · p_c
- flash = (a.rgb + b.rgb) · e · 0.22
- RGB = clamp(base + flash, 0, 1) (SDR clamp helper, per channel)

α = a.α · (1 − p_c) + b.α · p_c (not clamped).

## Edges
None.

## Alpha
The RGB clamp is to 1, not to α. Where α < 1 the clamped premultiplied RGB can exceed α, so after un-premultiplying [T2] straight RGB can exceed 1 (and is not re-clamped on the float route). Where α = 0 the output is all zero regardless of the flash.

## Notes
- Peak flash at p = 0.5 adds 0.22 × (a + b) = 0.44 × the average of the clips.
- Endpoints (SDR float route): p = 0 gives clamp(a.rgb, 0, 1) with alpha a.α — equal to A for in-range input. p = 1 gives clamp(b.rgb + 0.22 · (a.rgb + b.rgb) · sin(π), 0, 1); binary32 sin(π) ≈ −8.7·10⁻⁸, so B to within ~10⁻⁷.
