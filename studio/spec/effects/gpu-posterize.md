# gpu-posterize

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single full-frame pass, output size = input size |
| HDR | refused [C4] |

## What it does
Quantises each colour channel independently into a small number of levels.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| levels | number | 2 – 32 | 6 | count | number of quantisation levels per channel |

Sanitised per [C9]. The catalogue step of 1 is a UI hint only: the value is **not rounded**, so interpolated keyframes can deliver fractional levels, which are used as-is. Internally L = max(levels, 2) (redundant after sanitising).

## Per-pixel definition
1. c = S(uv) = F(i, j).
2. For each channel x ∈ {R, G, B}: x_out = floor(x · L) / (L − 1).
3. A_out = c.a.

No clamp is applied to the result.

## Edges
Only the pixel's own texel is read.

## Alpha
Alpha passes through. RGB at alpha = 0 is quantised from the stored straight RGB like any other pixel.

## SDR and HDR
SDR: quantises sRGB-encoded values [C3]. HDR: refused [C4].

## Notes
- **Overshoot (implementation-defined, observed):** the mapping is floor(x·L)/(L−1), not the symmetric round-to-level form. For integer L and 0 ≤ x < 1 the outputs are k/(L−1), k = 0 … L−1, i.e. 0 … 1. But an input of exactly x = 1 gives L/(L−1) > 1 (e.g. 1.2 at the default L = 6). For fractional L, the largest bucket for x < 1 is (ceil(L) − 1)/(L − 1), which also exceeds 1 (e.g. L = 2.5 → 1.333). These values are not clamped by this pass; they are carried to the next effect in binary16 [C3] and clamped only by whatever later step bounds the range. A conforming native implementation must reproduce the overshoot, not clamp it. The canonical goldens hold it (1.2 at white for L = 6). One hardware backend (Metal) was observed to floor exact integer products x·L one level lower, which gives 1.0 at white; a native client follows the canonical result, and the golden tolerance counts those channels as outliers.
- The effective bucket boundaries are at x = k/L (k = 1 … L−1) while the output levels are k/(L−1): the result is biased towards brighter values compared with an evenly rounded posterize.
- Negative inputs (not normally present in SDR) floor towards −∞.
