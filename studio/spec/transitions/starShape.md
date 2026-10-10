# starShape

| | |
|---|---|
| Category | shape |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
A five-pointed star hole, one point straight up, grows from the frame centre; B is seen through it, A outside.

## Parameters
None. See boxShape.md §Shared shape machinery.

## Progress curve
p clamped to [0,1]; s = 1.45 · p · max(W, H). Linear.

## Geometry
Layers and even-odd clip as boxShape.md §Shared shape machinery. Aperture: closed 10-vertex polygon (simple, concave), vertex k = 0 … 9 at angle θ_k = −π/2 + k·π/5 and radius r_k = 1 for even k (points), 0.42 for odd k (inner corners); unit coordinates (r_k cos θ_k, r_k sin θ_k):

| k | angle (deg) | r | u | v |
|---|---|---|---|---|
| 0 | −90 | 1 | 0 | −1 |
| 1 | −54 | 0.42 | 0.246870 | −0.339790 |
| 2 | −18 | 1 | 0.951057 | −0.309017 |
| 3 | 18 | 0.42 | 0.399444 | 0.129787 |
| 4 | 54 | 1 | 0.587785 | 0.809017 |
| 5 | 90 | 0.42 | 0 | 0.42 |
| 6 | 126 | 1 | −0.587785 | 0.809017 |
| 7 | 162 | 0.42 | −0.399444 | 0.129787 |
| 8 | 198 | 1 | −0.951057 | −0.309017 |
| 9 | 234 | 0.42 | −0.246870 | −0.339790 |

Pixels: (cx + u·s, cy + v·s), joined in order by straight lines, closed.

## Blend
See shared section.

## Edges
Straight edges; clip edges decided at pixel centres [T6].

## Alpha
See shared section.

## Notes
- **End-state coverage (numeric):** full coverage from p_full ≈ 0.863 for 16:9, 9:16, 4:3 and 21:9. Not reached for 1:1 or 3:4 frames: at p = 1 A remains in tiny slivers at the frame boundary between star points (≈ 0.3 % of a square frame) — a small pop at the end (implementation-defined, observed).
