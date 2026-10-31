# gpu-power-window

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | refused |

## What it does
A soft-edged ellipse or rectangle mask, which can be rotated and inverted. Exposure, temperature, tint and saturation are applied inside it, or the mask itself is shown.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| shape | select | ellipse, rectangle | ellipse | — | ellipse → 0, rectangle → 1 |
| centerX | number | 0 .. 1 | 0.5 | fraction of width | window centre u |
| centerY | number | 0 .. 1 | 0.5 | fraction of height (down) | window centre v |
| sizeX | number | 0.02 .. 1.5 | 0.5 | fraction of width | full width of the window |
| sizeY | number | 0.02 .. 1.5 | 0.5 | fraction of height | full height of the window |
| rotation | number | -180 .. 180 | 0 | degrees | positive = clockwise on screen |
| feather | number | 0 .. 1 | 0.3 | fraction of radius | soft edge width (internally clamped to [0.001, 1]) |
| invertMask | boolean | — | false | — | |
| showMask | boolean | — | false | — | output the mask as grey |
| exposure | number | -3 .. 3 | **0.3** | EV | gain 2^exposure inside the window |
| saturation | number | -100 .. 100 | 0 | percent | sat = 1 + saturation/100 |
| temperature | number | -100 .. 100 | 0 | percent | T = temperature/100 |
| tint | number | -100 .. 100 | 0 | percent | Ti = tint/100 |
| strength | number | 0 .. 1 | 1 | fraction | mask multiplier |

Sanitised per [C9]. An absent number takes the default above. An absent flag means false. An unknown shape falls back to the ellipse.

Derived from the pass size W×H [C1]:
- a = max(W / max(H, 1), 0.0001)
- θ = −rotation·π/180

## Per-pixel definition
```
c0 = S(uv),  c = c0.rgb
p  = (uv.x - centerX, uv.y - centerY)
p.x = p.x * a                                    (aspect-correct: units of image height)
p  = (p.x·cosθ - p.y·sinθ,  p.x·sinθ + p.y·cosθ)
hs = (max(sizeX·a·0.5, 0.0001), max(sizeY·0.5, 0.0001))
n  = p / hs                                      (per component)
ellipse:   d = sqrt(n.x² + n.y²)
rectangle: d = max(|n.x|, |n.y|)
f  = clamp(feather, 0.001, 1)
mask = clamp01(1 - smoothstep(1 - f, 1, d))

if invertMask: mask = 1 - mask
mask = clamp01(mask * strength)

if showMask:  out = (mask, mask, mask, c0.a),  stop

k = c * 2^exposure
k.r += T*0.1,  k.b -= T*0.1
k.g -= Ti*0.1, k.r += Ti*0.05, k.b += Ti*0.05
g = LUMA601(k),  k = mix(g, k, sat)

out.rgb = clamp01(mix(c, k, mask)),  out.a = c0.a
```
- With rotation 0, the window spans exactly sizeX of the image width and sizeY of the image height (the aspect factor cancels).
- Under rotation the shape is rigid in square, height-normalised units, so a circle stays a circle.
- The feather lies entirely inside the nominal boundary: d ∈ [1−f, 1] ramps from 1 to 0.

## Edges
No image neighbourhood access. The window may extend past the frame; pixels outside the window simply get mask 0.

## Alpha
Passed through unchanged, also in show-mask mode.

## SDR and HDR
- SDR: the corrected colour is unclamped until the final `clamp01` of the blend.
- HDR: refused [C4].

## Notes
- The default exposure is 0.3 EV, so adding the effect brightens the window centre without any edits.
- The catalogue feather range starts at 0, but the internal floor of 0.001 makes 0 behave like 0.001, a near-hard edge (implementation-defined).
- The mask is inverted before strength is applied (same as gpu-secondary-qualifier). With invert on, the outside gets `strength` and the inside gets 0.
- sin and cos are evaluated once per pixel on a constant angle. Precision differences are negligible except right at the feather edge. `exp2` is used for exposure. A tolerance of 1/255 is adequate, with 2/255 inside the feather band.
