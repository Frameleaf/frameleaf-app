# venetianBlindWipe

| | |
|---|---|
| Category | wipe |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 5, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
The frame is split into 10 equal horizontal slats. In every slat A shrinks upward toward the slat's top edge, revealing B from the bottom of each slat upward, all slats in sync. A is cropped, not moved.

## Parameters
None. Undeclared finite numeric properties are kept by the sanitiser [T4] but not read.

## Progress curve
p as given [T1], clamped to [0,1]. Linear.

## Geometry
Slat height b = H / 10 (fractional, not rounded).

1. Draw B at (0,0), size W×H, global alpha 1, source-over.
2. Clip (non-zero) to the union over i = 0 … 9 of the rectangle x ∈ [0, W], y ∈ [i·b, i·b + b·(1 − p)].
3. Draw A at (0,0), size W×H, global alpha 1, source-over, inside the clip.

B is visible in y ∈ [i·b + b·(1 − p), (i+1)·b] of every slat.

- p = 0: slats tile the frame, A everywhere (over B).
- p = 1: all slats zero height, output = B.

## Blend
Source-over, global alpha 1.

## Edges
Horizontal edges at fractional y are clip edges, decided at pixel centres [T6]. One clip path, union region (no seams between abutting slats at p = 0).

## Alpha
Background transparent. Opaque inputs → opaque output.

## Notes
- No direction control: the slats always close upward (B grows upward from each slat's bottom edge).
