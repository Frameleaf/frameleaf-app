# gpu-zoom-blur

| | |
|---|---|
| Category | blur |
| Temporal | no |
| Pass | 1 fragment pass |
| HDR | refused (engine throws HdrRenderUnavailableError for the whole chain; a native client must refuse) [C4] |

## What it does
Averages N taps along the ray from a centre point through the pixel, stepping outward beyond the pixel, giving a zoom/explosion streak. All taps weigh equally.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0..1 (step 0.01, animatable) | 0.3 | — | zoom strength |
| centerX | number | 0..1 (step 0.01, animatable) | 0.5 | normalised u | centre, horizontal |
| centerY | number | 0..1 (step 0.01, animatable) | 0.5 | normalised v (down) | centre, vertical |
| samples | number | 4..256 (step 1, not animatable, quality) | 16 | taps | tap count N |

Mapping (after [C9]; missing → default):
- c = (centerX, centerY).
- k = amount · 0.5.
- N = trunc(clamp(samples, 4, 256)).

## Per-pixel definition
For output pixel (i, j) with uv from [C1]:

1. δ = uv − c.
2. For m = 0 … N−1 (ascending):
   - t = m / (N−1)  (0 to 1 inclusive);
   - scale s = 1 + k · t;
   - tap position p = c + δ · s;
   - accumulate S(p) over straight RGBA.
3. Output the sum divided by N.

There is no early exit: with amount = 0 all N taps are S(uv) and the result equals S(uv) up to float rounding of the mean.

The first tap is the pixel itself; the last is at c + δ·(1 + k), i.e. up to 50 % further from the centre than the pixel. Streak length in uv is k·|δ|, growing linearly with distance from the centre.

## Edges
Outer taps can leave [0,1]²; they read the nearest edge texel (clamp-to-edge [C2]) and still count fully in the mean, so border colours smear inward near the frame edges.

## Alpha
Straight RGBA is averaged component-wise with equal weights; output alpha is the mean alpha; transparent RGB is included in the colour mean.

## SDR and HDR
SDR only: sRGB-encoded straight values, hardware bilinear taps, no clamp. HDR: refused.

## Notes
- Distances are in uv units (not aspect-corrected): taps follow the straight line in uv space, which is also a straight line on screen, so geometry is consistent; only "length" comparisons are anisotropic.
- Contrast with gpu-radial-blur: zoom blur samples outward (away from the centre) with equal weights; radial blur samples inward with decreasing weights and a distance-squared length.
- SDR bilinear tap precision is GPU-defined.
