# edgeWipe

| | |
|---|---|
| Category | wipe |
| Directions | from-left, from-right, from-top, from-bottom |
| Duration (frames) | default 30, min 5, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
A single straight edge sweeps across the frame from the named side; B is revealed behind it starting at that side. Neither image moves; A is only cropped.

## Parameters
None. Undeclared finite numeric properties are kept by the sanitiser [T4] but not read.

## Directions [T3]
"from-X" means B enters from side X.
- Absent / empty direction → **from-top** (renderer default).
- Any other unrecognised direction string → also from-top.
- Note: the editor creates a new edgeWipe with the first listed direction, from-left, and the properties panel shows from-left when the stored direction is absent; but a transition with no stored direction renders as from-top (implementation-defined mismatch, observed).

## Progress curve
p as given [T1], clamped to [0,1]. Linear.

## Geometry
1. Draw B at (0,0), size W×H, global alpha 1, source-over.
2. Clip (non-zero) to one rectangle (the part of A that remains):
   - from-left: x ∈ [p·W, W], y ∈ [0, H];
   - from-right: x ∈ [0, (1 − p)·W], y ∈ [0, H];
   - from-top: x ∈ [0, W], y ∈ [p·H, H];
   - from-bottom: x ∈ [0, W], y ∈ [0, (1 − p)·H].
3. Draw A at (0,0), size W×H, global alpha 1, source-over, inside the clip.

- p = 0: A everywhere (over B). p = 1: zero-size clip, output = B.

## Blend
Source-over, global alpha 1. No offset or parallax of either image (unlike the legacy "wipe"/Slide transition).

## Edges
The sweeping edge is a clip edge at a fractional coordinate, decided at pixel centres [T6]. No feather.

## Alpha
Background transparent. Opaque inputs → opaque output.

## Notes
- Default-direction mismatch between editor UI and renderer: see Directions.
