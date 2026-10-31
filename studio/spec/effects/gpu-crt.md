# gpu-crt

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single full-frame pass, output size = input size |
| HDR | refused [C4] |

## What it does
Simulates a CRT tube: barrel distortion with a soft black border, radial chromatic aberration, fixed-count scanlines and a corner vignette.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| curvature | number | 0 – 1 | 0.3 | fraction | barrel distortion strength |
| scanlines | number | 0 – 1 | 0.3 | fraction | scanline darkness |
| vignette | number | 0 – 1 | 0.3 | fraction | corner darkening |
| chroma | number | 0 – 2 | 0.4 | — | chromatic aberration strength |

Sanitised per [C9]. Derived (binary32):
- κ = clamp(curvature, 0, 1) · 0.35.
- border width ε = 0.004 + κ · 0.02.
- σ_s = clamp(scanlines, 0, 1); σ_v = clamp(vignette, 0, 1). chroma is used unclamped (range limited only by [C9]).
- PI = 3.14159265359.
W and H are not used.

## Per-pixel definition
1. c₀ = 2·uv − 1 (each component in (−1, 1); (0,0) is the frame centre; no aspect correction).
2. r² = c₀·c₀ (dot product).
3. Warped coordinate: w = c₀ · (1 + r² · κ); q = w · 0.5 + 0.5.
4. mask = smoothstep(0, ε, q.x) · smoothstep(0, ε, 1 − q.x) · smoothstep(0, ε, q.y) · smoothstep(0, ε, 1 − q.y).
5. Aberration distance δ = chroma · 0.012 · r². Direction d = normalise(c₀ + (0.00001, 0.00001)) (the tiny bias avoids a zero vector at the exact centre).
6. R = S(q + d·δ).r; G = S(q).g; B = S(q − d·δ).b; A = S(q).a.
7. Scanlines: ℓ = 0.5 + 0.5 · sin(q.y · 320 · PI); RGB ← RGB · (1 − σ_s · (1 − ℓ)).
8. Vignette: RGB ← RGB · (1 − σ_v · smoothstep(0.35, 1.5, r²)).
9. Output = (RGB · mask, A). No clamp.

Scanline pattern: period 2/320 in q.y, i.e. 160 dark lines over the (warped) frame height, independent of resolution. Red is displaced outward from the centre, blue inward.

## Edges
q leaves [0, 1] near the borders when κ > 0; those samples read clamp-to-edge [C2], but the mask drives RGB to 0 there (smoothstep(0, ε, x) = 0 for x ≤ 0).

## Alpha
**Alpha is not masked**: A is the source alpha at the warped position q (clamp-to-edge outside), so the area outside the "tube" is opaque black when the source edge is opaque. Channels are not alpha-weighted. RGB at alpha = 0 is processed the same way.

## SDR and HDR
SDR: sRGB-encoded values [C3]; all operations are multiplications by factors in [0, 1], unclamped. HDR: refused [C4].

## Notes
- **Border at curvature = 0 (observed):** ε = 0.004 even with no curvature, so the outermost ≈ 0.4 % of width/height on each side (≈ 8 px at 1920 wide) is faded to black by the mask. Reproduce it.
- The warp uses the same factor on both axes in normalised space; on non-square frames the bulge is stretched with the frame.
- Corners: r² up to 2, so the vignette (smoothstep from 0.35 to 1.5) saturates before the extreme corners.
- Transcendentals (sin with argument ≤ ~ 320·π·1.35, sqrt in normalisation) have only rounding-level precision effects.
