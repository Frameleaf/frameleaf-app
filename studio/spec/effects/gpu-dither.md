# gpu-dither

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single full-frame fragment pass, output size = input size (W × H); exact texel fetches only |
| HDR | refused [C4] |

## What it does
Reduces the frame to a 2- or 4-colour retro palette on a grid of square cells. Each cell gets one brightness (averaged from four points inside it), optionally blended with a linear or radial gradient, then either ordered-dithered against a threshold pattern ("threshold" style) or turned into a dot whose size follows darkness ("scaled" style). The cell is drawn as a circle, square or diamond of the chosen palette colour on the palette's lightest colour.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| pattern | select | bayer2, bayer4, bayer8, halftone, lines, crosses, dots, grid, scales | bayer4 | — | threshold pattern (threshold style only) |
| mode | select | image, linear, radial | image | — | brightness source blend |
| style | select | threshold, scaled | threshold | — | quantisation style |
| shape | select | circle, square, diamond | square | — | cell mark shape |
| palette | select | bw, gameboy, cga, sepia | gameboy | — | output palette |
| cellSize | number | 2 – 32 | 8 | px | cell edge length c |
| angle | number | 0 – 360 | 45 | degrees | gradient direction (mode = linear only) |
| scale | number | 25 – 200 | 100 | % | radial gradient scale (mode = radial only) |
| offsetX | number | −100 – 100 | 0 | % of frame | radial centre offset (mode = radial only) |
| offsetY | number | −100 – 100 | 0 | % of frame | radial centre offset (mode = radial only) |

Sanitised per [C9]. An absent key uses its default. cellSize may be fractional (keyframe interpolation); it is used as a real number.

Internal quantities (binary32): c = max(cellSize, 1); grid size G = (max(1, ceil(W/c)), max(1, ceil(H/c))); pattern period (in cells) ps = max(2, floor(c · 0.5)); θ = angle · 3.14159265359 / 180.

### Palettes (exact binary32 values used; byte equivalents for reference)
| palette | index 0 | index 1 | index 2 | index 3 |
|---|---|---|---|---|
| bw | (0, 0, 0) | (1, 1, 1) | — | — |
| gameboy | (0.0588, 0.2196, 0.0588) ≈ #0f380f | (0.1882, 0.3843, 0.1882) ≈ #306230 | (0.5451, 0.6745, 0.0588) ≈ #8bac0f | (0.6078, 0.7373, 0.0588) ≈ #9bbc0f |
| cga | (0, 0, 0) | (0.3333, 1, 1) ≈ #55ffff | (1, 0.3333, 1) ≈ #ff55ff | (1, 1, 1) |
| sepia | (0.1686, 0.1137, 0.0549) ≈ #2b1d0e | (0.4196, 0.2588, 0.1490) ≈ #6b4226 | (0.7686, 0.5843, 0.4157) ≈ #c4956a | (0.9608, 0.9020, 0.7843) ≈ #f5e6c8 |

The decimal values are authoritative (they are not exact byte/255 values). Background colour BG = last index (bw: index 1 = white; others: index 3).

Palette index of a value q: bw → 0 if q ≤ 0.5 else 1. Others → 0 if q ≤ 0.25, 1 if q ≤ 0.5, 2 if q ≤ 0.75, else 3.

### Threshold patterns T(cx, cy) for integer cell (cx, cy) ≥ 0
Bayer 2×2 matrix M2 (row = cy mod 2, column = cx mod 2); T = (M2 + 0.5)/4:
```
0 2
3 1
```
Bayer 4×4 matrix M4 (row = cy mod 4, column = cx mod 4); T = (M4 + 0.5)/16:
```
 0  8  2 10
12  4 14  6
 3 11  1  9
15  7 13  5
```
"bayer8" matrix M8 (row = cy mod 8, column = cx mod 8); T = (M8 + 0.5)/64. It is built as 4·M4[cy mod 4][cx mod 4] + o, with o = 0 for the top-left quadrant, 2 for top-right, 3 for bottom-left and **2** for bottom-right (implementation-defined: not a true Bayer 8×8 — some values repeat, 1/5/9/… never occur). Exact matrix:
```
 0 32  8 40  2 34 10 42
48 16 56 24 50 18 58 26
12 44  4 36 14 46  6 38
60 28 52 20 62 30 54 22
 3 35 11 43  2 34 10 42
51 19 59 27 50 18 58 26
15 47  7 39 14 46  6 38
63 31 55 23 62 30 54 22
```
Procedural patterns: nx = fract(cx/ps), ny = fract(cy/ps) (ps ≥ 2, so the pattern repeats every ps cells):
- halftone, dots: T = sqrt((nx − 0.5)² + (ny − 0.5)²) · 1.41421356237.
- lines: T = ny.
- crosses: T = min(|nx − 0.5|, |ny − 0.5|) · 2.
- grid: T = max(|nx − 0.5|, |ny − 0.5|) · 2.
- scales: sx = fract(2·nx), sy = fract(2·ny); T = sqrt((sx − 0.5)² + (sy − 0.5)²) · 1.41421356237.

(halftone and dots are identical.)

## Per-pixel definition
1. p = uv · (W, H) = (i + 0.5, j + 0.5). base = F(i, j). If base.a ≤ 0.0001 → output (0, 0, 0, 0) and stop.
2. cell = floor(p / c) = (cx, cy); local = fract(p / c).
3. Cell brightness b: for each offset o in {(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)}: s = F(clampW(trunc((cx + o.x)·c)), clampH(trunc((cy + o.y)·c))) where clampW clamps to [0, W−1], clampH to [0, H−1]. Sum Ls += LUMA601(s.rgb)·s.a [C7] and As += s.a. b = 0 if As ≤ 0.0001, else Ls / As.
4. Mode (nx = cx / max(G.x, 1), ny = cy / max(G.y, 1)):
   - image: unchanged.
   - linear: b = clamp(0.7·b + 0.3·(nx·cos θ + ny·sin θ), 0, 1).
   - radial: dist = length(nx − (0.5 + offsetX/100), ny − (0.5 + offsetY/100)) · (scale/100) · 2; b = clamp(0.7·b + 0.3·dist, 0, 1).
5. Style:
   - threshold: q = clamp(b + (T(cx, cy) − 0.5)·0.5, 0, 1); size factor z = 1.
   - scaled: q = b; z = 1 − b. (pattern unused.)
6. FG = palette colour at index(q); BG as above.
7. Shape mask: e = |local − 0.5|·2 (component-wise); r = clamp(z, 0, 1); aa = max(1 / max(c, 1), 0.003).
   - circle: m = 1 − smoothstep(r, r + aa, length(e)).
   - diamond: m = 1 − smoothstep(r, r + aa, e.x + e.y).
   - square: m = 1 − smoothstep(r, r + aa, max(e.x, e.y)).
8. Output = (mix(BG, FG, m), base.a).

Note: in threshold style with square shape, m = 1 everywhere (e ≤ 1), so cells are solid FG. Circle/diamond leave BG in the corners even in threshold style.

## Edges
Cell sample points beyond the frame (partial cells at the right/bottom) are clamped to the last row/column. Cells are anchored at the top-left pixel corner (0, 0); partial cells occur at the right and bottom only.

## Alpha
Pixels with alpha ≤ 0.0001 become (0, 0, 0, 0). Otherwise alpha passes through and RGB is a palette colour (straight). Cell brightness is alpha-weighted (transparent sample points do not contribute; a fully transparent cell has b = 0).

## SDR and HDR
SDR: luma of sRGB-encoded values; outputs are palette constants [C3]. HDR: refused [C4].

## Notes
- Fully specifiable; the only transcendental use is cos/sin in linear mode (constant per frame) and sqrt — reproducible to rounding.
- Comparisons q ≤ 0.25 / 0.5 / 0.75 are inclusive at the boundary (value exactly 0.5 maps to the lower index).
- trunc in step 3 equals floor because the arguments are non-negative.
- Option codes used for unknown/absent selects fall back to the defaults (bayer4, image, threshold, square, gameboy).
