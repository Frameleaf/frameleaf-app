# arrowIris

| | |
|---|---|
| Category | iris |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) — see barnDoor.md §Route |
| HDR | refused [T5] |

## What it does
An upward-pointing arrowhead-shaped hole opens from a point at the frame centre and grows; B is seen through the hole, A outside it. A is dimmed slightly as the hole grows and B starts slightly transparent. For landscape and square frames the arrow does **not** clear A from the top corners by p = 1 (see Notes).

## Shared iris machinery
Applies to all nine iris variants (arrowIris, crossIris, diamondIris, eyeIris, hexagonIris, ovalIris, pentagonIris, squareIris, triangleIris); the others cite "arrowIris.md §Shared iris machinery" and give only their aperture.

### Parameter
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| outgoingDim | number | 0 – 0.12 | 0.06 | fraction | how much A's opacity drops by p = 1 |

Sanitised per [T4]. The renderer additionally re-applies the rule itself: a value that is not a finite number → 0.06; then clamped to [0, 0.12]. Let δ be the result. No other properties are read; there are no hidden properties.

### Progress
p as given [T1], clamped to [0,1].

### Size
Centre (cx, cy) = (W/2, H/2). M = max(W, H). Aperture scale s = 1.45 · p · M (pixels). Each aperture is defined in unit coordinates (u, v) mapped to pixels as (cx + u·s, cy + v·s), with v pointing down (so negative v is up). Angles below are measured from +x with y down (increasing angle = clockwise on screen).

### Layers
1. Draw B at (0,0), size W×H, source-over, **global alpha g_B = 0.9 + 0.1·p**.
2. Clip with the **even-odd** fill rule to a path consisting of two sub-paths: the frame rectangle [0, W] × [0, H], and the closed aperture outline. Inside the frame, even-odd selects the frame minus the aperture (A outside the hole); any part of the aperture outside the frame is irrelevant.
3. Draw A at (0,0), size W×H, source-over, **global alpha g_A = 1 − δ·p**, inside the clip.

### Blend (premultiplied, per pixel)
- Inside the aperture: out = g_B · B.
- Outside the aperture: out = g_A · A + (1 − g_A · α_A) · g_B · B.

With default δ = 0.06 and opaque inputs: at p = 0 the aperture is a single point, out = A exactly (alpha 1). At p = 1, outside any remaining aperture gap out = 0.94·A + 0.06·B (a 6 % B blend, alpha 1); inside, out = B.

### Alpha
Background transparent. Because g_B < 1 for p < 1, **inside the aperture the transition layer is partially transparent** (alpha = 0.9 + 0.1·p for opaque B), so lower tracks show through the hole, most at small p. Outside the aperture alpha = g_A·α_A + (1 − g_A·α_A)·g_B·α_B; for opaque inputs this is 1 − (1 − g_A)(1 − g_B) = 1 − 0.1·δ·p·(1 − p) (e.g. 0.9985 at p = 0.5, δ = 0.06), so very slightly translucent mid-transition. Final 8-bit rounding of these premultiplied values is rasteriser-defined (±1 code value).

### Edges
Aperture outlines are clip edges, decided at pixel centres [T6]. Polygon outlines are straight segments; curved outlines are true ellipses / cubic Béziers as stated per variant. No feather (iris variants have no softness control).

### End-state coverage
Whether the aperture fully covers the frame at p = 1 depends on shape and aspect ratio. Where it does not, the last transition frame still shows (dimmed) A outside the aperture and the next frame after the transition is B alone: a visible pop. This is observed behaviour (implementation-defined); reproduce it.

## Aperture (arrow)
Closed polygon, four vertices in order (unit coordinates):
(0, −1) → (0.68, 1) → (0, 0.36) → (−0.68, 1) → close.

A concave upward-pointing arrowhead: tip at the top, two tail points at the bottom, notch at (0, 0.36). Pixel vertices: (cx, cy − s), (cx + 0.68 s, cy + s), (cx, cy + 0.36 s), (cx − 0.68 s, cy + s).

## Progress curve
s grows linearly with p (above). Alphas g_A, g_B linear in p.

## Edges
See shared section.

## Alpha
See shared section.

## Notes
- **Full-coverage condition:** the frame is entirely inside the arrow iff s ≥ max(W/0.68 + H/2, H/0.72) (the top corners must be inside the slanted sides; the bottom-centre must be above the notch). Hence p_full = max(W/0.68 + H/2, H/0.72) / (1.45·M), reached only if ≤ 1, i.e. only for portrait frames with W/H ≤ 0.6463 (e.g. 9:16 → p_full = 0.958). For 16:9, 4:3, 1:1 and all landscape frames A remains in the two top corners at p = 1 (≈ 5.5 % of a 1920×1080 frame, ≈ 9.2 % of a square frame).
- At p = 0 the aperture degenerates to a point (all vertices at the centre); it contributes nothing.
