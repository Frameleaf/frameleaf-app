# gpu-droste

| | |
|---|---|
| Category | distort |
| Temporal | no |
| Pass | one full-frame pass, one input; 1 bilinear sample per pixel |
| HDR | refused ([C4]) |

## What it does

An Escher/Droste-style recursive zoom. Each pixel is mapped into log-polar coordinates around a centre, optionally sheared into a logarithmic spiral, the log-radius is folded into one repeating band of width ln(scale), and the result is mapped back to a sample position. Sample positions are wrapped into the unit square, so the source is effectively repeated periodically.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| strength | number | 0 .. 2 | 1 | - | spiral twist (UI label "Spiral"): 0 = plain recursive zoom, 1 = seamless Escher spiral |
| scale | number | 1.1 .. 6 | 2 | ratio | zoom ratio between successive copies |
| centerX | number | 0 .. 1 | 0.5 | uv | centre, horizontal |
| centerY | number | 0 .. 1 | 0.5 | uv | centre, vertical (0 = top) |
| spin | number | -6.28318 .. 6.28318 | 0 | radians | rotation added after the spiral mapping |

### Mapping to internal quantities

Numbers are sanitised per [C9], then rounded to binary32; an absent key takes the table default.

- a = W / max(H, 1) (computed on the GPU in binary32).
- c = (centerX, centerY).
- L = ln(max(scale, 1.0001)).
- al = atan2(L, TAU) clamp(strength, 0, 2), TAU = 6.28318530718.
- co = max(cos al, 0.001); si = sin al.

## Per-pixel definition

uv per [C1].

1. p = ((u - c.x) a, v - c.y).
2. r = max(length(p), 0.0001); th = atan2(p.y, p.x) (range (-PI, PI]).
3. z = (ln r, th).
4. Spiral shear: z' = ((z.x co - z.y si) / co, (z.x si + z.y co) / co).
5. Fold the log-radius: zx = z'.x - L floor(z'.x / L) (so zx in [0, L)).
6. R = exp(zx); ang = z'.y + spin.
7. q = (c.x + cos(ang) R / a, c.y + sin(ang) R).
8. Output = S(fract(q)) (all four channels, componentwise fract).

## Edges

Because zx is in [0, L), the sample radius R lies in [1, scale) frame heights (aspect-corrected) from the centre. For a centred origin this is almost entirely outside the visible frame (only the corners of wide frames, beyond 1 frame height from the centre, are inside), so most of the picture is reconstructed from fract-wrapped coordinates, i.e. from a periodic tiling of the source. Kept as observed. Bilinear sampling at fract(q) close to 0 or 1 is clamp-to-edge ([C2]), so the wrap seam is not filtered across: neighbouring output pixels whose q straddle an integer read from opposite edges with no blending.

## Alpha

Output alpha = sampled alpha; RGB = sampled straight RGB. Nothing is computed separately for alpha = 0.

## SDR and HDR

SDR: no clamp is applied (the output is a bilinear blend of input texels, so it stays within the input's range). HDR projects: refused ([C4]).

## Notes

- Seam at the negative x axis: th jumps by 2 PI across the ray to the left of the centre (p.y = 0, p.x < 0). After the shear, z'.x jumps by 2 PI tan(al) there (z'.y also jumps by 2 PI, which cos/sin absorb). For strength = 1, tan(al) = L / TAU, so the jump is exactly one fold period L and the image is seamless (up to rounding). At strength 0 the jump is 0 (no seam, plain radial repetition). For any other strength the jump is not a multiple of L and a visible seam appears along that ray. Kept as observed.
- At the exact centre r is clamped to 0.0001 (ln r = -9.21).
- Precision: this effect depends strongly on GPU transcendental precision: atan2, ln, exp, sin, cos in binary32, then floor of z'.x / L and fract of the final coordinate. Near the fold boundary (z'.x close to a multiple of L) and the fract seams, ULP-level differences flip a pixel between two very different source positions, so a few pixels per frame can legitimately differ between GPUs. Exact match is only achievable away from those discontinuities.
