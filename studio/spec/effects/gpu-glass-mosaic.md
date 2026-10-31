# gpu-glass-mosaic

| | |
|---|---|
| Category | distort |
| Temporal | no |
| Pass | one full-frame pass, one input; 1 bilinear sample per pixel, 4 when `aberration` > 0 |
| HDR | refused ([C4]) |

## What it does

A wall of square glass blocks (privacy glass). The frame is divided into square cells; each cell acts as a spherical lens that magnifies its own patch towards the cell centre, fading out towards the cell rim. Each tile gets a diagonal bevel (lit from the top-left), a bright line just inside its border, a dark mortar line at the seam and a mild darkening towards the rim. Optional chromatic aberration splits red and blue radially within each cell.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| colorShadow | color | - | `#000000` | sRGB hex + alpha | mortar/rim shadow colour |
| colorHighlight | color | - | `#ffffff` | sRGB hex + alpha | bevel highlight colour |
| amount | number | 0 .. 1 | 0.55 | - | lens magnification and bevel strength |
| cells | number | 2 .. 80 | 18 | columns | number of cells across the frame width |
| shadows | number | 0 .. 1 | 0.3 | - | shadow strength |
| highlights | number | 0 .. 1 | 0.12 | - | highlight strength |
| aberration | number | 0 .. 1 | 0 | - | chromatic split |

### Mapping to internal quantities

Numbers are sanitised per [C9], then rounded to binary32; an absent key takes the table default.

- Sc = HEXCOLOR(colorShadow, fallback (0, 0, 0, 1)); Hc = HEXCOLOR(colorHighlight, fallback (1, 1, 1, 1)).
- am = amount (no further clamp); n = max(cells, 1); shA = clamp(shadows, 0, 1); hlA = clamp(highlights, 0, 1); ab = aberration.
- a = max(W / max(H, 1), 0.0001).

### HEXCOLOR(s, fallback)

1. If s does not start with `#`, return fallback. Let h = s without the `#`.
2. h of 3 or 4 characters: each character c gives HEXPAIR(c c) / 255 (character doubled). If the first three are finite return (v1, v2, v3, v4 or 1); else fallback. The 4th value is not checked (invalid 4th character gives alpha NaN; implementation-defined).
3. h of 6 or 8 characters: HEXPAIR of characters 0-1, 2-3, 4-5 (and 6-7, else alpha 1), each / 255; all four finite, else fallback.
4. Any other length: fallback.

HEXPAIR(p): lenient base-16 parse: skip leading white space, optional `+`/`-`, optional `0x`/`0X`, then the longest run of hex digits (case-insensitive); no digits gives NaN. So `1z` -> 1, `-f` -> -15 in the 6/8-digit forms (implementation-defined, kept for parity). Values are used directly as sRGB-encoded numbers.

## Per-pixel definition

uv per [C1]. FW(f) is the coarse screen-space derivative width of [C10]. pow(0, y > 0) = 0.

1. Cell size in uv: cs = (1 / n, a / n) (square in pixels: W / n pixels each way).
2. g = uv / cs = (u · n, v · n / a); l = fract(g) - 0.5 (each component in [-0.5, 0.5)); lu = l · cs (per component).
3. dd = (2 · l.x)^2 + (2 · l.y)^2.
4. lens = am · (clamp(1 - dd, 0, 1))^0.5.
5. sp = uv - lu · lens.
6. Sample:
   - if ab > 0: ca = lu · ab; R = S(sp - ca).r; G = S(sp).g; Bc = S(sp + ca).b; A = S(sp).a; col = (R, G, Bc, A).
   - else col = S(sp).
7. edge = 2 · max(|l.x|, |l.y|) (0 at the cell centre, 1 at the rim).
8. fw = FW(edge) + 0.001.
9. hl = smoothstep(1 - 6 · fw, 1 - 2 · fw, edge) · hlA.
10. gap = smoothstep(1 - 2 · fw, 1, edge).
11. sh = clamp((edge^3 · 0.5 + gap) · shA, 0, 1).
12. bevel = (-l.x - l.y) · am · 0.5.
13. rgb = col.rgb · (1 + bevel); rgb = mix(rgb, Sc.rgb, 0.5 · sh · Sc.a); rgb = rgb + Hc.rgb · hl · Hc.a; rgb = clamp(rgb, 0, 1).
14. Output (rgb, col.a).

## Edges

The grid is anchored at the top-left corner (u = 0, v = 0). There are n columns across the width (a partial column at the right when n is fractional, e.g. during keyframe interpolation) and n / a rows down the height, so the bottom row is usually partial. Sample coordinates stay within the pixel's own cell region shrunk towards its centre and therefore within [0,1] apart from aberration offsets; anything outside reads the edge texel ([C2]).

## Alpha

Output alpha = the alpha sampled at sp. RGB is computed normally where alpha = 0 (bevel, shadow, highlight applied to the sampled straight RGB); it is not zeroed.

## SDR and HDR

SDR: RGB clamped to [0,1]; alpha passes through. HDR projects: refused ([C4]).

## Notes

- Lens radius: magnification acts only inside the inscribed circle of each cell (dd < 1); in the cell corners lens = 0 (no displacement).
- "Light from the top-left": with v growing downward, bevel is positive where l.x and l.y are negative, i.e. in the upper-left of each tile.
- FW(edge): inside a cell, edge is piecewise linear with per-pixel slope 2 · n / W, so FW(edge) = 2 · n / W except on the cell diagonals (where the max switches) and in 2x2 quads that straddle a cell seam (where fract jumps and FW(edge) is close to 2). In seam quads the highlight and gap ramps therefore widen to cover the whole quad. The coarse quads of [C10] reproduce the canonical goldens exactly. GPUs that use fine derivatives differ only in seam quads, which the `edge` tolerances cover.
- Precision: only one pow and simple arithmetic; not sensitive to transcendental precision. fract of g near exact cell boundaries is binary32 and can put a boundary pixel in the neighbouring cell on a different GPU (rare).
