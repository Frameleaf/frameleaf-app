# gpu-rgb-split

| | |
|---|---|
| Category | distort |
| Temporal | no |
| Pass | 1 fragment pass |
| HDR | refused (engine throws HdrRenderUnavailableError for the whole chain; a native client must refuse) [C4] |

## What it does
Chromatic-aberration look: the red channel is taken from a point shifted along a direction, the blue channel from the point shifted the opposite way, green and alpha from the pixel itself.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0..0.1 (step 0.001, animatable) | 0.01 | normalised frame units | shift distance |
| angle | number | 0..6.28318 (step 0.01, animatable) | 0 | radians | shift direction |

Mapping (after [C9]; missing → default):
- o = (cos(angle), sin(angle)) · amount, in uv units. With v downward [C1], angle 0 shifts the red sample to the right, π/2 shifts it downward.

## Per-pixel definition
For output pixel (i, j) with uv from [C1]:

1. R_out = red channel of S(uv + o).
2. G_out = green channel of S(uv).
3. B_out = blue channel of S(uv − o).
4. A_out = alpha channel of S(uv).
5. Output (R_out, G_out, B_out, A_out).

In pixels, the offset is (cos(angle)·amount·W, sin(angle)·amount·H): not aspect-corrected (implementation-defined, pinned). On a 16:9 frame an angle of π/4 shifts 16/9 times more pixels horizontally than vertically.

## Edges
Shifted samples beyond the frame read the nearest edge texel (clamp-to-edge [C2]).

## Alpha
Alpha comes only from the unshifted sample. RGB channels are read as straight values from their own sample points regardless of those points' alpha, so colour from transparent regions can appear in R or B where the pixel is opaque, and vice versa (pinned). Nothing is cleared where alpha = 0.

## SDR and HDR
SDR only (sRGB-encoded straight values, hardware bilinear, no clamp). HDR: refused.

## Notes
- With amount = 0 the effect is the identity.
- Shifted taps generally fall between texels; their SDR bilinear weights have GPU-defined precision.
- cos/sin of angles up to 2π lie partly outside the [−π, π] range in which WGSL guarantees trig accuracy; offsets may differ by a tiny fraction of a pixel across GPUs.
