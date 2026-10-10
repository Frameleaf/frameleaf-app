# gpu-glow

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single full-frame pass, output size = input size (W × H) |
| HDR | refused [C4] |

## What it does
Bloom: gathers bright (above-threshold) colour from concentric rings of samples around each pixel, weights rings with a Gaussian, and adds the result to the pixel.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0 – 5 | 1 | gain | strength of the added glow |
| threshold | number | 0 – 1 | 0.6 | encoded luma | luma above which colour contributes (soft ±0.1 band) |
| radius | number | 1 – 100 | 20 | see below | ring spacing |
| softness | number | 0.1 – 1 | 0.5 | — | Gaussian σ offset for ring weights |
| rings | number | 1 – 32 | 4 | count | number of rings (quality) |
| samplesPerRing | number | 4 – 64 | 16 | count | samples per ring (quality) |

Sanitised per [C9]. Derived quantities (binary32):
- R = trunc(clamp(rings, 1, 32)), N = trunc(clamp(samplesPerRing, 4, 64)) — fractional values truncate towards zero (e.g. 4.9 → 4). The catalogue step of 1 is not enforced.
- Δu = 1/W. **Only the horizontal pixel size is used**, for both axes (see Notes).
- Ring k (k = 1 … R) radius in uv units: ρ_k = k · radius · Δu · 10.
- Ring weight: w_k = GAUSS(k / R, softness + 0.3) [C7] = exp(−(k/R)² / (2·(softness+0.3)²)).
- TAU = 6.28318530718.

## Per-pixel definition
1. c = S(uv) = F(i, j).
2. G = (0,0,0); Wsum = 0.
3. For k = 1 … R (outer), for n = 0 … N−1 (inner):
   - θ = n · TAU / N + k · 0.5 (radians; each ring is rotated by 0.5 rad relative to the previous index);
   - p = uv + (cos θ, sin θ) · ρ_k (positive sin moves down [C1]);
   - s = S(p);
   - β = smoothstep(threshold − 0.1, threshold + 0.1, LUMA709(s.rgb));
   - G += s.rgb · β · w_k; Wsum += w_k.
4. Centre term: β_c = smoothstep(threshold − 0.1, threshold + 0.1, LUMA709(c.rgb)); G += c.rgb · β_c · 2; Wsum += 2.
5. G = G / Wsum.
6. RGB_out = clamp(c.rgb + G · amount · 2, 0, 1).
7. A_out = c.a.

## Edges
Samples outside the frame read clamp-to-edge [C2]. With large radius and many rings most samples land outside the frame (ring 4 at radius 100 is 4000 px away horizontally), so the glow is then dominated by the repeated edge pixels.

## Alpha
Output alpha = centre alpha. Samples are straight RGB with no alpha weighting; hidden RGB under alpha = 0 can glow. RGB at alpha = 0 follows the same formula.

## SDR and HDR
SDR: sRGB-encoded values [C3], clamped to [0, 1]. Glow is additive on encoded values. HDR: refused [C4].

## Notes
- **Anisotropy (implementation-defined, observed):** ring radii are expressed in uv units scaled by 1/W on both axes. In pixels the ring is k·radius·10 px wide horizontally but k·radius·10·H/W px tall vertically, so on landscape frames the ring is an ellipse flattened vertically (on 16:9, vertical reach is 56.25 % of horizontal). Reproduce as specified.
- The radius unit is therefore "10 horizontal pixels per ring step".
- Sample positions are generally not on texel centres, so bilinear filtering [C2] is part of the result.
- cos/sin arguments are small (< ~ 2π + 16), so GPU transcendental precision has only rounding-level effect.
