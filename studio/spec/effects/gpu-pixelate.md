# gpu-pixelate

| | |
|---|---|
| Category | distort |
| Temporal | no |
| Pass | 1 fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
Divides the frame into square blocks of `size` × `size` output pixels anchored at the top-left corner, and fills each block with one bilinear sample taken at the block's centre.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| size | number | 1..64 (step 1, animatable) | 8 | output pixels | block edge length |

Mapping (after [C9]; missing → default):
- s = size (NOT rounded; fractional sizes from interpolation are used as-is).
- block size in uv: bx = s/W, by = s/H.

## Per-pixel definition
For output pixel (i, j) with uv = (u, v) from [C1]:

1. Block-centre coordinate:
   - u' = floor(u / bx) · bx + bx/2
   - v' = floor(v / by) · by + by/2
   Equivalently in pixels: block index kx = floor((i + 0.5)/s), ky = floor((j + 0.5)/s); sample point in texel space x = kx·s + s/2 − 0.5, y = ky·s + s/2 − 0.5 (texel centres at integers).
2. SDR: output S(u', v') [C2].
   HDR: output HDR-OUT(PB(u', v')) [C4].

For integer s: odd s puts the sample exactly on a texel centre (a copy of that texel); even s puts it exactly between four texels (equal 0.25 weights of the 2×2 block at the centre).

## Edges
The last block on the right/bottom may be partial. Its centre can fall outside the frame (or on the last half texel); bilinear indices are clamped to the edge [C2], so such blocks take edge texel values. There is no centring of the grid.

## Alpha
SDR: straight RGBA from hardware bilinear filtering (for even sizes, RGB of transparent texels contributes). HDR: premultiplied bilinear tap; alpha rounded to binary16; RGB = Σ(w·RGB·A)/Σ(w·A); zero coverage → (0,0,0,0).

## SDR and HDR
Identical block geometry. SDR: hardware straight-RGBA bilinear sample, encoded values, no clamp. HDR: explicit premultiplied bilinear, HDR-OUT (±65504 RGB clamp, headroom kept).


HDR helpers used above (the [C4] blur sampling and output, stated here so this file is self-contained):
- PB(q), premultiplied bilinear tap at uv q: x = q.u·W − 0.5, y = q.v·H − 0.5; x0 = floor(x), y0 = floor(y), fx = x − x0, fy = y − y0. For dx, dy ∈ {0, 1}: texel T = F(clamp(x0+dx, 0, W−1), clamp(y0+dy, 0, H−1)), weight ω = (dx ? fx : 1−fx)·(dy ? fy : 1−fy). PB(q) = Σ ω·(T.r·T.a, T.g·T.a, T.b·T.a, T.a).
- HDR-OUT(c) for an accumulated premultiplied (r, g, b, a): α = clamp(a, 0, 1); κ = α rounded to the nearest binary16 value, ties to even, with binary16 subnormals kept (multiples of 2⁻²⁴; anything ≤ 2⁻²⁵ becomes 0). If κ ≤ 0 output (0, 0, 0, 0); otherwise output (clamp(r/a, −65504, 65504), clamp(g/a, …), clamp(b/a, …), κ). The division uses the unrounded a.

## Notes
- For integer s, (i + 0.5)/s is never an integer, so block membership is unambiguous in float. For fractional s, pixels whose (i + 0.5)/s is within float rounding of an integer may fall in either block (implementation-defined).
- The block centre is computed in 32-bit float uv and converted back to texel space, so for even s the bilinear fraction is 0.5 only up to float rounding (HDR uses that fraction directly; SDR hardware filtering quantises it). The result is the 2×2 mean in practice, within float tolerance.
