# gpu-edge-detect

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single full-frame pass, output size = input size (W × H) |
| HDR | refused [C4] |

## What it does
Sobel edge magnitude of BT.709 luma, shown as grey-scale (white edges on black, or inverted).

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| strength | number | 0 – 5 | 1 | gain | multiplier on the gradient magnitude |
| invert | boolean | — | false | — | if true, output 1 − edge (dark edges on white) |

Sanitised per [C9]. Pixel size (Δu, Δv) = (1/W, 1/H).

## Per-pixel definition
Let L(dx, dy) = LUMA709(S(uv + (dx·Δu, dy·Δv)).rgb) [C7], for dx, dy ∈ {−1, 0, 1}. Because offsets are whole texels these are exact fetches of the neighbours F(i+dx, j+dy), clamped to the frame. dy = −1 is the row above (v grows downward [C1]).

Name the neighbours tl = L(−1,−1), t = L(0,−1), tr = L(1,−1), l = L(−1,0), r = L(1,0), bl = L(−1,1), b = L(0,1), br = L(1,1). The centre pixel is not read.

1. gx = −tl − 2·l − bl + tr + 2·r + br.
2. gy = −tl − 2·t − tr + bl + 2·b + br.
3. e = clamp(sqrt(gx² + gy²) · strength, 0, 1).
4. If invert is true: e = 1 − e.
5. Output = (e, e, e, 1).

## Edges
Neighbours outside the frame read the nearest edge texel (clamp-to-edge [C2]), so the outermost ring sees a duplicated edge row/column (gradient across the border is computed against itself).

## Alpha
**Output alpha is always 1**, regardless of input alpha: transparent regions of a clip become opaque black (or white when inverted). Luma is computed from the stored straight RGB with no alpha weighting, so hidden RGB under alpha = 0 produces edges.

## SDR and HDR
SDR: luma of sRGB-encoded values [C3]; output is in [0, 1]. HDR: refused [C4].

## Notes
- Maximum raw magnitude for inputs in [0, 1] is 4·√2 ≈ 5.657, so strength = 1 saturates only on very hard edges.
- The opaque-alpha output is observed behaviour of the engine and must be reproduced.
