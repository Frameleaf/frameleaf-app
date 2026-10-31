# crossIris

| | |
|---|---|
| Category | iris |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
A plus-sign (Greek cross) shaped hole grows from the frame centre; B is seen through it, A outside. Square-ish frames are not fully cleared at p = 1.

## Parameters
outgoingDim (0 – 0.12, default 0.06). See arrowIris.md §Shared iris machinery for sanitising and use.

## Progress curve
p clamped to [0,1]; s = 1.45 · p · max(W, H). Linear.

## Geometry
Layers, even-odd clip and alphas exactly as arrowIris.md §Shared iris machinery. Aperture: closed 12-vertex polygon in unit coordinates (pixel = (cx + u·s, cy + v·s)), in order:

(−0.28, −1) → (0.28, −1) → (0.28, −0.28) → (1, −0.28) → (1, 0.28) → (0.28, 0.28) → (0.28, 1) → (−0.28, 1) → (−0.28, 0.28) → (−1, 0.28) → (−1, −0.28) → (−0.28, −0.28) → close.

Arms are 0.56·s wide and reach ±s from the centre.

## Blend
See shared section (B at alpha 0.9 + 0.1p; A at alpha 1 − δp outside the aperture).

## Edges
Axis-aligned straight edges; clip edges decided at pixel centres [T6].

## Alpha
See shared section.

## Notes
- **Full-coverage condition:** the frame corners lie in the cross only if min(W,H)/2 ≤ 0.28·s, so p_full = min(W,H) / (0.812 · max(W,H)), reached only if min/max ≤ 0.812. Examples: 16:9 → 0.6927; 4:3 → 0.9236; 21:9 (2560×1080) → 0.5196; 1:1 → never (A remains in the four corners at p = 1, ≈ 3.7 % of the frame). Pop at the end where not reached (implementation-defined, observed).
