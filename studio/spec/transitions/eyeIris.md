# eyeIris

| | |
|---|---|
| Category | iris |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
A horizontal almond / eye-shaped (lens) hole with pointed left and right ends grows from the frame centre; B is seen through it, A outside. Portrait and square frames are not fully cleared at p = 1.

## Parameters
outgoingDim (0 – 0.12, default 0.06). See arrowIris.md §Shared iris machinery.

## Progress curve
p clamped to [0,1]; s = 1.45 · p · max(W, H). Linear.

## Geometry
Layers, even-odd clip and alphas as arrowIris.md §Shared iris machinery.

Aperture radii: rx = 1.02 · s, ry = 0.42 · s. The outline is two cubic Bézier curves (exact cubic Béziers, not ellipse arcs):
1. Start at (cx − rx, cy).
2. Upper curve: control points (cx − 0.5·rx, cy − ry) and (cx + 0.5·rx, cy − ry), end (cx + rx, cy).
3. Lower curve: control points (cx + 0.5·rx, cy + ry) and (cx − 0.5·rx, cy + ry), end (cx − rx, cy).
4. Close.

The upper curve is x(t) = cx + rx·(−(1−t)³ − 1.5(1−t)²t + 1.5(1−t)t² + t³), y(t) = cy − 3·ry·t(1−t), t ∈ [0,1]; the lower is its mirror in y = cy. Maximum half-height 0.75·ry = 0.315·s at x = cx; half-width rx = 1.02·s. The ends are sharp corners.

## Blend
See shared section.

## Edges
Clip edges decided at pixel centres [T6]. The two cubics are curved outlines: flatten each to chords within 1/16 pixel of the true curve and scan-convert as T6 says. How the canonical backend flattens them is not specifiable; against the goldens the true curve differs in at most 13 pixels of a case (`eyeIris/p=0.5`), all on the outline and inside the case's outlier allowance. A coarser flattening than 1/16 pixel is not allowed: it moves the sharp ends.

## Alpha
See shared section.

## Notes
- **End-state coverage (observed, numeric):** the frame is fully inside the eye once the corner (W/2, H/2) relative to the centre is inside the lens. p_full: 1920×1080 → 0.742; 1440×1080 → 0.921; 2560×1080 → 0.617. Never reached for 1:1 (≈ 11 % of the frame — top and bottom bands — still A at p = 1), 3:4 or 9:16 (≈ 9.5 % still A). Pop at the end where not reached (implementation-defined).
- Unlike ovalIris, the radii do not depend on the frame's orientation.
