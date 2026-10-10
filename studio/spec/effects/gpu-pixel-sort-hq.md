# gpu-pixel-sort-hq

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single compute pass (scatter), output size = input size (W × H); exact texel fetches F only |
| HDR | refused [C4] |

## What it does
"Pixel Sort": a true per-run sort. Along every row (horizontal) or column (vertical), each maximal contiguous run of pixels whose luma lies in the threshold band is reordered by luma; pixels outside the band stay exactly where they are. Whole pixels (RGBA) move; no colours are created or changed.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| orientation | select | horizontal, vertical | horizontal | — | sort along rows or along columns |
| order | select | ascending, descending | ascending | — | ascending: dark → bright (left→right / top→bottom); descending: bright → dark |
| low | number | 0 – 1 | 0.25 | luma | band lower bound (inclusive) |
| high | number | 0 – 1 | 0.9 | luma | band upper bound (inclusive) |

Sanitised per [C9]. Absent keys use defaults.

## Definition (whole-image)
Key: l(x, y) = LUMA709(F(x, y).rgb) [C7], computed in binary32. Band: in(l) ⇔ low ≤ l ≤ high.

For each line (row y for horizontal, column x for vertical), index the pixels along the line by a = 0 … A−1 (A = W or H; increasing x or increasing y):
1. Out-of-band pixels: output[a] = input[a].
2. Partition the in-band pixels into **runs**: maximal intervals [s, e] of consecutive indices that are all in band (bounded by an out-of-band pixel or the line end).
3. Within a run, define the total order: pixel a precedes pixel b iff l(a) < l(b), or l(a) = l(b) and a < b (stable: ties keep original order).
4. rank(a) = number of pixels in the run that precede a (0 … e − s).
5. Destination: ascending → s + rank(a); descending → e − rank(a). output[destination] = input[a] (all four channels).

So ascending is a stable sort by luma, darkest at the run's start (left / top); descending is the exact reversal of that sequence (brightest at the start, and equal-luma pixels appear in **reverse** original order). Every output texel is written exactly once (a permutation within each run).

## Edges
Runs end at the frame edge. No sampling outside the frame occurs.

## Alpha
Alpha moves with its pixel. The key ignores alpha (straight RGB luma), so transparent pixels are sorted like any other according to their hidden RGB. Values are copied bit-exactly.

## SDR and HDR
SDR: luma of sRGB-encoded binary16 values [C3]; outputs are a permutation of inputs. HDR: refused [C4].

## Notes
- Fully specifiable. The only implementation-defined aspect is binary32 rounding of LUMA709 (fused multiply-add or not), which can change (a) whether a pixel exactly at low/high is in band and (b) the relative order of two pixels whose lumas differ by about one ulp or are exactly equal. A reimplementation must compute the key with one fixed formula for every pixel so ranks form a permutation.
- Cost is O(run length) per pixel; a full-width in-band row costs O(W²) for that row. The result is independent of execution order.
