# gpu-vignette

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single full-frame pass, output size = input size (W × H) |
| HDR | refused [C4] |

## What it does
Darkens the frame towards black with an elliptical falloff centred on the frame. The ellipse follows the frame's shape (it is defined in normalised coordinates, not pixels); `roundness` squashes or stretches it vertically.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0 – 1 | 0.5 | fraction | strength of the darkening; 0 = no effect, 1 = full black outside the falloff |
| size | number | 0 – 1.5 | 0.5 | normalised radius | radius at which darkening starts |
| softness | number | 0 – 1 | 0.5 | normalised radius | width of the transition band |
| roundness | number | 0.5 – 2 | 1 | ratio | multiplier on the vertical component of the distance |

Values are sanitised per [C9]; a missing parameter takes its default. No other derived quantities: the four values are used directly. All arithmetic is binary32.

## Per-pixel definition
For output pixel (i, j) with uv per [C1]:

1. c = S(uv) [C2]. Because output and input are the same size, this equals F(i, j).
2. (x, y) = uv − (0.5, 0.5).
3. d = 2 · sqrt(x² + (y · roundness)²). (d = 1 at the middle of each edge when roundness = 1; ≈ 1.414 at the corners.)
4. vig = 1 − smoothstep(size, size + softness, d).
5. k = mix(1, vig, amount) = 1 − amount + amount · vig.
6. RGB_out = mix((0,0,0), c.rgb, k) = c.rgb · k (computed as a linear interpolation from 0).
7. A_out = c.a.

No clamp is applied to RGB_out; since 0 ≤ k ≤ 1 the result never exceeds the input.

## Edges
Only the pixel's own texel is read; no edge handling needed.

## Alpha
Alpha passes through unchanged. RGB at alpha = 0 is computed by the same formula from the stored (straight) RGB; there is no special case.

## SDR and HDR
SDR: operates on the sRGB-encoded values [C3]; the darkening is multiplicative on encoded values, not on linear light. Not clamped (the HDR semantics file marks it `sdrClamped: false`), but the operation cannot raise a value. HDR: refused [C4].

## Notes
- **softness = 0 (implementation-defined):** smoothstep with equal edges is undefined in the source shading language. On the reference GPUs it behaves as a hard step (vig = 1 where d < size, vig = 0 where d > size); exactly at d = size the result is a division 0/0 and is undefined (NaN may be produced). A native implementation should use a hard step (vig = 1 for d < size, 0 otherwise) and accept that pixels exactly on the boundary may differ.
- Not aspect-corrected: on a 16:9 frame the vignette is an ellipse matching the frame, not a circle in pixels.
- The vignette darkens towards encoded black, so it is not a physically-based (linear-light) vignette.
