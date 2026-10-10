# Studio render spec: layer compositing (native-app contract)

**Status: native-app contract.** This page specifies what a frame of a project looks like apart from effects and transitions: which items draw, in what order, how an item is placed, cropped, masked and blended, and how shapes are drawn. It belongs to the render spec of [`README.md`](README.md) and is written on the same terms: a clean-room description, as mathematics and prose, of the engine pinned there; **implementation-defined** marks accidental engine behaviour, which is described and never embellished. Rules are cited by tag (L1 … L16). Tags C1 … C10 and T1 … T6 are those of `README.md`. Titles and text are specified in `text.md`; keyframes, expressions and modifiers decide the *values* of the fields named here at a frame and are not this page's subject.

**The contract route.** The engine has more than one way to assemble a frame (L16). The contract is the **display route**: the frame the editor's engine preview and the browser export draw for an SDR project, an 8-bit picture of composition size. Every golden of this page is rendered on that route. Where another route differs, L16 says so; a native client follows the display route.

## Goldens

`goldens/layers.json` holds 176 cases. Each case is a small project graph in the form of protocol section 2 (`metadata`, `timeline.tracks`, `timeline.items`, optionally `timeline.keyframes`), a frame number, the rendered frame and its tolerance. Media are named by `mediaId` and stored in the file: `fx` (the 16 × 12 effect input of `README.md`, with translucent and empty pixels), `layer` (a 16 × 12 blend layer, formula in `../tools/layer-goldens.mjs`), and `a` and `b` (the two opaque 48 × 27 transition inputs). Frames are 48 × 27, or 16 × 12 for the blend cases; buffers are `rgba8`, straight alpha, encoded as in `README.md`.

- Case names start with their class: `background/`, `order/`, `opacity/`, `blend/`, `transform/`, `parent/`, `crop/`, `corner-radius/`, `flip/`, `corner-pin/`, `stage/`, `mask/` and `shape/`.
- The comparison rule, the tolerance derivation and the meaning of `pixel`, `edge` and `statistical` are those of `README.md`: every case is rendered twice bit-identically on the canonical backend (SwiftShader WebGPU, CPU Canvas 2D) and once on a hardware backend, whose differences set the tolerance. `blend/dissolve` is always `statistical` (L9).
- 92 cases carry `"reference": true`. For these the frame has a closed form, and `../tools/layer-goldens.mjs` holds an independent renderer written from this page (`referenceFrame`); the engine-free test requires it to pass every one of them under the case's own tolerance. If a rule here changes, that renderer and the goldens change with it.
- `floatRoute` records, per case, how far the float route's frame is from the golden (largest and mean channel difference). It is informative: it shows where the routes of L16 part.

```sh
GOLDENS_CROSS_CHECK_ARGS='--enable-unsafe-webgpu --use-angle=metal --ignore-gpu-blocklist' \
  node studio/tools/layer-goldens.browser.mjs --write   # canonical backend + hardware cross-check
node studio/tools/layer-goldens.browser.mjs             # drift gate
node --test studio/tools/layer-goldens.test.mjs         # engine-free: structure, coverage, reference, lint
```

## Frame assembly

**[L1] Frame, coordinates and values.** A frame is W × H pixels, `metadata.width` × `metadata.height`, with the pixel and uv convention of C1: pixel (i, j) covers [i, i + 1) × [j, j + 1), its centre is (i + 0.5, j + 0.5), y grows downward. Lengths on this page are composition pixels unless a rule says otherwise. Colour values are sRGB-encoded BT.709 as in C3; all arithmetic of this page is on encoded values, never on linear light. An SDR frame is opaque: its alpha is 1 everywhere (but see the background, L3). When the engine draws at another size than the composition's (a reduced preview), every length scales with the frame: x, widths and horizontal anchors by s_x = drawn width / W, y, heights and vertical anchors by s_y, and corner radii, stroke widths and mask feathers by min(s_x, s_y). Export renders at composition size and resamples the finished frame. A native client renders so that its result equals the composition-size frame resampled.

**[L2] Which items draw, and in what order.** At sequence frame f an item is **active** when `from` ≤ f < `from` + `durationInFrames`. Tracks decide visibility and order:

- If any track has `solo: true`, only the solo tracks are visible. Otherwise a track is visible unless `visible` is `false`. `muted` concerns sound only. Layer-group tracks do not exist in normal form (protocol 2.6): a native client never meets one.
- Visible tracks are layered by `order`: the **largest** `order` is the bottom layer and the smallest is the top (protocol section 5). `order` may be fractional. The stored order of `timeline.tracks` and of `timeline.items` does not layer tracks (`order/stored-order-is-not-layer-order`).
- Within a track, active items draw in the order of `timeline.items`, later ones on top. Two items of a track share a frame only inside a transition, which replaces both (T2) and is drawn at that track's place, after the track's other items.
- Items that draw nothing themselves: `audio`, `adjustment` (L8), `controller`, and a `shape` with `isMask: true` (L10). An item on a hidden track draws nothing, masks nothing and adjusts nothing (`mask/hidden-track-mask`); it still serves as a transform parent (L7).
- A frame with no active drawing item shows the background only (`background/gap`). An item's last frame is `from` + `durationInFrames` − 1 (`background/last-frame-of-item`).

Cases: `order/three-tracks`, `order/hidden-track`, `order/solo-track`, `order/fractional-order`.

**[L3] Layers, compositing and the background.** Each drawing item, and each transition, yields one **layer**: a W × H picture with alpha, transparent wherever the item does not draw (L8 gives the stages that produce it). Layers are held 8-bit premultiplied: each premultiplied channel is rounded to k/255, and where a straight colour is needed it is 255 × premultiplied / alpha rounded to k/255 again. A native client may keep more precision; the goldens' tolerances are measured on 8-bit layers, and only blends that amplify a rounding step (`color-burn`, `color-dodge`, `vivid-light`, `divide` on a translucent backdrop) come near them.

The layers are composited bottom to top onto an **empty** frame (all zero), each by the rule of L9. The result is then placed over the background with ordinary source-over:

- out = C·α + G·(1 − α), where C, α is the composite (straight colour, alpha) and G the background colour.

So a blend mode never blends with the background colour: where nothing lies below a layer, the layer's own colour shows.

`metadata.backgroundColor` is `#rrggbb`; `#rgb` is read as its doubled digits; absent means `#000000`. The background is opaque. Cases: `background/default`, `background/opaque`, `background/short-hex`. Any other string is **implementation-defined**: the display route hands it to the platform's colour parser, so `#3366cc80` gives a frame whose alpha is 128/255 everywhere nothing is drawn (`background/alpha`), and a colour the parser rejects leaves black; the float route reads anything but the two hex forms as black. **Native rule:** write `#rrggbb` only. A composition's own `backgroundColor` (protocol 14.2.1) is never drawn (L14).

**[L4] Occlusion (implementation-defined).** Before drawing, the engine looks for the topmost track holding an active item that **covers the frame**, and skips every track below it. An item covers the frame when all of these hold: it is a `video` or `image`; its blend mode is absent or `normal`; it has no `cornerPin` object; no crop side is above 0; its opacity is at least 1; its rotation modulo 360 is 0, 180 or −180; its `cornerRadius` is 0; and its box (L6) reaches within 1 pixel of all four frame edges. A video whose decoded stream carries alpha never covers. The search is off whenever a mask is active at the frame. The test does **not** look at the picture: a still with transparent or translucent pixels that covers the frame hides everything below it, and the background shows through its transparent parts. `blend/normal` pins this: its top layer is translucent, and the layer beneath is absent from the golden, while `blend/unknown-mode-is-normal`, whose top layer has a blend mode other than `normal`, shows the same two layers composited. A native client reproduces the rule.

## Placing an item

**[L5] Pictures: fit, crop and sampling.** A `video`, `image` or `lottie` item draws its source picture, s_w × s_h pixels (`sourceWidth` × `sourceHeight`; the media record's size when the item has none), into its box (L6), the rectangle with top-left (l, t) and size w × h:

1. **Fit.** The picture is contained in the box and centred: k = min(w / s_w, h / s_h); the fitted rectangle M has size m_w = s_w·k, m_h = s_h·k and top-left (l + (w − m_w)/2, t + (h − m_h)/2). The picture is never stretched and never covers: a box of another aspect leaves bars of nothing (`transform/box-wider-than-source`). There is no fit-mode field. A `composition` item is the exception: its picture is stretched to the whole box (L14).
2. **Crop.** `crop.left`, `right`, `top` and `bottom` are fractions of the picture, each clamped to [0, 1]; if left + right exceeds 0.999 both are scaled so that they sum to 0.999, and likewise top + bottom. The crop removes c_left = m_w·left pixels from the left of M, and so on. What remains stays where it was: the crop does not move or refit the picture. (`crop.refit: true`, which no protocol command writes, instead fits the cropped region into the box; preserve it.)
3. **Softness.** `crop.softness` s is clamped to [−1, 1]; σ = |s|·min(m_w, m_h) pixels. A side takes part only if its crop is above 0.
   - s < 0 softens inward: the kept rectangle is unchanged and each cropped side fades over F = σ pixels inside it.
   - s > 0 softens outward: each cropped side moves outward by F = min(σ, that side's crop in pixels), revealing that much of the cropped picture, and fades over those F pixels.
   - The **viewport** V is the kept rectangle (grown by the outward amounts), with its left and top rounded down and its right and bottom rounded up to whole pixels. The two feathers of an axis are scaled down together if their sum exceeds the viewport's size on that axis.
   - The fade multiplies alpha by a product of linear ramps: for a pixel centre (x, y), clamp((x − V_left)/F_left, 0, 1) on the left, clamp((V_right − x)/F_right, 0, 1) on the right, and the same for top and bottom.
   - `crop/softness-without-crop`: softness with no cropped side does nothing.
4. **Sampling.** A pixel takes the picture's value when its centre lies in V and in M (left and top edges inclusive, right and bottom exclusive). For a centre (x, y) the source position in texel-centre coordinates is u = (x − M_left)/m_w·s_w − 0.5 and v likewise; the value is the bilinear mix of the four surrounding texels of the **premultiplied** picture, with indices clamped to the picture (C2's filter and addressing). There are no mip levels: a picture drawn below half size aliases. Sub-pixel positions are not snapped: a box at a fractional position resamples the picture (`transform/translate-subpixel`).

Cases: `crop/left`, `crop/right`, `crop/top`, `crop/bottom`, `crop/all-sides`, `crop/fractional-edge`, `crop/softness-inward`, `crop/softness-outward`, `transform/scale-2`, `transform/scale-half`, `transform/default-fit`. Not pinned: the canonical backend's rasteriser computes bilinear weights more coarsely than a GPU does, so pictures at scales that are not a power of two are `edge` cases; and the edge of an unrotated picture is not anti-aliased on the canonical backend but may be on another (T6 applies).

**[L6] The item box, rotation, anchor and flips.** `transform` places an item. Every field is optional:

- `width`, `height`: the box size in composition pixels. Absent: the source picture contained in the frame, s_w·k × s_h·k with k = min(W / s_w, H / s_h) (a composition item uses `compositionWidth` × `compositionHeight` as its source); an item with no source size (a shape, a title) gets the frame size.
- `x`, `y`: the offset of the box **centre** from the frame centre, in pixels, default 0. The box's top-left is l = W/2 + x − w/2, t = H/2 + y − h/2.
- `rotation`: degrees, positive **clockwise** on screen, default 0.
- `anchorX`, `anchorY`: the pivot, in pixels from the box's top-left corner, default the box centre (w/2, h/2). The pivot is the point P = (l + anchorX, t + anchorY). The anchor does not move the box: it only chooses the point the rotation and the flips turn about.
- `flipHorizontal`, `flipVertical`: mirror the item about the vertical, respectively horizontal, line through P, in the item's own axes.
- `opacity` (L9), `cornerRadius` (L11). `aspectRatioLocked` is an editor preference, except that it changes how five shape types are drawn (L12).

The item is drawn as if unrotated and unflipped in its box, and every point q of that drawing appears at

- q′ = P + R(θ)·F·(q − P), with F = diag(−1 if flipHorizontal else 1, −1 if flipVertical else 1) and R(θ) the rotation that takes (1, 0) to (cos θ, sin θ) in the y-down frame.

That is: flips first, in the item's axes, then the rotation, both about P. Scale has no field of its own; it is the box size. The crop, the viewport, the softness ramps, the corner radius clip and a shape's outline all belong to the unrotated drawing and turn with it. Cases: `transform/identity`, `transform/rotate-30`, `transform/rotate-90`, `transform/anchor-rotate-30`, `transform/anchor-rotate-90`, `transform/scale-rotate`, `crop/rotated`, `flip/horizontal`, `flip/vertical`, `flip/both-cropped`, `flip/horizontal-rotated`. Rotated edges are anti-aliased by the platform rasteriser (`edge`).

**[L7] Transform parents.** An item with a `transformParent` follows another item's box. Write a **pose** {x, y, width, height, rotation} as the matrix

- M(p) = [[w·cos θ, −h·sin θ, x], [w·sin θ, h·cos θ, y], [0, 0, 1]],

which carries the unit square centred on the origin to the box (centre-relative coordinates; θ the rotation in radians). Let L be the item's own (local) pose from L6, with its keyframes applied at the frame. Then:

1. B = M(childWorldReference) · M(childLocalReference)⁻¹ · M(L). If M(childLocalReference) is singular (|determinant| < 10⁻⁶), B = M(L).
2. If `parentItemId` names an item of the same timeline **and** `parentReference` is present and M(parentReference) is invertible: B ← M(parent's world pose) · M(parentReference)⁻¹ · B. The parent's world pose is found by this same rule, recursively, at the same sequence frame, whether or not the parent is active, visible or drawn at that frame.
3. The item's world box is read back from B = [[a, c, e], [b, d, f]]: width = max(10⁻⁶, hypot(a, b)); height = max(10⁻⁶, |a·d − b·c| / width); rotation = atan2(b, a) in degrees; x = e; y = f. `anchorX` and `anchorY` are scaled by width / L.width and height / L.height; `cornerRadius` by the square root of the product of those two factors.

Inherited: position, size and rotation. **Not** inherited: opacity (`parent/opacity-is-not-inherited`), flips, crop, blend mode, effects and masks. Shear is lost in step 3, so a non-uniformly scaled, rotated parent does not shear its child. A parent that is missing leaves steps 1 and 3 (`parent/missing-parent`): the references alone re-pose the child. A cycle is cut where it closes: the item met a second time contributes its local pose only. Protocol 12.6.4 refuses to create a cycle. Cases: `parent/translate-scale`, `parent/rotated-chain`.

## Per-item stages

**[L8] Stage order, effects and adjustment layers.** A layer (L3) is produced in this order:

1. **Resolve** the item's box and other values at the frame (L6, L7). A `video` or `composition` item's `fadeIn` and `fadeOut` (seconds) multiply its opacity: with n the item's length in frames, r the frame counted from the item's first, F_in = min(fadeIn·fps, n) and F_out = min(fadeOut·fps, n), the factor is r/F_in while r < F_in, 1 − (r − (n − F_out))/F_out once r ≥ n − F_out, and 1 between. When the two ramps overlap (F_in ≥ n − F_out) the engine draws a single rise to the midpoint and fall from it instead: implementation-defined.
2. **Draw the content** into an empty W × H layer under the item transform of L6: the picture with its fit, crop and softness (L5), or the shape (L12, L13), or the title (`text.md`); clipped by the corner radius of the box (L11); multiplied by the opacity (L9). A corner-pinned item is warped in this stage (L11).
3. **Effects.** The effect stack runs on that layer.
4. **Masks** (L10) multiply the layer's alpha.
5. **Blend** (L9) composites the layer onto the layers below.

**The item's transform precedes its effect stack.** An effect receives a straight-alpha texture of the full composition size W × H that holds the item already fitted, cropped, flipped, rotated, corner-rounded, corner-pinned and multiplied by its opacity, and is transparent elsewhere. C1's W and H are therefore the composition's, an effect's uv and pixel sizes are measured on the frame and not on the item's box or source, and an effect can draw outside the item's box and reads transparency around it. `stage/pixelate-scaled`, `stage/pixelate-translated` and `stage/pixelate-opacity` pin this with closed forms (the blocks of `gpu-pixelate` sit on the frame's grid and average the item with the emptiness around it; the test shows that pixelating the source first fails); `stage/pixelate-rotated-cropped` and `stage/wave-rotated` show it for a rotated item. On the display route the texture an effect reads is 8 bits per channel; on the float route it is binary16 (C3).

The stack of an item is: the enabled effects of every active `adjustment` item on a visible track **above** the item's track (smaller `order`), tracks taken top to bottom and each adjustment's effects in array order; then the item's own enabled effects in array order (C3). An adjustment layer never affects items on its own track or above it (`stage/adjustment-layer`, `stage/adjustment-layer-not-above`), draws nothing itself, and its `transform` and `effectOpacity` are ignored. Because each item is processed alone, an adjustment layer is not a filter over the composite below it: a spatial effect acts on each item's layer separately, before those layers are blended. A temporal effect of an adjustment layer takes its clock (C8) from the adjustment item's first frame.

**[L9] Opacity and blend modes.** `transform.opacity` o is clamped to [0, 1]; a value that is not a finite number draws as 0. It multiplies the layer's alpha in stage 2, before effects, masks and blending (`opacity/0`, `opacity/0.5`, `opacity/1`). A shape's fill and stroke are each drawn with o (L13).

`blendMode` is one of the 25 ids of the parameter catalogue; absent, or any other string, is `normal` (`blend/unknown-mode-is-normal`). A mask shape is always `normal` (protocol 13.8.4). Compositing a layer with straight colour S and alpha a onto the backdrop with straight colour D and alpha b (the composite so far, L3), per pixel:

1. a_s = clamp(a, 0, 1). For `dissolve`, a_s becomes 1 if the pixel's threshold is below a_s, else 0 (below). Then a_s is multiplied by the pixel's matte (L10) if masks apply. If a_s ≤ 0 the backdrop is unchanged.
2. B = blend(clamp(D, 0, 1), clamp(S, 0, 1)), the mode's function below, per channel unless stated.
3. premultiplied result = B·b·a_s + S·a_s·(1 − b) + D·b·(1 − a_s); alpha α = a_s + b·(1 − a_s); colour = premultiplied result / α.

This is source-over in which the layer's colour is replaced by the blend where the backdrop is present. It is evaluated on encoded sRGB values, straight alpha, in binary32, and the running composite is stored as binary16. There are no groups and no pass-through: every layer blends with everything composited below it in the frame, and a blend inside a composition blends only within it (L14). Write d and s for one channel of the clamped D and S:

| Mode | blend(d, s) |
| --- | --- |
| `normal`, `dissolve` | s |
| `darken` | min(d, s) |
| `multiply` | d·s |
| `color-burn` | 0 if s = 0; else 1 − min(1, (1 − d)/max(s, 0.001)) |
| `linear-burn` | max(d + s − 1, 0) |
| `lighten` | max(d, s) |
| `screen` | 1 − (1 − d)(1 − s) |
| `color-dodge` | 1 if s = 1; else min(1, d/max(1 − s, 0.001)) |
| `linear-dodge` | min(d + s, 1) |
| `overlay` | 2·d·s if d ≤ 0.5; else 1 − 2(1 − d)(1 − s) |
| `soft-light` | d − (1 − 2s)·d·(1 − d) if s ≤ 0.5; else d + (2s − 1)(√d − d) |
| `hard-light` | 2·d·s if s ≤ 0.5; else 1 − 2(1 − d)(1 − s) |
| `vivid-light` | `color-burn`(d, 2s) if s ≤ 0.5; else `color-dodge`(d, 2(s − 0.5)) |
| `linear-light` | clamp(d + 2s − 1, 0, 1) |
| `pin-light` | min(d, 2s) if s ≤ 0.5; else max(d, 2(s − 0.5)) |
| `hard-mix` | 1 if d + s ≥ 1; else 0 |
| `difference` | \|d − s\| |
| `exclusion` | d + s − 2·d·s |
| `subtract` | max(d − s, 0) |
| `divide` | min(d/max(s, 0.001), 1) |

The four component modes work on whole colours, with the compositor's own helpers. They are **not** the helpers of C7:

- HSL(c): M = max, m = min of the channels, L = (M + m)/2. If M = m: (0, 0, L). Else δ = M − m; **S = δ/(M + m) if L > 0.5, else δ/(2 − M − m)** (the two cases are the reverse of the usual definition, so S can exceed 1; this is implementation-defined and pinned by `blend/hue` and `blend/saturation`); H as in C7's RGB→HSL.
- RGB(H, S, L): C7's HSL→RGB.
- LUM(c) = 0.3·R + 0.59·G + 0.11·B. SETLUM(c, l): r = c + (l − LUM(c)) on every channel; n = min(r), x = max(r), λ = LUM(r); if n < 0, r ← λ + (r − λ)·λ/(λ − n); then, if x > 1 (the maximum taken before the first correction), r ← λ + (r − λ)(1 − λ)/(x − λ).

| Mode | blend(D, S) |
| --- | --- |
| `hue` | RGB(H of S, S of D, L of D) |
| `saturation` | RGB(H of D, S of S, L of D) |
| `color` | SETLUM(RGB(H of S, S of S, 0.5), LUM(D)) |
| `luminosity` | SETLUM(D, LUM(S)) |

**Singular points (implementation-defined).** `color-burn` at d = 1, s = 0, `color-dodge` at d = 0, s = 1, `vivid-light` at either, and `hard-mix` at d + s = 1 exactly are discontinuities, and the engine's result there depends on rounding inside the GPU's texture filter: the two measured backends disagree. A native client may give either neighbouring value. No golden case sits on one.

**Dissolve.** The threshold of pixel (i, j) is HASH21(p) with p = ((i + 0.5)/W·8192, (j + 0.5)/H·8192), in binary32: q = fract((p.x, p.y, p.x)·0.1031); δ = q·(q.y + 33.33, q.z + 33.33, q.x + 33.33) (a dot product); q ← q + δ; HASH21 = fract((q.x + q.y)·q.z). The coverage is all or nothing and uses the pixel's total alpha (content alpha × opacity), the pattern depends only on the pixel's position, not on the frame number, and the matte of a mask multiplies afterwards. Because p reaches 8192 and the hash is chaotic, the pattern is reproducible bit for bit only where (i + 0.5)/W and (j + 0.5)/H are exact in binary32, that is for frame sizes that are powers of two; otherwise GPUs disagree on individual pixels. `blend/dissolve` is therefore `statistical`: all-or-nothing coverage and its density are pinned, the exact pattern is not.

Cases: one per mode, `blend/<mode>`, each the translucent `layer` input over the translucent `fx` input over a background; `blend/multiply-opacity-0.5`; `blend/screen-then-multiply` (two blended layers in sequence).

**[L10] Masks.** A `shape` item with `isMask: true` is a mask. It draws nothing. While it is active and its track is visible, it masks every layer of every track **below** its own (larger `order`): items, transitions, and through them their effects. It does not mask its own track or any track above (`mask/scope`). Its fill, stroke, blend mode, effects, flips and anchor are ignored.

The mask's **outline** is the shape's outline of L12 in the mask's box (L6, L7), with a pen path always closed (`mask/open-path-is-closed`), rotated by the box's rotation about the box **centre**. A mask's fields:

| Field | Type, range | Default when drawing | Meaning |
| --- | --- | --- | --- |
| `maskType` | `clip` or `alpha` | `clip` | `clip`: a hard edge. `alpha`: an anti-aliased edge, and the only type that feathers. |
| `maskInvert` | boolean | `false` | Keep the outside instead of the inside. |
| `maskOpacity` | number, 0..100 | 100 | Matte strength in percent, clamped to the range. |
| `maskFeather` | number, 0..100 | 0 | Feather in composition pixels (scaled by L1's min(s_x, s_y) at another drawing size). Ignored unless `maskType` is `alpha` (`mask/clip-ignores-feather`). |

The **matte** m(i, j) ∈ [0, 1] of one mask, with strength g = clamp(maskOpacity, 0, 100)/100 × the mask item's `transform.opacity` clamped to [0, 1] (`mask/item-opacity-scales-the-matte`):

- **Hard matte**, when `maskType` is `clip` and g = 1: m = 1 if the pixel centre is inside the outline (non-zero rule, edge rule of T6), else 0; inverted, the complement. No anti-aliasing on the canonical backend.
- **Soft matte**, otherwise: c = the fraction of the pixel the outline covers (anti-aliased fill); inverted, 1 − c inside the frame. If the feather φ is above 0, that coverage picture is blurred with a Gaussian of standard deviation φ pixels in x and in y, taking everything outside the frame as empty. Then m = g × the result.

So the feather is centred on the outline (half of the fall-off inside, half outside), is measured in composition pixels and not in the mask's or the source's own scale, and an inverted feathered matte also fades towards the frame's edges (`mask/feather-2-invert`), because outside the frame there is nothing to blur in. A matte strength below 1 scales the whole matte: with `maskOpacity: 50` the inside is half transparent and the outside is still removed (`mask/opacity-50`), and inverted the outside is half transparent (`mask/opacity-50-invert`). There is no `maskExpansion` field.

Masks apply in stage 4 of L8: the layer's alpha is multiplied by the matte of every mask above its track, one after another, so several masks intersect (`mask/two-masks-intersect`) and a mask multiplies whatever alpha the item already has (`mask/translucent-item`). A pen-path mask animated through `pathVertex:<n>:<component>` keyframes (protocol 13.2.5; components `positionX`, `positionY`, `inX`, `inY`, `outX`, `outY`) uses the interpolated vertices at the frame (`mask/animated-path`).

Cases: `mask/clip`, `mask/clip-invert`, `mask/alpha`, `mask/alpha-invert`, `mask/feather-2`, `mask/feather-6`, `mask/clip-ellipse`, `mask/alpha-ellipse`, `mask/clip-rotated`, `mask/path`. Not pinned: the platform's blur is an approximation of the Gaussian (the canonical backend's differs from the exact one by up to 0.033 in these cases, and the feather cases are `edge`); a native client uses a true Gaussian. **Implementation-defined:** a mask that carries a `cornerPin` is rasterised and warped; and an item that has both effects and masks is, on one path of the display route, masked before its effects as well as after (L16). A native client applies masks once, after the effects.

**[L11] Corner radius and corner pin.** `transform.cornerRadius` r, in composition pixels, at least 0, rounds the item's **box**: the content of stage 2 is clipped to the rounded rectangle of the box (l, t, w, h) with corner radius min(r, w/2, h/2), circular corners, turning with the item. It is the box that is rounded, not the picture inside it (`corner-radius/box-not-picture`: bars of L5 stay square-ended inside a rounded box), and a shape's own stroke is cut by it (`shape/rectangle/transform-corner-radius-clips`); round a shape with its own `cornerRadius` (L12). Cases: `corner-radius/4`, `corner-radius/clamped`. The clip edge follows T6 on the canonical backend; the hardware backend anti-aliases it (`edge`).

`cornerPin` warps a `video`, `image`, `composition` or title: `topLeft`, `topRight`, `bottomRight` and `bottomLeft` are offsets [dx, dy] in pixels that move the four corners of the **fitted picture** M of L5 (for a title, of its box). If `referenceWidth` and `referenceHeight` are present, the offsets are first scaled by m_w / referenceWidth and m_h / referenceHeight (`corner-pin/reference-size`). A `cornerPin` whose eight numbers are all 0 does nothing (but still switches occlusion off, L4). The warp is the projective map (homography) that takes the rectangle M to the quadrilateral of the moved corners: a point at fractions (u, v) of M goes to (X/Z, Y/Z) with

- g and h solving the usual two-equation system for the quadrilateral Q0 = top-left, Q1 = top-right, Q2 = bottom-right, Q3 = bottom-left (corner positions relative to M's top-left): with Δ1 = Q1 − Q2, Δ2 = Q3 − Q2, Σ = Q0 − Q1 + Q2 − Q3 and D = Δ1.x·Δ2.y − Δ1.y·Δ2.x: g = (Σ.x·Δ2.y − Σ.y·Δ2.x)/D, h = (Δ1.x·Σ.y − Δ1.y·Σ.x)/D;
- X = (Q1.x − Q0.x + g·Q1.x)·u + (Q3.x − Q0.x + h·Q3.x)·v + Q0.x, Y likewise with the y components, Z = g·u + h·v + 1.

|D| < 10⁻¹⁰ (a degenerate quadrilateral) draws the item unwarped. The content of the box is drawn first (fit, crop, softness, corner radius), then warped, then given the item's rotation, flips and opacity; masks of L10 are applied to such an item **before** the warp, in frame coordinates (implementation-defined). The engine draws pictures as a 16 × 16 mesh of affinely textured triangles, which approximates the projective map inside each cell and leaves the outline unsmoothed; neither is pinned. A native client samples the exact inverse map with L5's filter. Case: `corner-pin/image` (`edge`).

## Shapes

**[L12] Shape geometry.** A `shape` item that is not a mask draws its outline in its box (l, t, w, h), then turns with the item (L6). Let b = min(w, h). Five types have a **natural size** n_w × n_h: when `transform.aspectRatioLocked` is absent or `true`, the outline is drawn at natural size, centred in the box; when it is `false`, the outline is scaled by (w / n_w, h / n_h) so that its natural rectangle fills the box. Outline coordinates below are relative to the natural rectangle's (or the box's) top-left corner.

| `shapeType` | Outline | Natural size |
| --- | --- | --- |
| `rectangle` | The box. With `cornerRadius` c above 0: corner radius min(c, w/2, h/2), circular arcs. Starts at (radius, 0), runs clockwise. | none: always fills the box |
| `ellipse` | The ellipse with radii w/2 and h/2 centred in the box. Starts at the top centre, runs clockwise. | none: always fills the box |
| `circle` | The circle of radius b/2. Starts at the top centre, runs clockwise. | b × b |
| `triangle` | Equilateral, side b, height e = b·√3/2. `direction` `up` (default): (b/2, 0), (b, e), (0, e). `down`: (0, 0), (b, 0), (b/2, e). `left`: (e, 0), (e, b), (0, b/2). `right`: (0, 0), (e, b/2), (0, b). In that vertex order. | b × e for `up` and `down`, e × b for `left` and `right` |
| `star` | n = `points` (default 5) tips. 2n vertices: vertex k = 0 … 2n − 1 lies at angle k·π/n − π/2 from the centre (b/2, b/2), at radius b/2 for even k and (b/2)·`innerRadius` (default 0.5) for odd k. The first vertex is the top tip; the order is clockwise. | b × b |
| `polygon` | n = `points` (default 6) vertices at angle 2π·k/n − π/2 and radius b/2 from the centre (b/2, b/2). The natural rectangle is the circumscribed circle's square, not the polygon's bounding box, so a triangle or pentagon is not vertically centred (`shape/polygon/points-3`). | b × b |
| `heart` | Six cubic curves in a rectangle a × e with a = b and e = b/1.1, from the bottom tip up the left side: start (a/2, e); to (0, e/4) with controls (a/2 − 23a/110, 0.69e), (0, 0.6e); to (a/4, 0) with controls (0, 0.13e), (a/4 − 29a/220, 0); to (a/2, 0.17e) with controls (a/4 + 29a/220, 0), (a/2 − 5a/110, 0.07e); to (3a/4, 0) with controls (a/2 + 5a/110, 0.07e), (a/2 + 15a/110, 0); to (a, e/4) with controls (3a/4 + 29a/220, 0), (a, 0.13e); to (a/2, e) with controls (a, 0.6e), (a/2 + 23a/110, 0.69e). The right lobe is not the mirror of the left (15a/110 against 29a/220): implementation-defined. | a × e |
| `path` | The pen path of `pathVertices`, in the box: below. | none: the box |
| anything else | The box, as a `rectangle` with no corner radius. | |

`cornerRadius` (the shape's own field, pixels, at least 0) also rounds a `triangle`, `star` or `polygon`: at each vertex V with neighbours P and N, ρ = min(c, |VP|/2, |VN|/2); the outline runs straight to V + ρ·unit(P − V), then along a **quadratic** curve with control point V to V + ρ·unit(N − V) (not a circular arc). The radius is applied before any non-uniform scaling. `points` and `innerRadius` are used as given; the ranges a client writes, and what out-of-range values draw, are in the Fields section.

**Pen paths.** `pathVertices` is a list of vertices { `position`: [x, y], `inHandle`: [x, y], `outHandle`: [x, y], `tangentMode` }. Positions are fractions of the box (0 … 1 across w and h, values outside allowed); handles are offsets from their vertex in the same fractions; `tangentMode` (`corner`, `smooth`, `continuous`, `broken`) is an editing hint and does not change the drawing. The point of a vertex is (l + x·w, t + y·h). The segment from vertex i to vertex i + 1 is a straight line when vertex i's `outHandle` and vertex i + 1's `inHandle` are both (0, 0); otherwise it is the cubic curve with control points position_i + outHandle_i and position_{i+1} + inHandle_{i+1}. `pathClosed` absent or `true` adds the segment from the last vertex back to the first and closes the outline; `false` leaves it open. An empty list draws nothing.

Cases: `shape/<type>/fill` for all eight types; `shape/rectangle/corner-radius`, `shape/rectangle/corner-radius-clamped`, `shape/rectangle/rotated`, `shape/rectangle/subpixel`, `shape/circle/unlocked`, `shape/triangle/down`, `shape/triangle/left`, `shape/triangle/right`, `shape/triangle/unlocked`, `shape/triangle/corner-radius`, `shape/star/points-7-inner-0.3`, `shape/star/unlocked`, `shape/polygon/points-8-corner-radius`, `shape/heart/unlocked`, `shape/path/closed-straight`, `shape/path/open`.

**[L13] Fill, stroke, trim and taper.** The fill is drawn first, then the stroke over it.

- **Fill.** Drawn when `fillEnabled` is absent or `true`, `fillColor` is a non-empty string, and the outline is not an open pen path (`shape/path/open-ignores-fill`). Fill rule: non-zero. `fillColor` is a colour: `#rrggbb`, or `#rrggbbaa` whose alpha multiplies the fill (`shape/rectangle/translucent-fill`). With `fillType: "linear"` the fill is a two-stop linear gradient from `gradientStartColor` (default `fillColor`, then `#3b82f6`) to `gradientEndColor` (default `#8b5cf6`): with a = `gradientAngle` in degrees (default 0, clockwise, 0 runs left to right), direction d = (cos a, sin a) and e = 0.5/max(|d.x|, |d.y|, 10⁻⁶), the stops sit at the box fractions (0.5, 0.5) − e·d and (0.5, 0.5) + e·d, the colour varies linearly in encoded values along that line and is constant beyond its ends, and the gradient turns with the item (`shape/rectangle/linear-gradient`, `shape/rectangle/linear-gradient-45`).
- **Stroke.** Drawn when `strokeEnabled` is absent or `true`, `strokeWidth` is a number above 0 and `strokeColor` is a non-empty string; a shape with a width but no colour has no stroke (`shape/rectangle/stroke-without-color`). The stroke is **centred** on the outline: half of `strokeWidth` (composition pixels) inside, half outside, so it reaches outside the box. `strokeLineCap` (`butt`, `round`, `square`; default `butt`) ends open outlines; `strokeLineJoin` (`miter`, `round`, `bevel`; default `miter`) joins segments; `strokeMiterLimit` (above 0, default 4) turns a mitre whose length exceeds limit × half the width into a bevel; all three as in the SVG and Canvas 2D stroke model. The stroke is not scaled with an unlocked shape: it is applied to the scaled outline at its own width.
- **Opacity.** The fill and the stroke are each drawn with the item's opacity o, the stroke over the fill; where they overlap (the inner half of the stroke) the fill shows through the translucent stroke (`shape/rectangle/opacity-fill-stroke`).
- **Anti-aliasing.** Fill and stroke edges are anti-aliased by coverage. For an unrotated rectangle the coverage is exact: a pixel's alpha is the fraction of it inside the rectangle (`shape/rectangle/subpixel`, a reference case). For curves and slanted edges the platform rasteriser's coverage is not pinned; the outline is, and those cases are `edge`.

**Trim.** `trimPathStart` and `trimPathEnd` are percentages, each clamped to [0, 100], defaults 0 and 100; `trimPathOffset` is in degrees, 360 to the full outline, default 0. They affect the stroke only. With start 0 and end 100 the whole outline is stroked whatever the offset. Otherwise, with Λ the outline's length **as the engine estimates it** (below) and ν = ((end − start) mod 100)/100, the stroke is one dash of length ν·Λ that begins at the distance (start/100 + offset/360)·Λ along the outline from its starting point, in the outline's direction, and wraps around a closed outline (`shape/rectangle/trim-wraps`); start = end leaves a dash of length zero, which draws nothing with `butt` caps. Each end of the dash takes `strokeLineCap`. The starting points and directions are those of L12 (a rectangle starts at its top-left corner, after the corner's radius, and runs clockwise). The estimates:

- `rectangle`: 2(w + h − 4r) + 2π·r, exact. `circle`, `ellipse`: π·(3(α + β) − √((3α + β)(α + 3β))) for radii α, β (Ramanujan's approximation).
- `triangle`: 3b when locked; when unlocked, w + 2·hypot(w/2, h) for `up` and `down`, h + 2·hypot(w, h/2) for `left` and `right`.
- `star`, `polygon`: the perimeter of the sharp-cornered outline with n rounded to the nearest integer and at least 3; `heart`: 3.35·b.
- `path`: the length of the flattened path. A curve is flattened by halving it at its midpoint until both control points lie within 0.35 pixels of the chord, at most 12 levels deep.

Where the estimate is not the true length (a heart, an unlocked heart or circle, rounded corners), the trim's ends drift accordingly: implementation-defined, pinned by `shape/rectangle/trim-25-75`, `shape/rectangle/trim-offset-90`, `shape/ellipse/trim-0-50` and `shape/path/trim-20-80`.

**Taper.** `taperStartWidth` and `taperEndWidth` are percentages of the stroke width (at least 0, default 100); `taperStartLength` and `taperEndLength` are percentages of the visible stroke's length, clamped to [0, 100], default 0. The taper is active when a length is above 0 and its width is not 100. At the fraction π ∈ [0, 1] of the visible stroke the width is `strokeWidth` × σ(π), σ = σ_start·σ_end, where σ_start = ω_s + (1 − ω_s)·(100π / λ_s) while 100π < λ_s (ω_s = `taperStartWidth`/100, λ_s = `taperStartLength`), else 1, and σ_end is the same measured from the end.

- On a **pen path** the stroke becomes a filled outline: the flattened centre line (already rotated), offset to both sides by half the width at each point; `round` caps add a disc at each end, `square` extends the ends by the half-width (`shape/path/taper`).
- On every **other** type the visible stroke is cut into 48 equal pieces; piece k is stroked as a dash with butt ends at the constant width `strokeWidth` × σ((k + 0.5)/48), each piece lengthened by min(20 % of its length, 0.08 % of Λ) to hide the seams (`shape/rectangle/taper`).

The outline construction of the pen-path taper (its joins and its handling of a trim) is described here but not pinned beyond the golden.

## Other content, HDR and routes

**[L14] Compositions and other item types.** A `composition` item draws its composition (protocol 14.2.1) as a picture: the composition is assembled by L2 to L13 on its own empty canvas of `compositionWidth` × `compositionHeight`, at the composition frame its source window gives, and **without** a background (the composition's `backgroundColor` is ignored and the picture is transparent where nothing draws). That picture is then stretched to the item's whole box (not contained), cropped and softened as L5, and passes through L6 to L11 like any picture; the item's own effects, masks and blend mode apply to the composition as one layer. Inside a composition, masks and adjustment layers act on the composition's own tracks only. How blend modes of items inside a composition are composited is not specified here, and no golden covers composition items. A `text` or `subtitle` item's content is specified in `text.md`; it is placed by L6 and L7 and its layer passes through L8 to L11 unchanged. A `lottie` item is a picture (L5) rendered by the Lottie player.

**[L15] HDR projects.** A project in the linear HDR domain (C4) is assembled by the same rules, in linear values and on the float route, with two differences that a native client must keep: a frame in which any drawing item has a blend mode other than `normal` is refused (`HdrRenderUnavailableError`), as are the effects and transitions C4 and T5 refuse; and the background colour is the sRGB decoding of `backgroundColor`, composited as the bottom layer. What the float route draws differently (L16) is then the contract for HDR, since no other route exists there.

**[L16] Routes (implementation-defined).** The engine assembles a frame in three ways. A native client implements one behaviour, the display route's, and need not reproduce the others; the list tells an implementer why another surface of the product can differ.

1. **Display route, plain.** Used when no drawing item has a blend mode other than `normal`. Layers are rasterised with Canvas 2D and composited with 8-bit premultiplied source-over directly over the background. An item that has both effects and masks is masked before its effects and again after them, which squares a soft matte.
2. **Display route, blended.** Used as soon as one drawing item has another blend mode. Layers are still rasterised with Canvas 2D, then composited by L9's equation in a GPU compositor over an empty frame and placed over the background. Masks multiply once, after effects. This sub-route is what L3 and L9 describe; for `normal` layers the two sub-routes agree.
3. **Single item.** A frame with exactly one drawing layer, no mask, no transition and no GPU effect is drawn straight onto the background-filled canvas; a blend mode is then given to the platform's own compositing operator against the background colour, which is not L9's function.
4. **Float route.** Used for HDR projects, for the scopes and for the server render worker's stills. It differs from the display route in ways the goldens' `floatRoute` field measures:
   - the background is the bottom layer of the compositor, so blend modes blend with the background colour;
   - pictures and shapes are drawn by GPU shaders: rotation and flips turn about the **box centre** and ignore `anchorX` and `anchorY`; flips mirror the picture inside its cropped viewport, not about the pivot; picture edges are not anti-aliased, and corner radii and shape edges are smoothed over ±0.75 pixels of a distance function;
   - shapes are approximated: a `triangle` fills its whole box, `star` and `polygon` use a polar approximation without corner radii, a `heart` is an implicit curve, the stroke extends `strokeWidth` to each side of the outline (twice the display route's width), pen paths are limited to 32 flattened points and need round caps and joins, and a shape the shaders cannot draw falls back to the display route's rasteriser;
   - a background that is not `#rgb` or `#rrggbb` is black.

The DOM preview of the web editor is a fourth surface (CSS transforms and SVG) that follows L5 to L7 and L12; whenever a frame needs a blend mode, a mask on effects or a GPU effect, the editor shows the engine's display route instead.

## Fields

Every field this page reads, with the engine's default **when drawing** (an absent field draws as its default; commands may write other defaults, as protocol 17.1 does for a new mask's feather).

### Transform, crop and corner pin (any visual item)

| Field | Type | Range | Default | Rule |
| --- | --- | --- | --- | --- |
| `transform.x`, `transform.y` | number | any | 0 | L6: box centre offset from frame centre, pixels |
| `transform.width`, `transform.height` | number | above 0 | fitted source size, or the frame size | L6 |
| `transform.rotation` | number | 0..360 in normal form | 0 | L6: degrees, clockwise |
| `transform.anchorX`, `transform.anchorY` | number | any | width/2, height/2 | L6: pivot, pixels from the box's top-left |
| `transform.opacity` | number | 0..1 | 1 | L9 |
| `transform.cornerRadius` | number | at least 0 | 0 | L11: pixels, clips the box |
| `transform.flipHorizontal`, `transform.flipVertical` | boolean | | `false` | L6 |
| `transform.aspectRatioLocked` | boolean | | `true` | L12: draws `circle`, `triangle`, `star`, `polygon`, `heart` at natural size when true |
| `crop.left`, `crop.right`, `crop.top`, `crop.bottom` | number | 0..1 | 0 | L5: fraction of the picture; `video`, `image`, `composition` |
| `crop.softness` | number | −1..1 | 0 | L5: fraction of the fitted picture's smaller side; negative inward, positive outward |
| `crop.refit` | boolean | | `false` | L5 |
| `cornerPin.topLeft`, `topRight`, `bottomRight`, `bottomLeft` | [number, number] | any | [0, 0] | L11: corner offsets in pixels; all four are required when `cornerPin` is present |
| `cornerPin.referenceWidth`, `cornerPin.referenceHeight` | number | above 0 | the fitted picture's size | L11 |
| `transformParent.parentItemId` | id | an item of the same timeline | none | L7 |
| `transformParent.parentReference`, `childLocalReference`, `childWorldReference` | pose { x, y, width, height, rotation } | | | L7; the two child references are required |
| `blendMode` | string | the 25 catalogue ids | `normal` | L9 |
| `fadeIn`, `fadeOut` | number | at least 0, seconds | 0 | L8: `video`, `composition` |

### Shape fields (`type: "shape"`)

| Field | Type | Range | Default | Rule |
| --- | --- | --- | --- | --- |
| `shapeType` | string | `rectangle`, `circle`, `triangle`, `ellipse`, `star`, `polygon`, `heart`, `path` | required; an unknown value draws a rectangle | L12 |
| `fillColor` | colour string | `#rrggbb` or `#rrggbbaa` | none: an empty or absent value draws no fill | L13 |
| `fillEnabled` | boolean | | `true` | L13 |
| `fillType` | string | `solid`, `linear` | `solid` | L13 |
| `gradientStartColor` | colour string | | `fillColor`, else `#3b82f6` | L13, `fillType: "linear"` |
| `gradientEndColor` | colour string | | `#8b5cf6` | L13 |
| `gradientAngle` | number | −180..180 degrees written; see the ranges table | 0 | L13 |
| `strokeEnabled` | boolean | | `true` | L13 |
| `strokeColor` | colour string | `#rrggbb` or `#rrggbbaa` | none: no stroke without it | L13 |
| `strokeWidth` | number | 0..50 pixels written; see the ranges table | none: no stroke without it | L13: centred on the outline |
| `strokeLineCap` | string | `butt`, `round`, `square` | `butt` | L13 |
| `strokeLineJoin` | string | `miter`, `round`, `bevel` | `miter` | L13 |
| `strokeMiterLimit` | number | 1..20 written; see the ranges table | 4 | L13 |
| `trimPathStart` | number | 0..100, percent | 0 | L13 |
| `trimPathEnd` | number | 0..100, percent | 100 | L13 |
| `trimPathOffset` | number | −360..360 degrees written (360 = the whole outline); see the ranges table | 0 | L13 |
| `taperStartWidth`, `taperEndWidth` | number | 0..200, percent of the stroke width | 100 | L13 |
| `taperStartLength`, `taperEndLength` | number | 0..100, percent of the visible stroke | 0 | L13 |
| `cornerRadius` | number | 0..100 pixels written; see the ranges table | 0 | L12: `rectangle`, `triangle`, `star`, `polygon` (not `transform.cornerRadius`) |
| `direction` | string | `up`, `down`, `left`, `right` | `up` | L12: `triangle` |
| `points` | integer | 3..12 written; see the ranges table | 5 for `star`, 6 for `polygon` | L12 |
| `innerRadius` | number | 0.1..0.9 written; see the ranges table | 0.5 | L12: `star`, ratio of the outer radius |
| `pathVertices` | array of vertex | 2 to 1000 vertices to draw a stroke, 3 for a fill or mask | none: nothing is drawn | L12: `path` |
| `pathVertices[].position` | [number, number] | fractions of the box | required | L12 |
| `pathVertices[].inHandle`, `outHandle` | [number, number] | fractions of the box, relative to the vertex | required; [0, 0] is a corner | L12 |
| `pathVertices[].tangentMode` | string | `corner`, `smooth`, `continuous`, `broken` | absent | editing hint only |
| `pathClosed` | boolean | | `true` | L12: `path`; a mask is always closed |
| `isMask` | boolean | | `false` | L10 |
| `maskType` | string | `clip`, `alpha` | `clip` | L10 |
| `maskFeather` | number | 0..100, pixels | 0 | L10: `alpha` masks only |
| `maskOpacity` | number | 0..100, percent | 100 | L10 |
| `maskInvert` | boolean | | `false` | L10 |

### Colours and their alpha

A fill or stroke colour is `#rrggbb` or `#rrggbbaa` (the forms `shape.add` and `shape.setStyle` accept and store as given); the digits are sRGB-encoded values k/255 and the last pair, when present, is a straight alpha a_c = k/255 (absent: 1). The engine applies it in stage 2 of L8, when the shape is painted into its layer:

- A paint (the fill, then the stroke) covers a pixel with alpha a_c × coverage × o, where coverage is the anti-aliased coverage of L13 and o the item's opacity (L9), and with the colour's RGB unchanged. It is composited source-over onto what the layer already holds, in premultiplied form: layer ← paint·α + layer·(1 − α) on premultiplied channels, α being that alpha.
- So the colour's alpha, the coverage and the opacity are simply multiplied; the colour is premultiplied by that product only as it enters the 8-bit premultiplied layer (L3). Nothing is premultiplied in the stored graph.
- The stroke is painted after the fill with its own alpha: a translucent stroke shows the fill through its inner half and the layers below through its outer half (`shape/rectangle/translucent-stroke`), and a translucent fill under an opaque stroke is hidden there.
- Effects, masks and the blend then see the layer's alpha like any other (L8): a colour's alpha is not kept apart from coverage or opacity after stage 2.
- The two gradient stops take the same forms. Between them the fill is interpolated on **straight** values: at the fraction τ of the gradient line the colour is (1 − τ)·RGB_start + τ·RGB_end and the alpha (1 − τ)·a_start + τ·a_end, each linear, and that pair is then painted as above (`shape/rectangle/linear-gradient-alpha`, on which both measured backends agree; premultiplied interpolation is off by up to 0.19 there). `fillColor`'s own alpha is not used when `fillType` is `linear`, unless `fillColor` stands in for an absent `gradientStartColor`.
- Hex digits may be in either case.
- With a mask (L10) the matte multiplies the layer's alpha afterwards, so over an empty backdrop a pixel's final alpha is a_c × coverage × o × the product of the mattes above it, each matte carrying its own `maskOpacity`. A shape that is itself a mask ignores its colours altogether: only its outline, `maskOpacity` and `transform.opacity` shape the matte.

Cases, all with closed-form references: `shape/rectangle/translucent-fill` (8-digit fill), `shape/rectangle/translucent-stroke` (8-digit stroke over an opaque fill), `shape/rectangle/translucent-fill-stroke-opacity` (both, at opacity 0.5). The conformance fixtures `shape.add/colour-with-alpha` and `shape.setStyle/colour-with-alpha` store such colours; this section says what they draw.

`metadata.backgroundColor` is different: it is `#rrggbb` and opaque (L3). An 8-digit background is implementation-defined: on the display route its alpha becomes the frame's alpha where nothing is drawn (the frame's alpha is α + a_c·(1 − α) for composite alpha α, `background/alpha`), it is not multiplied with anything else, and the float route draws black instead. **Native rule:** never write one.

When reading a graph written by another client, the display route accepts whatever the platform's colour parser accepts (names, `rgb()`), and the float route only `#rgb`, `#rrggbb`, `#rrggbbaa` and `rgb()`/`rgba()` lists; a string neither accepts is implementation-defined (the rasteriser keeps its previous paint). **Native rule:** write `#rrggbb` or `#rrggbbaa` only.

### Ranges a client writes, and what the renderer does outside them

The commands accept the web editor's control ranges (protocol 17.5), which are narrower than what the renderer tolerates. A native client offers in its UI, and writes, the first range. When it **reads** a graph (written by the web editor or an older client), it draws values outside that range as the last column says, which is what the engine does; the engine does not clamp them unless stated.

| Field | A client writes | The renderer, reading a value outside it |
| --- | --- | --- |
| `points` | integer 3..12 | Used as given, not clamped and not rounded for the outline. Above 12: that many tips or sides (`shape/star/points-20`). A `polygon` with fewer than 3 vertices, or a `star` with fewer than 3 outline vertices (points below 1.5), draws nothing, fill or stroke (`shape/polygon/points-2`). A fraction n gives the vertices k = 0, 1, … below n (polygon) or below 2n (star) at L12's angles, so the outline closes with one irregular side (`shape/star/points-5.5`): implementation-defined. Only the trim's length estimate rounds n and raises it to 3 (L13). |
| `innerRadius` | 0.1..0.9 | Used as given: the inner vertices sit at (b/2)·innerRadius whatever the value. Above 1 they lie outside the tips' circle, and outside the natural rectangle, which still positions the star (`shape/star/inner-radius-1.5`); 0 puts them on the centre; a negative value mirrors them through it. |
| `gradientAngle` | −180..180 degrees | Used as given; only its cosine and sine matter, so the angle is periodic in 360 (`shape/rectangle/linear-gradient-405` equals the 45 degree case). A value that is not a finite number draws as 0. |
| `strokeWidth` | 0..50 | 0, a negative value or a non-number: no stroke. Above 50 is used as given. |
| `strokeMiterLimit` | 1..20 | Any value above 0 is used as given (below 1 every mitre becomes a bevel). 0 or a negative value is rejected by the platform's stroke model, which then keeps its own current limit: implementation-defined, not rendered here. |
| `trimPathStart`, `trimPathEnd` | 0..100 | Clamped to [0, 100]. |
| `trimPathOffset` | −360..360 degrees | Used as given; 360 is one turn of the outline, so the value is periodic in 360. |
| `taperStartWidth`, `taperEndWidth` | 0..200 | Below 0 draws as 0. Above 200 is used as given. |
| `taperStartLength`, `taperEndLength` | 0..100 | Clamped to [0, 100]. |
| `cornerRadius` (shape) | 0..100 | 0 or negative: sharp corners. Above 100 is used as given; any value is limited by the shape (L12). |
| `transform.cornerRadius` | at least 0 | 0 or negative: no clip. Large values are limited to half the box's smaller side (L11). |
| `transform.opacity` | 0..1 | Clamped to [0, 1]; not finite draws as 0 (L9). |
| `crop.left`, `right`, `top`, `bottom` | 0..1 | Clamped to [0, 1], not finite draws as 0, then the pair rule of L5. |
| `crop.softness` | −1..1 | Clamped to [−1, 1]; not finite draws as 0. |
| `maskOpacity` | 0..100 | Clamped to [0, 100]. |
| `maskFeather` | 0..100 | 0 or negative: no feather. Above 100 is used as given. |
| `shapeType`, `direction`, `maskType`, caps and joins | the listed strings | An unknown `shapeType` draws a rectangle; an unknown `direction` is not specified here; an unknown cap or join is rejected by the platform's stroke model, which keeps its current one (implementation-defined). |
| `blendMode` | the 25 catalogue ids | Any other string draws as `normal` (L9). |

## What is not specifiable

- **Anti-aliased coverage** of curved, slanted and rotated edges (shapes, rotated pictures, soft mattes, corner radii on a hardware backend): it belongs to the platform rasteriser. Pinned: the geometry, exactly, and the result within the `edge` goldens. Unrotated rectangles and unrotated picture edges are pinned exactly.
- **Bilinear weights** at scales that are not powers of two (L5) and the **mask feather's blur kernel** (L10): the canonical backend approximates; a native client uses the exact filter and passes the `edge` cases.
- **The dissolve pattern** at frame sizes that are not powers of two (L9): density and all-or-nothing coverage are pinned.
- **Blend singular points** (L9), the **corner-pin mesh** (L11), the **tapered pen-path outline** and the **trim length estimates** of rounded shapes (L13): described; pinned only as far as their goldens go.
- **Composition items** (L14) and video frame selection have no goldens here.

## Checks

- `node --test studio/tools/layer-goldens.test.mjs` (engine-free) verifies the goldens' structure, inputs and measured tolerances; that every blend mode of the catalogue, every mask mode, every shape type with fill, stroke and both, every cap and join, and the stage-order cases are present; that the reference renderer written from this page reproduces all 92 reference cases, and rejects a wrong mode, a wrong crop side, a wrong layer order, an inverted mask and effects applied before the transform; and that this page contains no engine source text.
- `node studio/tools/layer-goldens.browser.mjs` (needs the prepared engine and WebGPU) renders every case through the engine's frame renderer on the canonical backend and fails when one leaves its tolerance.
