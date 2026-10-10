# centerWipe

| | |
|---|---|
| Category | wipe |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 5, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
B opens from the vertical centre line outward: a central vertical band of B widens symmetrically until it fills the frame, while A remains, uncropped in position, in two shrinking side bands.

## Parameters
None. Undeclared finite numeric properties are kept by the sanitiser [T4] but not read.

## Progress curve
p as given [T1], clamped to [0,1] by the renderer. Linear geometry.

## Geometry
Let sw = (W/2)·(1 − p) (side-band width; never negative because p ≤ 1).

1. Draw B at (0,0), size W×H, global alpha 1, source-over.
2. Clip (non-zero) to the union of:
   - x ∈ [0, sw], y ∈ [0, H];
   - x ∈ [W − sw, W], y ∈ [0, H].
3. Draw A at (0,0), size W×H, global alpha 1, source-over, inside the clip.

- p = 0: A everywhere (over B). p = 1: clip empty, output = B.

## Blend
Source-over, global alpha 1. Side bands: A over B. Centre band: B.

## Edges
Band edges at x = sw and x = W − sw are clip edges, decided at pixel centres [T6]. No feather.

## Alpha
Background transparent. Opaque inputs → opaque output.

## Notes
- Pixel-for-pixel the same drawing as barnDoor (which additionally guards the width with max(0, …); with p clamped to [0,1] the guard never acts). Only the category and label differ.
