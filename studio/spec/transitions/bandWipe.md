# bandWipe

| | |
|---|---|
| Category | wipe |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 5, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
The frame is split into 10 equal horizontal bands. In even bands (counting from 0 at the top) B wipes in from the left edge; in odd bands B wipes in from the right edge, starting later (at p = 0.18) and moving faster, so both finish at p = 1. A is cropped, not moved.

## Parameters
None. Undeclared finite numeric properties are kept by the sanitiser [T4] but not read.

## Progress curve
p as given [T1], clamped to [0,1]. Per band i (i = 0 … 9):
- stagger_i = 0 if i is even, 0.18 if i is odd;
- q_i = clamp((p − stagger_i) / max(0.2, 1 − stagger_i), 0, 1).

So even bands: q = p. Odd bands: q = clamp((p − 0.18) / 0.82, 0, 1) (0 until p = 0.18, linear to 1 at p = 1).

## Geometry
Band height b = H / 10 (fractional, not rounded). Band i spans y ∈ [i·b, (i+1)·b]. Let r_i = W·q_i.

1. Draw B at (0,0), size W×H, global alpha 1, source-over.
2. Clip (non-zero) to the union over i = 0 … 9 of:
   - i even: x ∈ [r_i, W], y ∈ [i·b, (i+1)·b] (A keeps the right part; B occupies x ∈ [0, r_i]);
   - i odd: x ∈ [0, W − r_i], y ∈ [i·b, (i+1)·b] (A keeps the left part; B occupies x ∈ [W − r_i, W]).
3. Draw A at (0,0), size W×H, global alpha 1, source-over, inside the clip.

- p = 0: all bands full width → A everywhere (over B).
- p = 1: all bands zero width → output = B.
- Example p = 0.5: even bands 50 % B from the left; odd bands q = 0.39024…, i.e. 39.0 % B from the right.

## Blend
Source-over, global alpha 1. A over B in the clip; B elsewhere.

## Edges
Vertical wipe edges at x = r_i or W − r_i and band boundaries at y = i·b are clip edges, decided at pixel centres [T6]. All bands are one clip path whose region is the union, so abutting bands have no seam.

## Alpha
Background transparent. Opaque inputs → opaque output.

## Notes
- The divisor floor max(0.2, …) never acts (1 − stagger is 1 or 0.82); it is listed for completeness.
- Band boundaries at fractional y (when H is not a multiple of 10) are partially covered pixels; only visible when adjacent bands differ.
