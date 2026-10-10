# triangleLeftShape

| | |
|---|---|
| Category | shape |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
Despite the name, this is **not** a centred left-pointing triangle: B is revealed by a right-angled triangle anchored at the frame's **top-left corner**, whose hypotenuse sweeps diagonally across the frame toward the bottom-right until B fills it.

## Parameters
None. See boxShape.md §Shared shape machinery.

## Progress curve
p clamped to [0,1]. Leg factor k = 2.24 · p. Linear.

## Geometry
Layers and even-odd clip as boxShape.md §Shared shape machinery. Aperture: closed triangle in pixel coordinates

(0, 0) → (2.24·p·W, 0) → (0, 2.24·p·H) → close.

The hypotenuse is the line x/(2.24·p·W) + y/(2.24·p·H) = 1; B is visible on the top-left side of it.

## Blend
See shared section.

## Edges
The hypotenuse is a clip edge decided at pixel centres [T6]. The two legs lie on the frame edges.

## Alpha
See shared section.

## Notes
- Full coverage when the bottom-right corner (W, H) is on the hypotenuse: 2/(2.24·p) ≤ 1 → p_full = 2/2.24 = 0.892857 for every aspect ratio; output is B from there to p = 1.
- The hypotenuse direction depends on the aspect ratio (it always runs parallel to the frame's anti-diagonal from (W,0) to (0,H)).
- An unused set of centred "left-pointing triangle" vertices exists in the engine but is never drawn for this transition; the drawn shape is the corner triangle above (implementation-defined naming, observed).
