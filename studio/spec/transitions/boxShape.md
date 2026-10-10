# boxShape

| | |
|---|---|
| Category | shape |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
A horizontal rectangular hole (width : height = 1 : 0.62) grows from the frame centre; B is seen through it, A outside. No dimming or translucency.

## Shared shape machinery
Applies to all five shape variants (boxShape, heartShape, starShape, triangleLeftShape, triangleRightShape); the others cite "boxShape.md §Shared shape machinery".

- Parameters: none. Undeclared finite numeric properties are kept by the sanitiser [T4] but not read; no hidden properties.
- Progress: p as given [T1], clamped to [0,1].
- Layers:
  1. Draw B at (0,0), size W×H, global alpha 1, source-over.
  2. Clip with the **even-odd** rule to a path of two sub-paths: the frame rectangle [0, W] × [0, H] and the closed aperture outline. Inside the frame this selects the frame minus the aperture.
  3. Draw A at (0,0), size W×H, global alpha 1, source-over, inside the clip.
- Blend: inside the aperture out = B; outside out = A over B (source-over, premultiplied). Background transparent; opaque inputs give an opaque result everywhere at every p (unlike the iris family, there is no global-alpha ramp).
- Edges: aperture outlines are clip edges, decided at pixel centres [T6]. No feather.
- Centred variants (box, heart, star): centre (cx, cy) = (W/2, H/2), unit coordinates (u, v) map to pixels (cx + u·s, cy + v·s), v down. Angles from +x, y down (increasing = clockwise on screen).
- End-state: where an aperture does not cover the frame by p = 1, A remains on the last transition frame and the next frame is B alone (visible pop; implementation-defined, observed).

## Parameters
None (see shared section).

## Progress curve
s = 1.12 · p · max(W/2, H/(2·0.62)) = 1.12 · p · max(W/2, H/1.24). Linear.

## Geometry
Aperture: closed polygon in unit coordinates

(−1, −0.62) → (1, −0.62) → (1, 0.62) → (−1, 0.62) → close,

i.e. the pixel rectangle [cx − s, cx + s] × [cy − 0.62·s, cy + 0.62·s].

## Blend
See shared section.

## Edges
Axis-aligned straight edges; clip edges decided at pixel centres [T6].

## Alpha
See shared section.

## Notes
- The scale is chosen so the box exactly reaches the frame's limiting edge at p = 1/1.12: full coverage p_full = 1/1.12 = 0.892857 for every aspect ratio; from there to p = 1 the output is B.
- At p = 0 the aperture is a point (no effect): output = A over B.
