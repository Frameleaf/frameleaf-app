# ovalIris

| | |
|---|---|
| Category | iris |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
An axis-aligned elliptical hole grows from the frame centre; B is seen through it, A outside. In landscape/square frames the ellipse is wider than tall; in portrait frames it is still wider than tall but less so.

## Parameters
outgoingDim (0 – 0.12, default 0.06). See arrowIris.md §Shared iris machinery.

## Progress curve
p clamped to [0,1]; s = 1.45 · p · max(W, H). Linear.

## Geometry
Layers, even-odd clip and alphas as arrowIris.md §Shared iris machinery.

Aperture: a full ellipse (true ellipse, 0 to 2π, no rotation) centred at (cx, cy) with
- rx = 1.15 · s if W ≥ H, else rx = 0.85 · s;
- ry = 0.72 · s.

## Blend
See shared section.

## Edges
Clip edges decided at pixel centres [T6]. The ellipse is a curved outline: flatten it to chords within 1/16 pixel of the true ellipse (or test the true ellipse) and scan-convert as T6 says. How the canonical backend flattens it is not specifiable; against the goldens the true ellipse differs in at most 12 pixels of a case (`ovalIris/p=0.25`), all on the outline and inside the case's outlier allowance.

## Alpha
See shared section.

## Notes
- Full coverage when (W/2)²/rx² + (H/2)²/ry² ≤ 1, i.e. p_full = √((W/(2k))² + (H/1.44)²) / (1.45 · max(W,H)) with k = 1.15 (W ≥ H) or 0.85; always ≤ 1 (16:9 → 0.4031; 9:16 → 0.5305; 1:1 → 0.5651).
- Implementation detail without visual effect: the ellipse sub-path is appended after the frame rectangle without an explicit move, so the path contains a zero-area straight spur from (0,0) to the ellipse start (cx + rx, cy); it encloses no area and does not change the even-odd result.
