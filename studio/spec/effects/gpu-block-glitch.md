# gpu-block-glitch

| | |
|---|---|
| Category | stylize |
| Temporal | yes (stepped) |
| Pass | single full-frame pass, output size = input size (W × H) |
| HDR | refused [C4] |

## What it does
Divides the frame into square pixel blocks. On each time step a random subset of blocks is displaced (horizontal slab shift per block row, occasional vertical jump), gets an RGB split, and some are digitally corrupted (channel rotation, inversion or 4-level posterisation).

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| coverage | number | 0 – 1 | 0.3 | fraction | probability that a block glitches on a step |
| intensity | number | 0 – 1 | 0.6 | fraction | size of displacement and split |
| blockSize | number | 8 – 200 | 40 | pixels | block edge length |
| speed | number | 0.1 – 5 | 1 | × | step rate; 8 · speed steps per second |

Sanitised per [C9] (speed not animatable). Derived (binary32):
- a = clamp(intensity, 0, 1); κ = clamp(coverage, 0, 1).
- cell = max(blockSize, 2) (not rounded; fractional block sizes are used as-is).
- cols = max(W / cell, 1); rows = max(H / cell, 1) (not rounded).
- Clock: t from [C8], as binary32. σ_raw = floor((t · speed) · 8); T = σ_raw − 64 · floor(σ_raw / 64) ∈ {0 … 63}. t enters only through T; the pattern is constant for 1/(8·speed) s and repeats every 64 steps (8 s at speed 1).

## Per-pixel definition
With uv = (u, v) [C1] and HASH from [C6]:

1. Block index bx = floor(u · cols), by = floor(v · rows). Since u · cols = (i + 0.5)/cell, blocks are cell pixels wide starting at the left/top edge; the last column/row may be partial.
2. r1 = HASH((bx + 3·by, T)); on = 1 if r1 ≥ 1 − κ else 0.
3. dx = (HASH((by, T + 5)) − 0.5) · 0.25 · a · on (the shift value depends only on the block row; whether it applies depends on the block).
4. jump = 1 if HASH((bx + by, T + 13)) ≥ 0.6 else 0.
5. dy = (HASH((bx, T + 9)) − 0.5) · 0.06 · a · on · jump.
6. P = (u + dx, v + dy).
7. split = (0.01 + 0.03 · a) · on.
8. R = S(P + (split, 0)).r; G = S(P).g; B = S(P − (split, 0)).b; A = S(P).a. Let c = (R, G, B).
9. corrupt = 1 if (HASH((1.3·bx + by, T + 21)) ≥ 0.7 and on = 1) else 0.
10. mode = HASH((2.1·by + bx, T + 27)):
    - mode < 0.34: c' = (G, B, R) (channel rotation: new red = old green, new green = old blue, new blue = old red);
    - else mode < 0.67: c' = (1 − R, 1 − G, 1 − B);
    - else: c' = floor(c · 4) / 4 per channel (levels 0, 0.25, 0.5, 0.75; 1 only for inputs ≥ 1).
11. RGB_out = corrupt ? c' : c (engine uses a linear blend with weight ∈ {0, 1}; equal within rounding). A_out = A. No clamp.

dx, dy, split are in normalised uv units (fractions of width / height).

## Edges
Displaced samples outside the frame read clamp-to-edge [C2]. Displacement is per block, so the block shows displaced content with a hard boundary to neighbours.

## Alpha
Alpha is sampled at P (moves with the block). Channels are not alpha-weighted; RGB at alpha = 0 is processed the same way. Corruption modes never touch alpha.

## SDR and HDR
SDR: sRGB-encoded values [C3], unclamped (inversion of an out-of-range upstream value can go negative). HDR: refused [C4].

## Notes
- **Strong GPU-precision dependence:** HASH arguments reach about 1 300 (e.g. bx + 3·by with bx ≤ 480, by ≤ 270 for 8 px blocks at 3840 × 2160), giving sine arguments up to ≈ 3 × 10⁷ radians; which blocks glitch and by how much is not reproducible across GPUs. Structure (grid, step timing, thresholds 0.6/0.7/0.34/0.67, magnitudes) is exact. The arguments of every HASH here are whole numbers or exact binary32 products of them, so with the canonical sine and the rounding rules of [C6] a clean-room implementation reproduces the canonical choice of blocks, shifts and corruption modes: a reference written from this page meets the goldens below in all but 0 to 29 of 768 channels. That holds for the arm64 build that wrote the goldens; the x86-64 build of the same backend rounds differently and picks other blocks [C6]. With an accurate sine the choices are different ones, equally likely. Either is conformant; the cases are `statistical`.
- **Goldens that exercise the glitch.** The golden frame is 16 × 12, a single block at the default block size, and at the default coverage that block is not chosen at either default clock. Six further cases use coverage 1, so that every block glitches whatever the hash gives, and the smallest block (8 px: 2 columns by 1.5 rows of blocks) at clocks 0.3, 0.75, 1.1 and 2.5 s (steps T = 2, 6, 8, 20; with speed 4, T = 16), plus one at 8.75 s with the default block, whose step 70 wraps to T = 6 and so equals the 0.75 s pattern. They show the row shift, the vertical jump, the RGB split and all three corruption modes.
- **Step boundary rounding:** as for gpu-color-glitch, (t · speed) · 8 is evaluated in binary32; frames whose time is an exact step multiple may resolve to the previous step. Use binary32 and the same evaluation order.
- Block grid depends on resolution (pixel-sized blocks), so a proxy-resolution preview shows a different number of blocks from a full-resolution export (implementation-defined, observed).
- coverage = 0: no block glitches (output = input). coverage = 1: all blocks glitch.
