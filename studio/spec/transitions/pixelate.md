# pixelate

| | |
|---|---|
| Category | custom |
| Directions | none |
| Duration (frames) | default 20, min 8, max 60 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
The outgoing clip breaks up into ever larger square blocks until the midpoint, swaps to the incoming clip (short cross-fade), which then resolves from large blocks back to full resolution.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| maxBlockSize | number | 4 – 160 (step 1) | 48 | px | block edge at the midpoint |

Sanitised per [T4]; absent → 48.

Derived per frame on the CPU in double precision, then stored as binary32 (p is **not clamped**):
- π' = 1 − |2p − 1|; curved = π'²
- blockPx = max(1, curved · maxBlockSize) (not rounded; fractional block sizes are used as-is)
- bu = blockPx / W, bv = blockPx / H (block size in uv)
- x = clamp((p − 0.45) / 0.1, 0, 1); cf = x² · (3 − 2x) (cross-fade weight, smoothstep over p ∈ [0.45, 0.55])

## Progress curve
Block size follows a squared tent peaking at p = 0.5 (blockPx = maxBlockSize there); the clip swap happens over p ∈ [0.45, 0.55].

## Geometry
Snap each pixel to the centre of its block, blocks anchored at the top-left corner:
- q = (floor(u / bu) · bu + 0.5 · bu, floor(v / bv) · bv + 0.5 · bv), then clamped component-wise to [0, 1].
- a = S(A, q), b = S(B, q).

The block centre usually falls between texels, so each block shows the bilinear sample at its centre (a 2×2 texel average when blockPx is even), not an area average.

## Blend
Output = a · (1 − cf) + b · cf on all four premultiplied channels. No clamp.

## Edges
The last block in each row/column may be partial; its centre may lie beyond the frame and is clamped to the edge (u or v = 1, which reads the edge texel via clamp-to-edge).

## Alpha
Alpha is snapped and mixed like colour. Output converted to straight alpha per [T2].

## Notes
- Endpoints (SDR float route): p = 0 gives blockPx = 1, q = ((i + 0.5)/W, (j + 0.5)/H) (pixel centre, up to binary32 rounding of floor(u/bu)) and cf = 0, i.e. A. p = 1 likewise gives B.
- p outside [0, 1] is not clamped: |2p − 1| > 1 makes π' negative but curved = π'² positive, so blocks grow again (e.g. p = −0.5 gives maxBlockSize). cf saturates at 0 or 1.
- Rounding of floor(u / bu) at exact block boundaries depends on binary32 division; a pixel whose centre lies exactly on a block boundary may resolve to either block (implementation-defined).
