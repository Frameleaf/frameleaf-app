# gpu-color-glitch

| | |
|---|---|
| Category | stylize |
| Temporal | yes (stepped) |
| Pass | single full-frame pass, output size = input size |
| HDR | refused [C4] |

## What it does
Splits the frame into 28 horizontal bands. On each time step a random subset of bands (larger with intensity) is shifted sideways, gets an RGB channel split, and the strongest of those also get a random hue rotation.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| intensity | number | 0 – 1 | 0.5 | fraction | share of glitched bands and size of shift/split |
| speed | number | 0.1 – 5 | 1 | × | step rate; 12 · speed steps per second |

Sanitised per [C9] (speed not animatable). Internally a = clamp(intensity, 0, 1).

Clock: t from [C8], as binary32. Time step (binary32, evaluated left to right):
- σ_raw = floor((t · speed) · 12).
- T = σ_raw − 64 · floor(σ_raw / 64) (floored modulo; T ∈ {0, …, 63}).

t enters **only** through T. The look is constant within a step (1 / (12 · speed) s), jumps at step boundaries, and the whole sequence repeats every 64 steps (64 / (12 · speed) s; 5.33 s at speed 1).

## Per-pixel definition
With uv = (u, v) [C1] and HASH from [C6]:

1. band b = floor(v · 28) ∈ {0, …, 27}.
2. η = HASH((b, T)).
3. on = 1 if η ≥ 1 − a, else 0.
4. shift = (HASH((1.7 · b, T + 3)) − 0.5) · 0.15 · a · on.
5. split = (0.004 + 0.02 · a) · on.
6. P = (u + shift, v).
7. R = S(P + (split, 0)).r; G = S(P).g; B = S(P − (split, 0)).b; A = S(P).a.
8. hue = 1 if (η ≥ 0.82 and on = 1), else 0.
9. If hue = 1: (h, s, val) = RGB→HSV((R, G, B)) [C7]; h' = fract(h + HASH((b, T + 7))); (R, G, B) = HSV→RGB((h', s, val)).
   (The engine computes this as a linear blend with weight hue ∈ {0, 1}; the two forms agree within rounding.)
10. Output = (R, G, B, A). No clamp.

Shift and split are in normalised u units (proportion of frame width), positive shift samples from the right (content moves left).

## Edges
Displaced samples beyond the left/right edge read clamp-to-edge [C2]. Vertical position is never displaced.

## Alpha
Alpha is sampled at the shifted position P (it moves with the green channel). Channels are sampled from straight RGB without alpha weighting; at matte edges R and B may come from pixels whose alpha differs from A. RGB at alpha = 0 is processed identically.

## SDR and HDR
SDR: sRGB-encoded values [C3], unclamped; the hue rotation can produce values only within the input's [min, max] range per pixel. HDR: refused [C4].

## Notes
- **Strong GPU-precision dependence.** HASH arguments here are large: for b ≤ 27 and T ≤ 70 the inner pre-transform gives values up to ≈ 2.5 × 10⁴, and the sine argument reaches ≈ 2 × 10⁶ radians. Binary32 sin at that magnitude differs between GPUs, so which bands glitch, their shift and hue offsets are **not reproducible bit-for-bit across devices**; only the structure (28 bands, per-step re-roll, proportions governed by a) is specified exactly.
- **Step boundary rounding (implementation-defined):** the product (t · speed) · 12 is evaluated in binary32. When t is an exact multiple of a step (e.g. frame times at 12 fps or 24 fps with speed 1), binary32 rounding of t can put the product just below the integer and select the previous step. Native code must use binary32 with the same evaluation order to match the reference on such frames.
- intensity = 0: η < 1 always, so nothing glitches and the output equals the input. intensity = 1: every band is glitched.
- band boundaries: v · 28 with v = (j + 0.5)/H, so band edges are at j ≈ H·k/28 − 0.5.
