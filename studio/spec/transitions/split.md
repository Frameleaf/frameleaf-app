# split

| | |
|---|---|
| Category | motion |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 5, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
A is cut into four quadrant panels that shrink toward the four corners. B appears in a plus-shaped (cross) opening centred on the frame's horizontal and vertical centre lines, whose arms widen until B fills the frame. A's content does not move; it is only cropped.

## Parameters
None. Undeclared finite numeric properties are kept by the sanitiser [T4] but not read.

## Progress curve
p as given [T1], clamped to [0,1] by the renderer. Geometry is linear in p.

## Geometry
Let pw = max(0, (W/2)·(1 − p)) and ph = max(0, (H/2)·(1 − p)).

1. Draw B at (0,0), size W×H, global alpha 1, source-over.
2. Clip (non-zero) to the union of four rectangles:
   - top-left: x ∈ [0, pw], y ∈ [0, ph];
   - top-right: x ∈ [W − pw, W], y ∈ [0, ph];
   - bottom-left: x ∈ [0, pw], y ∈ [H − ph, H];
   - bottom-right: x ∈ [W − pw, W], y ∈ [H − ph, H].
3. Draw A at (0,0), size W×H, global alpha 1, source-over, inside the clip.

B is visible where x ∈ [pw, W − pw] (vertical arm, width p·W) or y ∈ [ph, H − ph] (horizontal arm, height p·H).

- p = 0: pw = W/2, ph = H/2; the four rectangles tile the frame, output = A (over B).
- p = 1: all rectangles have zero size, output = B.

## Blend
Source-over, global alpha 1. Panels: A over B. Opening: B.

## Edges
Panel edges at fractional coordinates are clip edges, decided at pixel centres [T6]. The four rectangles are one clip path and the clip region is their union, so where panels abut (at p = 0 along x = W/2 and y = H/2) there is by definition no seam; a native implementation must build the clip as one union region, not as four separately anti-aliased masks added together.

## Alpha
Background transparent. Opaque inputs → opaque output.

## Notes
- Same machinery as barnDoor (see barnDoor.md §Route); the only difference is the four corner panels instead of two side panels.
