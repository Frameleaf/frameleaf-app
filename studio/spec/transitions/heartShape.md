# heartShape

| | |
|---|---|
| Category | shape |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
A heart-shaped hole (point down, two lobes up) grows from the frame centre; B is seen through it, A outside.

## Parameters
None. See boxShape.md §Shared shape machinery.

## Progress curve
p clamped to [0,1]; s = 1.45 · p · max(W, H). Linear.

## Geometry
Layers and even-odd clip as boxShape.md §Shared shape machinery. Aperture: four cubic Bézier curves (exact cubics) in unit coordinates, pixel = (cx + u·s, cy + v·s):

1. Start at (0, 0.78) (bottom point).
2. Cubic: controls (−1.08, 0.12), (−0.96, −0.78); end (−0.36, −0.78) (top of left lobe).
3. Cubic: controls (−0.12, −0.78), (0, −0.58); end (0, −0.42) (centre dip).
4. Cubic: controls (0, −0.58), (0.12, −0.78); end (0.36, −0.78) (top of right lobe).
5. Cubic: controls (0.96, −0.78), (1.08, 0.12); end (0, 0.78).
6. Close.

The shape is mirror-symmetric about x = cx. The top of each lobe is at v = −0.78 (the curves are horizontal there); the dip at (0, −0.42) and the bottom point (0, 0.78) are sharp corners. The heart is widest at |u| ≈ 0.813, v ≈ −0.313; its vertical extent is v ∈ [−0.78, 0.78].

## Blend
See shared section.

## Edges
Clip edges decided at pixel centres [T6]; Bézier flattening must keep the outline within 0.25 px of the curve.

## Alpha
See shared section.

## Notes
- **End-state coverage (numeric):** the frame is fully inside the heart from p_full ≈ 0.622 (1920×1080), 0.690 (1440×1080), 0.575 (2560×1080), 0.821 (1:1, 3:4 and 9:16 — limited by the top-centre dip); always before p = 1.
