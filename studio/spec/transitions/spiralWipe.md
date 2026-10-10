# spiralWipe

| | |
|---|---|
| Category | wipe |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 5, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
A fixed Archimedean spiral (3.8 turns, clockwise outward from the centre) is "erased" out of A as a thick stroke whose width grows with p; B shows through the erased stroke. As the stroke thickens, neighbouring turns merge and A disappears entirely. The spiral itself does not rotate.

## Parameters
None. Undeclared finite numeric properties are kept by the sanitiser [T4] but not read.

## Progress curve
p as given [T1], clamped to [0,1]. Stroke width linear in p (with the p = 0 special case below).

## Shared erase-layer machinery (spiralWipe, xWipe)
Unlike the clip-based wipes, spiralWipe and xWipe build A on a separate W×H scratch layer:
1. Draw B onto the output at (0,0), size W×H, global alpha 1, source-over.
2. Scratch layer: cleared to transparent (0,0,0,0); draw A onto it at (0,0), size W×H, source-over, alpha 1.
3. On the scratch layer, stroke the erase path with composite operation **destination-out** (stroke paint opaque, alpha 1): every scratch pixel keeps its colour and alpha multiplied by (1 − c), where c ∈ [0,1] is the stroke's anti-aliased coverage of that pixel. The stroke is the union of its outline (overlapping parts of the stroke erase once, not twice).
4. Draw the scratch layer onto the output at (0,0), 1:1, source-over, global alpha 1.

Result per pixel (premultiplied): out = A·(1 − c) + B·(1 − α_A·(1 − c)).

**Zero-width quirk (implementation-defined, observed):** Canvas 2D ignores an attempt to set the line width to 0 (the value is left unchanged), and the scratch context's line width is the default 1 px at that moment. Therefore whenever the computed width is exactly 0 the path is stroked with width **1 px**, not 0. A native implementation must reproduce this to match frame-exactly.

## Geometry
Centre (cx, cy) = (W/2, H/2). D = √(W² + H²). R = 0.58·D. Turns T = 3.8. Steps N = 220.

Erase path: a polyline (straight segments, not a smooth curve) through the 221 points P_i, i = 0 … 220:
- t_i = i / 220;
- θ_i = t_i · 2π · 3.8 (radians; y down, so increasing angle is clockwise on screen; θ_0 = 0 points to +x);
- r_i = R · t_i;
- P_i = (cx + r_i cos θ_i, cy + r_i sin θ_i).

P_0 is the centre; P_220 is at radius R, angle 3.8 turns (288° mod 360°), i.e. in direction (cos 288°, sin 288°) = (0.30902, −0.95106): up and slightly right of the centre on screen.

Stroke style: line cap **round**, line join **round**, width
- w = 0 if p = 0 → actually stroked at 1 px (quirk above);
- else w = (R / 3.8) · (0.04 + 1.25·p).

R / 3.8 is the radial spacing between successive turns; at p = 1 the stroke is 1.29 × that spacing, so adjacent turns overlap. With the round caps and joins, at p = 1 the stroke covers every point within radius ≥ 0.907·R of the centre in every direction, which exceeds the half-diagonal (0.862·R), so A is fully erased at p = 1 for every aspect ratio. Turns first touch (A broken into isolated islands vanishing) when w ≥ R/3.8, i.e. p ≥ 0.768.

## Blend
Output: B (source-over, alpha 1), then the erased-A scratch layer source-over. See the machinery section.

## Edges
Stroke edges are anti-aliased by coverage [T6, Strokes]: c is the fraction of the pixel's area within w/2 of any segment of the polyline, overlaps counted once (this is the round-capped, round-joined stroke exactly). The canonical backend's c differs from the exact area by at most 0.007 on average over the frame and by up to 0.15 at single pixels on the stroke's edge (0.025 on average and up to 0.4 for the hairline at p = 0); the goldens allow this. The polyline has 57.9 segments per turn; its corners are rounded by the round join. A smooth-curve substitute deviates from the polyline by up to about R·(1 − cos(π·3.8/220)) ≈ 0.0015·R, which is above 1 px for large frames — use the polyline.

## Alpha
Background transparent. Where A is erased, output = B. Opaque inputs → opaque output.

## Notes
- p = 0: a 1-px-wide spiral line of B is visible through A (zero-width quirk). For p > 0 the minimum width is 0.04·R/3.8 ≈ 0.0061·D (≈ 13.5 px at 1920×1080) — the stroke jumps from 1 px to that width at the first non-zero p.
- If the scratch layer cannot be created the renderer draws B only (not reachable in a working browser; not specified further).
