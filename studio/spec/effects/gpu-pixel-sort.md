# gpu-pixel-sort

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single full-frame fragment pass, output size = input size (W × H) |
| HDR | refused [C4] |

## What it does
"Pixel Sort (Streak)": a fast approximation of pixel sorting. It is **not** a sort. Each pixel whose luma lies in the threshold band looks ahead along the chosen direction, within its own contiguous in-band run and up to `length` pixels, and takes the colour of the brightest (or darkest) pixel it finds. The result is bright (or dark) streaks dragged against the direction of travel. Pixels outside the band are unchanged. For a true sort see gpu-pixel-sort-hq.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| direction | select | right, left, down, up | right | — | look-ahead direction |
| order | select | bright, dark | bright | — | carry the brightest or the darkest colour |
| low | number | 0 – 1 | 0.25 | luma | band lower bound (inclusive) |
| high | number | 0 – 1 | 1 | luma | band upper bound (inclusive) |
| length | number | 2 – 400 | 60 | px | maximum look-ahead (not animatable; quality setting) |

Sanitised per [C9]. Absent keys use defaults (`order` absent → bright).

Internal: step (dx, dy) = right (1, 0), left (−1, 0), down (0, 1), up (0, −1) in pixels (down = increasing j). N = trunc(clamp(length, 1, 512)) (= floor(length) within the sanitised range). Key K(l) = l for bright, −l for dark. Band test: in(l) ⇔ low ≤ l ≤ high (if low > high no pixel is in band and the effect is the identity).

## Per-pixel definition
1. c0 = S(uv) (= F(i, j)). l0 = LUMA709(c0.rgb) [C7].
2. If not in(l0): output c0 unchanged and stop.
3. best = K(l0); col = c0.rgb.
4. For k = 1, 2, …, N:
   1. Position (i + k·dx, j + k·dy). If outside the frame (column < 0 or ≥ W, row < 0 or ≥ H): stop.
   2. s = colour at that pixel (sampled at its centre: S((i + 0.5 + k·dx)/W, (j + 0.5 + k·dy)/H) — i.e. F at that pixel up to binary32 rounding of the coordinate).
   3. l = LUMA709(s.rgb). If not in(l): stop (end of the run).
   4. If K(l) > best (strictly): best = K(l); col = s.rgb.
5. Output = (col, c0.a).

Observable result: each in-band pixel shows the extreme-luma colour among itself and the next ≤ N in-band pixels ahead of it in the same row/column, the look-ahead ending at the first out-of-band pixel or the frame edge. Ties keep the nearest (earliest) pixel, the pixel itself first. Nothing moves backwards; the last pixel of a run before the boundary keeps its own colour.

## Edges
The look-ahead stops at the frame edge (no clamping or wrap).

## Alpha
Output alpha is the pixel's own alpha; RGB is taken from the carried pixel regardless of that pixel's alpha (straight RGB of a transparent pixel can be carried into a visible one). Band tests use straight RGB without alpha weighting.

## SDR and HDR
SDR: luma of sRGB-encoded values; outputs are copies of input values (no new colours) [C3]. HDR: refused [C4].

## Notes
- Sampling is bilinear at computed texel centres; on all conforming GPUs the weights round to exactly the one texel, but a reimplementation should use exact fetches F (same result).
- LUMA709 evaluated in binary32; luma values exactly at low/high or exactly equal between pixels depend on the dot-product rounding (fused multiply-add or not), which is implementation-defined. Only such boundary/tie cases can differ.
- Cost is O(N) per pixel; N ≤ 400 after sanitising (the internal cap is 512).
