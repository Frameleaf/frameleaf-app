# radialWipe

| | |
|---|---|
| Category | wipe |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 5, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
Four "clock hands" start at 12, 3, 6 and 9 o'clock and sweep clockwise around the frame centre, each through a quarter turn. Behind each hand B is revealed, so B grows as four wedges until the frame is fully B. A is cropped, not moved.

## Parameters
None. Undeclared finite numeric properties are kept by the sanitiser [T4] but not read.

## Progress curve
p as given [T1], clamped to [0,1]. Hand angle is linear in p.

## Geometry
Centre (cx, cy) = (W/2, H/2). Radius R = √(W² + H²) (the full diagonal, so every sector reaches past all corners). Angles are measured from the +x axis with y down, so increasing angle is **clockwise on screen**; −π/2 points straight up.

1. Draw B at (0,0), size W×H, global alpha 1, source-over.
2. Build the clip (non-zero):
   - if p = 0 (after clamping): the rectangle [0, W] × [0, H] (A everywhere);
   - if p = 1: the empty path (A not drawn at all);
   - otherwise the union of four circular sectors k = 0, 1, 2, 3, with σ_k = −π/2 + k·π/2:
     - start angle α_k = σ_k + p·π/2, end angle β_k = σ_k + π/2;
     - sector = centre → point (cx + R cos α_k, cy + R sin α_k) → circular arc of radius R about the centre, clockwise (increasing angle) from α_k to β_k → straight line back to the centre.
3. Draw A at (0,0), size W×H, global alpha 1, source-over, inside the clip.

So in quadrant k, A remains in the angular range [σ_k + p·π/2, σ_k + π/2] and B occupies [σ_k, σ_k + p·π/2].

## Blend
Source-over, global alpha 1.

## Edges
The four straight hand edges radiate from the centre; they are clip edges, decided at pixel centres [T6]. The arc lies outside the frame and is never visible. At p = 0 every hand lies exactly on the quadrant boundary.

## Alpha
Background transparent. Opaque inputs → opaque output.

## Notes
- The arc is a true circular arc in Canvas 2D; since it lies entirely outside the frame (R exceeds the half-diagonal), any polygonal approximation that stays outside the frame gives identical pixels.
- When H is odd, the pixel row through the centre lies exactly on the horizontal hand at the start and end of each quarter sweep. Whether that row's pixels fall inside is decided by float rounding of the arc endpoints and can change with p; it is not specifiable, and the goldens allow it as outliers.
