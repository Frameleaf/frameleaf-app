# xWipe

| | |
|---|---|
| Category | wipe |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 5, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
An "X" made of the frame's two diagonals is erased out of A as two thick strokes whose width grows with p; B shows through the X. For most aspect ratios the X does **not** fully cover the frame at p = 1 (see Notes).

## Parameters
None. Undeclared finite numeric properties are kept by the sanitiser [T4] but not read.

## Progress curve
p as given [T1], clamped to [0,1]. Stroke width linear in p.

## Geometry
Uses the erase-layer machinery described in spiralWipe.md §Shared erase-layer machinery (B drawn first; A on a cleared scratch layer; destination-out stroke; scratch drawn over B), including the zero-width quirk.

D = √(W² + H²).

Erase path: two separate straight segments (two sub-paths):
- (0, 0) → (W, H);
- (W, 0) → (0, H).

Stroke style: line cap **butt** (each stroke ends flush at the frame corner, cut perpendicular to its diagonal); no joins occur (each sub-path is a single segment). Width:
- w = 0.36 · p · D for p > 0;
- p = 0: computed width 0 → stroked at **1 px** (zero-width quirk), giving a 1-px X of B through A.

Each stroke covers the band of points whose perpendicular distance to its diagonal is ≤ w/2, limited to the diagonal's extent (which contains the whole frame, since every frame point projects onto the diagonal within its length). The erased region is the union of the two bands.

## Blend
Output: B (source-over, alpha 1), then the erased-A scratch layer source-over. Per pixel: out = A·(1 − c) + B·(1 − α_A·(1 − c)), c = union stroke coverage.

## Edges
Stroke edges are anti-aliased by coverage [T6, Strokes]: c is the fraction of the pixel's area within w/2 of either diagonal (between the diagonal's ends), the union counted once. A pixel wholly inside a band has c = 1 and shows B exactly; a pixel wholly outside both has c = 0 and shows A exactly; only the pixels a band edge crosses are blended. The canonical backend's c differs from the exact area by at most 0.006 on average over the frame and by up to 0.16 at single pixels on a band's edge (0.18 for the hairline at p = 0, 0.25 at the corner caps at p = 1); the goldens allow this. No feather.

## Alpha
Background transparent. Opaque inputs → opaque output.

## Notes
- **Incomplete coverage at p = 1 (implementation-defined, observed):** the frame points farthest from both diagonals are the four edge midpoints, at distance W·H / (2D) from each diagonal. The half-width at p = 1 is 0.18·D. A therefore survives at p = 1 in four small triangles at the edge midpoints unless W·H ≤ 0.36·(W² + H²), i.e. unless the aspect ratio a = W/H satisfies a ≥ 2.3527 or a ≤ 0.42504. Examples at p = 1: 1920×1080 → A remains in triangles spanning x ∈ [808.8, 1111.2] and 85 px deep at the top and bottom edges, and spanning y ∈ [455, 625] and 151 px deep at the left and right edges (≈ 2.5 % of the frame in total); 1:1 → ≈ 7.7 %; 4:3 → ≈ 6.25 %; 2560×1080 → fully covered. The next frame after the transition shows B only, so this is a visible pop. Reproduce it; do not "fix" it.
- Exact remaining region at progress p: points with distance to both diagonals > 0.18·p·D.
- p = 0: 1-px X of B visible (zero-width quirk).
- If the scratch layer cannot be created the renderer draws B only (not reachable in a working browser).
