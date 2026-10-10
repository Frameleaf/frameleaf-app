# gpu-blocks

| | |
|---|---|
| Category | distort |
| Temporal | no |
| Pass | one full-frame pass, one input; 1 bilinear sample per pixel |
| HDR | refused ([C4]) |

## What it does

Turns the picture into toy building bricks: the frame is pixelated into square blocks of a given pixel size, each block takes the colour sampled at its centre, gets a diagonal bevel (lit from the top-left), a raised round stud in the middle with its own bevel, and a darkened mortar gap along its border.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| size | number | 4 .. 120 | 24 | output pixels | block edge length |
| depth | number | 0 .. 1.5 | 0.5 | - | bevel and stud shading strength |
| studSize | number | 0 .. 1 | 0.55 | - | stud radius (0.4 block widths at 1) |
| gap | number | 0 .. 0.4 | 0.06 | block widths | mortar width on each side |

### Mapping to internal quantities

Numbers are sanitised per [C9], then rounded to binary32; an absent key takes the table default.

- s = max(size, 1) pixels; cx = s / W, cy = s / H (cell size in uv; W and H are the output dimensions as binary32, used without a guard).
- dp = depth (no further clamp).
- sr = clamp(studSize, 0, 1) · 0.4.
- gp = clamp(gap, 0, 0.4).

## Per-pixel definition

uv per [C1].

1. Cell index k = (floor(u / cx), floor(v / cy)).
2. Cell centre c = ((k.x + 0.5) · cx, (k.y + 0.5) · cy); col = S(c) (straight RGBA).
3. Local position l = (fract(u / cx), fract(v / cy)) - 0.5 (each in [-0.5, 0.5)); in pixel terms u / cx = (i + 0.5) / s.
4. edge = max(|l.x|, |l.y|).
5. shade = (-l.x - l.y) · dp.
6. stud = smoothstep(sr, sr - 0.03, length(l)), evaluated with the plain Hermite formula although the edges are reversed: t = clamp((length(l) - sr) / (-0.03), 0, 1), stud = t · t · (3 - 2 · t). So stud = 1 for length(l) <= sr - 0.03 and 0 for length(l) >= sr.
7. studShade = stud · ((-l.x - l.y) · dp · 2 + dp · 0.18).
8. rgb = col.rgb · (1 + shade) + col.rgb · studShade.
9. gapMask = 1 if edge <= 0.5 - gp, else 0 (step).
10. rgb = rgb · mix(0.55, 1, gapMask) (mortar is multiplied by 0.55).
11. Output (clamp(rgb, 0, 1), col.a).

## Edges

The block grid is anchored at the top-left. The last column/row is partial when W or H is not a multiple of s; its centre then lies at or beyond the frame edge and the sample reads the clamped edge texel ([C2]). The cell-centre sample is bilinear: the centre lies at texel coordinate (k + 0.5) · s - 0.5, so for even s it falls halfway between two texels on each axis and the colour is the average of a 2x2 texel block; for odd s it hits one texel exactly.

## Alpha

Output alpha = alpha of the cell-centre sample (constant over the block). RGB is computed normally where alpha = 0 (shading applied to the sampled straight RGB), not zeroed.

## SDR and HDR

SDR: RGB clamped to [0,1]; alpha passes through. HDR projects: refused ([C4]).

## Notes

- "Light from the top-left": v grows downward, so shade is positive in the upper-left part of the block.
- For studSize below 0.075 the inner edge sr - 0.03 is negative; the formula in step 6 still applies (a faint stud for small positive sr, none for sr = 0).
- The gap test uses step semantics: a pixel whose edge equals 0.5 - gp exactly is NOT mortar.
- Precision: no transcendental functions. Pixel-exactness depends only on binary32 evaluation of (i + 0.5) / s via u / (s / W) (for integer s a pixel centre can never fall exactly on a block boundary because pixel centres are at half-integers; but rounding of s / W may move the bilinear centre by about 1e-7 uv, which matters only for the 2x2 averaging weights at even s).
