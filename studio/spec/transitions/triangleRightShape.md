# triangleRightShape

| | |
|---|---|
| Category | shape |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
Mirror image of triangleLeftShape: B is revealed by a right-angled triangle anchored at the frame's **top-right corner**, whose hypotenuse sweeps diagonally toward the bottom-left until B fills the frame. Not a centred right-pointing triangle despite the name.

## Parameters
None. See boxShape.md §Shared shape machinery.

## Progress curve
p clamped to [0,1]. Leg factor k = 2.24 · p. Linear.

## Geometry
Layers and even-odd clip as boxShape.md §Shared shape machinery. Aperture: closed triangle in pixel coordinates

(W, 0) → (W − 2.24·p·W, 0) → (W, 2.24·p·H) → close.

The hypotenuse is the line (W − x)/(2.24·p·W) + y/(2.24·p·H) = 1; B is visible on the top-right side of it.

## Blend
See shared section.

## Edges
The hypotenuse is a clip edge decided at pixel centres [T6]. The legs lie on the frame edges.

## Alpha
See shared section.

## Notes
- Full coverage when the bottom-left corner (0, H) is on the hypotenuse: p_full = 2/2.24 = 0.892857 for every aspect ratio.
- The hypotenuse always runs parallel to the frame's main diagonal from (0,0) to (W,H).
- As with triangleLeftShape, an unused set of centred triangle vertices exists in the engine; only the corner triangle above is drawn (implementation-defined naming).
