# gpu-ascii

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single full-frame fragment pass, output size = input size (W × H), plus one auxiliary rgba8 data texture (glyph atlas) |
| HDR | refused [C4] |

## What it does
Renders the frame as a grid of text characters. Each cell's brightness (or edge strength) picks a character from a ramp; the character is drawn in the cell's source colour or a fixed text colour over a background colour (or over transparency). Two glyph families exist:
- **Atlas character sets** (ascii, dense, binary, symbols, custom): real font glyphs rasterised once into a strip texture.
- **Shape character sets** (standard, simple, blocks, dots, minimal): procedural glyph-like masks defined exactly below.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| charSet | select | ascii, dense, binary, symbols, custom, standard, simple, blocks, dots, minimal | ascii | — | character set |
| customChars | text | any string | "FREECUT 01" | — | ramp for charSet = custom (dense → light) |
| font | select | monospace, courier, consolas, lucida | monospace | — | font for atlas sets |
| fontSize | number | 4 – 24 | 8 | px | cell scale |
| letterSpacing | number | −2 – 5 | 0 | — | widens/narrows cells |
| lineHeight | number | 0.5 – 2 | 1 | × fontSize | cell height factor |
| matchSourceColor | boolean | — | true | — | glyphs take the cell's source colour |
| textColor | color | — | #ffffff | sRGB hex | glyph colour when not matching source |
| bgColor | color | — | #0a0a0f | sRGB hex | background colour (opaque mode) |
| transparentBg | boolean | — | false | — | background becomes transparent |
| edgeDetect | boolean | — | false | — | density from Sobel edges instead of tone |
| colorSaturation | number | 0 – 200 | 100 | % | saturation of source-coloured glyphs |
| asciiOpacity | number | 0 – 100 | 100 | % | glyph opacity |
| originalOpacity | number | 0 – 100 | 0 | % | amount of the (adjusted) original shown under glyphs |
| contrast | number | 50 – 200 | 100 | % | contrast applied before sampling |
| brightness | number | −100 – 100 | 0 | 1/255 units | brightness offset |
| invert | boolean | — | false | — | invert density |

Sanitised per [C9]; customChars passes through. An absent key uses its default, with these exceptions: matchSourceColor is treated as true unless it is exactly false; invert, transparentBg and edgeDetect are true only if exactly true; an absent customChars counts as the empty string (see Ramp).

**Colour strings** (textColor, bgColor): same parsing as gpu-halftone (must start with `#`; 3/4 or 6/8 hex digits; otherwise fallback to the default colour). **Only RGB is used; colour alpha is ignored.**

Internal quantities (binary32):
- kc = contrast / 100; kb = brightness / 255; ks = colorSaturation / 100; oa = asciiOpacity / 100; oo = originalOpacity / 100.
- charAspect = max(0.25, 0.6 + 0.05·letterSpacing) (in range 0.5 – 0.85).
- cw = max(fontSize · charAspect, 1); ch = max(fontSize · max(lineHeight, 0.25), 1).
- cols = max(1, floor(W / cw)); rows = max(1, floor(H / ch)).
- Grid extent E = (cols·cw, rows·ch); origin O = ((W, H) − E) / 2 (grid centred; may be fractional).

### Ramp (atlas sets)
Ramps are ordered **dense → light**; index 0 is used for the darkest (lowest density) cells.

| charSet | n | ramp, index 0 first (␠ = space U+0020) |
|---|---|---|
| ascii | 10 | `@` `%` `#` `*` `+` `=` `-` `:` `.` ␠ |
| dense | 17 | `@` `W` `B` `#` `$` `o` `a` `h` `k` `b` `n` `+` `=` `-` `:` `.` ␠ |
| binary | 2 | `0` `1` |
| symbols | 14 | `#` `@` `&` `$` `%` `*` `+` `!` `=` `;` `:` `-` `.` ␠ |
| custom | ≤ 64 | the first 64 Unicode code points of customChars (surrogate pairs count as one; combining marks and joiner sequences are separate entries). Default "FREECUT 01" → `F` `R` `E` `E` `C` `U` `T` ␠ `0` `1` |

If charSet = custom and customChars is empty (or absent), the effect uses the **standard shape set** instead (implementation-defined: not the default text).

### Glyph atlas (CPU side)
For an atlas set with n glyphs, a texture of (24·n) × 24 texels is built, one 24 × 24 cell per glyph, glyph k in columns 24k … 24k+23:
- Canvas cleared to transparent; fill colour white; font size round(24 × 0.82) = **20 px**; font family stack by `font`:
  - monospace: generic `monospace`
  - courier: "Courier New", Courier, monospace
  - consolas: Consolas, "Lucida Console", monospace
  - lucida: "Lucida Console", Monaco, monospace
- Each glyph drawn with horizontal centre alignment at x = 24k + 12 and vertical "middle" baseline at y = 13 (pixel-corner coordinates, y down).
- The rasterised alpha (0–255) is stored in all four channels; the shader uses it as coverage A_atlas = byte / 255.
- If no 2-D canvas is available, every texel is 255 (each cell renders as a solid block).

## Per-pixel definition
ADJ(c) = clamp((c − 0.5)·kc + 0.5 + kb, 0, 1) (per channel). Fetches are exact texel loads F at trunc of the position, clamped to [0, W−1] × [0, H−1].

1. p = (i + 0.5, j + 0.5). base = F(i, j). If base.a ≤ 0.0001 → output (0, 0, 0, 0) and stop.
2. A = ADJ(base.rgb). Back = mix(bgColor.rgb, A, oo).
3. If p is outside [O.x, O.x + E.x) × [O.y, O.y + E.y) (grid letterbox):
   - transparentBg: output (A, base.a · oo).
   - else: output (Back, base.a).
4. g = (p − O) / (cw, ch); cell = floor(g); local = fract(g) = (lu, lv).
5. sp = O + (cell + 0.5)·(cw, ch). sc = F(trunc(sp)) (clamped). As = ADJ(sc.rgb).
6. Density D = LUMA601(As) [C7]. If edgeDetect: D = clamp(length(gx, gy), 0, 1) with Sobel on **unadjusted** source luma, step (sx, sy) = (max(cw, 1), max(ch, 1)); define Y(dx, dy) = LUMA601(F(trunc(sp + (dx·sx, dy·sy))).rgb) (clamped), gx = (Y(1,−1) + 2Y(1,0) + Y(1,1)) − (Y(−1,−1) + 2Y(−1,0) + Y(−1,1)), gy = (Y(−1,1) + 2Y(0,1) + Y(1,1)) − (Y(−1,−1) + 2Y(0,−1) + Y(1,−1)).
7. If invert: D = 1 − D.
8. Mask m:
   - **Atlas set** (n ≥ 1): k = clamp(floor(D·n), 0, n − 1); lx = clamp(lu, 0.04, 0.96); m = alpha of the atlas sampled bilinearly (clamp-to-edge) at ((k + lx)/n, lv).
   - **Shape set**: m from the shape tables below with blur β = max(0.5 / min(cw, ch), 0.002).
9. Glyph colour Gc = textColor.rgb, or if matchSourceColor: y = LUMA601(As); Gc = clamp(y + (As − y)·ks, 0, 1).
10. ink = clamp(m · oa, 0, 1).
11. transparentBg: ua = oo·(1 − ink); oa2 = ink + ua; rgb = (Gc·ink + A·ua) / max(oa2, 0.0001); output (rgb, base.a · oa2).
    Opaque: output (mix(Back, Gc, ink), base.a).

### Shape sets
Glyph count n_s and index: standard 10, simple 6, blocks 5, dots 4, minimal 3; index t = clamp(floor(clamp(D, 0, 1)·(n_s − 1)), 0, n_s − 1). **Index 0 (lowest density, i.e. dark cells) is empty** — the opposite visual convention of the atlas ramps.

Primitives in cell space (lu, lv), v down; P = (lu, lv):
- CIRC(c, r) = 1 − smoothstep(r, r + β, |P − c|).
- BOX(c, h) = 1 − smoothstep(0, β, max(|P.x − c.x| − h.x, |P.y − c.y| − h.y)).
- LINE(a, b, w): h = clamp(((P − a)·(b − a)) / max(|b − a|², 0.0001), 0, 1); dist = |P − a − (b − a)·h|; value 1 − smoothstep(w, w + β, dist).
- RING(c, ro, ri) = clamp(CIRC(c, ro) − CIRC(c, ri), 0, 1).
- Sums are clamped to [0, 1].

**standard** (t: mask):
| t | shape (resembles) | mask |
|---|---|---|
| 0 | blank | 0 |
| 1 | `.` | CIRC((0.5, 0.76), 0.06) |
| 2 | `:` | CIRC((0.5, 0.34), 0.05) + CIRC((0.5, 0.72), 0.05) |
| 3 | `-` | BOX((0.5, 0.56), (0.23, 0.05)) |
| 4 | `=` | BOX((0.5, 0.38), (0.23, 0.04)) + BOX((0.5, 0.66), (0.23, 0.04)) |
| 5 | `+` | BOX((0.5, 0.52), (0.23, 0.04)) + BOX((0.5, 0.52), (0.04, 0.23)) |
| 6 | `*` | BOX((0.5, 0.52), (0.22, 0.035)) + BOX((0.5, 0.52), (0.035, 0.22)) + LINE((0.22, 0.22), (0.78, 0.78), 0.03) + LINE((0.78, 0.22), (0.22, 0.78), 0.03) |
| 7 | `#` | BOX((0.34, 0.52), (0.03, 0.26)) + BOX((0.66, 0.52), (0.03, 0.26)) + BOX((0.5, 0.36), (0.24, 0.03)) + BOX((0.5, 0.68), (0.24, 0.03)) |
| 8 | `%` | LINE((0.18, 0.82), (0.82, 0.18), 0.03) + RING((0.3, 0.3), 0.12, 0.065) + RING((0.7, 0.7), 0.12, 0.065) |
| 9 | `@` | RING((0.5, 0.5), 0.34, 0.19) + CIRC((0.55, 0.49), 0.1) + LINE((0.53, 0.52), (0.74, 0.58), 0.035) |

**simple**: t = 0…5 maps to standard glyphs 0, 1, 3, 5, 6, 7 (blank, `.`, `-`, `+`, `*`, `#`).

**blocks** (no anti-aliasing): t = 0 → 0; t = 4 → 1 (solid); t = 1, 2, 3 → density δ = 0.25, 0.5, 0.75; with (a, b) = floor((lu, lv)·4) (0…3), m = 1 if δ > (M4[b][a] + 0.5)/16 else 0, where M4 is the Bayer 4×4 matrix (row b, column a):
```
 0  8  2 10
12  4 14  6
 3 11  1  9
15  7 13  5
```
**dots**: t = 0 → 0; 1 → CIRC((0.5, 0.56), 0.05); 2 → CIRC((0.5, 0.54), 0.1); 3 → CIRC((0.5, 0.52), 0.16).

**minimal**: t = 0 → 0; 1 → CIRC((0.5, 0.58), 0.055); 2 → LINE((0.24, 0.24), (0.76, 0.76), 0.035) + LINE((0.76, 0.24), (0.24, 0.76), 0.035) (an ×).

## Edges
- All source fetches clamp to the frame. Cells are centred: the leftover W − cols·cw (and H − rows·ch) is split equally into left/right (top/bottom) letterbox bands that contain no glyphs (step 3).
- Edge-detect neighbours are one whole cell away and clamp at the frame.
- Atlas sampling clamps lu to [0.04, 0.96] so bilinear filtering does not bleed from the neighbouring glyph horizontally; vertically lv spans the full cell height and the atlas row clamps at its edges.

## Alpha
- Source alpha ≤ 0.0001 → (0, 0, 0, 0).
- Opaque mode: alpha passes through; every visible pixel is filled with background or glyph.
- Transparent mode: output alpha = base.a · (ink + oo·(1 − ink)); with oo = 0 only glyph coverage remains, and where it is 0 the output is (0, 0, 0, 0) (RGB is 0 because of the division guard).
- Colours are straight; no premultiplication. Cell colour sampling ignores the alpha of the sampled texel.

## SDR and HDR
SDR: all arithmetic on sRGB-encoded values, values clamped to [0, 1] [C3]. HDR: refused [C4].

## Notes
- **Not pixel-specifiable for atlas sets.** Glyph coverage comes from the platform's 2-D text rasteriser (font resolution, fallback font choice, hinting, anti-aliasing, sub-pixel positioning, exact meaning of the "middle" baseline). Everything else — cell grid, character choice, colours, opacity mixing — is exact. A native implementation should rasterise each ramp character white on transparent at 20 px into a 24 × 24 cell, centred horizontally at 12 and vertically with the font's middle baseline at 13, and use the coverage as alpha; results will match visually, not bit-exactly. The named fonts may be unavailable on iOS/Android; the fallback is the platform monospace face.
- **Atlas-aware numeric check:** font-atlas coverage is an explicit platform input. The engine drift gate independently rasterises the documented atlas on that platform and requires byte equality with the production input, then applies the per-pixel equations above in an independent CPU reference and compares the complete frame within the existing pixel tolerance. Stored Mac goldens retain their original output bytes and identify their rasterising platform. Shape cases continue to use those fixed-output goldens.
- **Coverage under the division guard:** in transparent mode with oo = 0, step 11 gives rgb = Gc · min(ink / 0.0001, 1). A sampler that returns 0.000001 instead of 0 at a texel centre next to an inked texel therefore changes RGB by 0.01 while alpha stays near 0. Bilinear weight precision is not specifiable, so where the reference coverage is under 0.0001 the check accepts rgb = t · Gc for one t in [0, 1] within the pixel tolerance, and t < 1 only with a rendered alpha of at most 0.0001. Alpha is compared as everywhere else. A native implementation may write any such t for these invisible pixels.
- Shape sets are fully specifiable (smoothstep/sqrt only).
- Atlas glyph index uses floor(D·n) over n levels (D = 1 clamps to n − 1); shape sets use floor(D·(n_s − 1)), so only D = 1 reaches the last shape glyph.
- Brightness unit: the slider value is divided by 255 (±100 ≈ ±0.39).
- In edge-detect mode contrast/brightness affect the colours but not the density.
