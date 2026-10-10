# gpu-ink

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single full-frame fragment pass, output size = input size (W × H) |
| HDR | refused [C4] |

## What it does
Pen-and-ink / cross-hatch drawing. The frame is redrawn in two colours (ink on paper): four layers of parallel hatch lines fade in as the image gets darker, and a Sobel edge pass adds contour outlines.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| strength | number | 0 – 1 | 1 | — | overall ink amount |
| spacing | number | 2 – 24 | 6 | px | distance between hatch lines |
| thickness | number | 0.5 – 4 | 1.2 | px | hatch line width |
| edgeStrength | number | 0 – 5 | 1.5 | gain | outline strength |
| tone | number | 0.2 – 2.5 | 1 | × | multiplier on luma before hatching (higher = lighter) |
| inkColor | color | — | #141414 | sRGB hex | ink colour |
| paperColor | color | — | #f4f1e8 | sRGB hex | paper colour |

Sanitised per [C9]. Absent keys use defaults.

**Colour strings**: same parsing as gpu-halftone (must start with `#`; 3/4 or 6/8 hex digits). Only RGB is used; colour alpha is ignored. Fallbacks (used when the string is unparseable) are **not** the defaults: ink fallback = (0.08, 0.08, 0.08), paper fallback = (0.96, 0.95, 0.91) (the default strings parse to (20/255, 20/255, 20/255) and (244/255, 241/255, 232/255)).

Internal: sp = max(spacing, 1); th = thickness.

## Per-pixel definition
Let Y(dx, dy) = LUMA709(S(uv + (dx/W, dy/H)).rgb) [C7]. Because offsets are whole texels these are fetches of F(i+dx, j+dy) clamped to the frame (up to bilinear-filter rounding).

1. src = S(uv) (= F(i, j)).
2. Sobel: gx = −Y(−1,−1) − 2Y(−1,0) − Y(−1,1) + Y(1,−1) + 2Y(1,0) + Y(1,1); gy = −Y(−1,−1) − 2Y(0,−1) − Y(1,−1) + Y(−1,1) + 2Y(0,1) + Y(1,1). edge = clamp(sqrt(gx² + gy²) · edgeStrength, 0, 1).
3. L = clamp(LUMA709(src.rgb) · tone, 0, 1).
4. p = (i + 0.5, j + 0.5) (pixel units).
5. Hatch set HATCH(φ): q = p.x·cos φ − p.y·sin φ; m = q − sp·floor(q / sp); d = min(m, sp − m); value = 1 − smoothstep(th/2, th/2 + 1, d). Lines are where q is a multiple of sp, with a 1-px anti-aliased falloff beyond half the thickness.
6. LAYER(φ, hi) = HATCH(φ) · (1 − smoothstep(hi − 0.15, hi, L)).
7. hatch = max(0, LAYER(0.7854, 0.85), LAYER(−0.7854, 0.65), LAYER(0.0, 0.45), LAYER(1.5708, 0.25)).
   Geometry (v down): φ = 0.7854 → lines along x − y = const (running down-right); φ = −0.7854 → lines along x + y = const (running down-left); φ = 0 → q = x, **vertical** lines; φ = 1.5708 → q ≈ −y, **horizontal** lines.
   Each layer is fully on below L = hi − 0.15 and off at L ≥ hi: layer 1 for L < 0.85, layer 2 for L < 0.65, layer 3 for L < 0.45, layer 4 for L < 0.25.
8. ink = clamp(max(hatch, edge) · strength, 0, 1).
9. Output = (mix(paper, inkColor, ink), src.a).

## Edges
Sobel neighbours outside the frame read the edge texel (clamp-to-edge), so border pixels compare against themselves across the edge. Hatch lines are anchored at the top-left pixel corner (q = 0 at p = (0, 0)).

## Alpha
Alpha passes through (src.a). RGB is always written (paper/ink mixture) including where alpha = 0. Luma and edges use straight RGB without alpha weighting, so hidden RGB under transparent pixels can produce edges and hatching (invisible unless alpha is later changed).

## SDR and HDR
SDR: luma of sRGB-encoded values; output is a mix of two constant colours [C3]. HDR: refused [C4].

## Notes
- The angles are the binary32 constants 0.7854, −0.7854, 0.0, 1.5708 (not exact π/4, π/2). cos(1.5708) ≈ −3.67·10⁻⁶, so the "horizontal" lines drift by ≈ 0.015 px across 4000 px — negligible but part of the definition.
- Hatch positions depend on sin/cos and floor of values up to ≈ (W + H); pixels exactly at a line's anti-alias boundary can differ by one rounding step between GPUs. Otherwise reproducible.
- Hatch spacing and width are in output pixels, so the look is resolution-dependent (a 4K render has finer hatching relative to the picture than 1080p).
