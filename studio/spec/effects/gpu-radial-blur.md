# gpu-radial-blur

| | |
|---|---|
| Category | blur |
| Temporal | no |
| Pass | 1 fragment pass |
| HDR | refused (engine throws HdrRenderUnavailableError for the whole chain; a native client must refuse) [C4] |

## What it does
Streaks each pixel toward a centre point: taps are taken along the line from the pixel to the centre, with the streak length growing with the pixel's distance from the centre. Nearer taps weigh more.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0..2 (step 0.01, animatable) | 0.5 | — | streak strength |
| centerX | number | 0..1 (step 0.01, animatable) | 0.5 | normalised u | centre, horizontal |
| centerY | number | 0..1 (step 0.01, animatable) | 0.5 | normalised v (down) | centre, vertical |
| samples | number | 4..256 (step 1, not animatable, quality) | 32 | taps | tap count N |

Mapping (after [C9]; missing → default):
- c = (centerX, centerY).
- k = amount · 0.2.
- N = trunc(clamp(samples, 4, 256)).

## Per-pixel definition
For output pixel (i, j) with uv from [C1]:

1. If amount < 0.01: output S(uv) (identity). Stop.
2. δ = uv − c; ρ = |δ| = √(δx² + δy²) (Euclidean length in uv units, not aspect-corrected).
3. For m = 0 … N−1 (ascending):
   - t = m / (N−1)  (0 to 1 inclusive);
   - scale s = 1 − k · t · ρ;
   - weight w = 1 − 0.5·t (from 1 down to 0.5);
   - tap position p = c + δ · s;
   - accumulate w · S(p) over straight RGBA.
4. Output the accumulated value divided by Σw.

The first tap (t = 0) is the pixel itself. The last tap is at c + δ·(1 − kρ): the streak reaches a fraction kρ of the way toward the centre, so its length in uv is kρ² (grows quadratically with distance). Within the sanitised ranges kρ ≤ 0.4·√2 ≈ 0.566, so taps never reach or pass the centre.

## Edges
Taps lie between the pixel and the centre, which is inside [0,1]², so they never leave the frame; clamp-to-edge [C2] is not exercised.

## Alpha
Straight RGBA is averaged component-wise with the weights (transparent RGB is included). Output alpha is the weighted mean alpha.

## SDR and HDR
SDR only: sRGB-encoded straight values, hardware bilinear taps, no clamp. HDR: refused.

## Notes
- Distances are in uv units, so on a non-square frame the streak length is anisotropic (pinned).
- At the centre pixel ρ ≈ 0 and all taps coincide (identity there).
- The SDR tap interpolation precision is GPU-defined (hardware bilinear).
- Despite the name, this is a "zoom toward centre" streak, not an angular (spin) blur.
