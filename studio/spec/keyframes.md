# Studio render spec: keyframe interpolation (native-app contract)

**Status: native-app contract.** This page specifies the value a keyframed property has at a frame. The [Studio graph protocol](../../docs/docs/developer/studio-graph-protocol-v1.md) says which keyframes a graph may hold (13.2.4 to 13.2.6) and how commands write them (13.5). It names the easings but does not say what they compute. This page does, together with `goldens/keyframes.json`. The native Frameleaf Studio apps implement interpolation from this page and those goldens, and must not read engine source.

It follows the rules of the [render spec](README.md): it is a clean-room description, as mathematics and prose, of the engine pinned there; it contains no engine source text, and a test enforces that. Where the engine's behaviour is accidental, the page says **implementation-defined** and describes what the engine does. A native client reproduces implementation-defined behaviour when it draws a graph, and follows the **native rule**, where one is given, when it writes one.

Rules are tagged K1 to K16 so that other pages and tests can cite them.

## Conventions

**[K1] Terms and arithmetic.**

- A **group** is the ordered keyframe list of one property of one clip: a scalar group `{ property, keyframes }` in `properties`, or a vector group in `vectorProperties` (protocol 13.2.4). The order is the array order of the graph.
- A scalar keyframe is `{ id, frame, value, easing }` with an optional `easingConfig`. A vector keyframe has `value: { x, y }` and optional `easingConfig`, `temporalEase` and `spatial`. `id` is never read by interpolation.
- **f** is the frame asked for, counted from the clip's first frame like a keyframe's `frame` (protocol 13.2.4): for sequence frame F and a clip starting at `from`, f = F − `from`.
- The **static value** is the value the property has when the clip has no keyframes: the clip's own field (K15 lists them).
- Every quantity is an IEEE 754 binary64 number. Formulas are evaluated exactly as written, left to right, with the grouping shown; there is no fused multiply-add and no extended precision. Under that reading, every rule built from +, −, ×, ÷ and comparisons gives the same bits on every platform, and the goldens pin it bit for bit (K16).
- clamp(v, a, b) = max(a, min(b, v)).
- "Present" means the field exists and is an object. "Absent" means it is missing.

## Easing

**[K2] Eased progress.** A segment runs from a keyframe **A** to the next keyframe **B** of the group. Its linear progress is t = (f − A.frame) ÷ (B.frame − A.frame). The **eased progress** e is a function of t and of A's `easing` and `easingConfig`. B's easing plays no part in this segment: an easing shapes the motion from its own keyframe to the next (protocol 13.2.6), and the easing of a group's last keyframe is never read.

First, t ← clamp(t, 0, 1). Then e is given by the easing **name** N chosen by K3:

| N | e |
| --- | --- |
| `linear` | t |
| `ease-in` | t × t |
| `ease-out` | t × (2 − t) |
| `ease-in-out` | 2 × t × t when t < 0.5; otherwise −1 + (4 − 2 × t) × t |
| `hold` | 0, for every t including 1 |
| `cubic-bezier` | K5 |
| `spring` | K6 |
| any other string | t |

These are not the CSS curves of the same names: `ease-in`, `ease-out` and `ease-in-out` are the quadratics above. `ease-in-out` is continuous at t = 0.5, where both branches give 0.5.

**[K3] Which name and which parameters.**

- When `easingConfig` is present, N is `easingConfig.type`, and the keyframe's own `easing` is not read. This is **implementation-defined**: the protocol keeps the two equal (13.2.6), and fixtures `easing/config-type-wins/…` record what happens when they differ. One exception is in K10: a vector keyframe's `hold` is read from `easing` alone.
- When `easingConfig` is absent, N is `easing`.
- `cubic-bezier` takes its four points from `easingConfig.bezier`. When `easingConfig` or its `bezier` is absent, the points are the catalogue default (0.42, 0, 0.58, 1). This is how a `cubic-bezier` stored without parameters draws (protocol 13.5.1).
- `spring` takes `tension`, `friction` and `mass` from `easingConfig.spring`. When `easingConfig` or its `spring` is absent, they are 170, 26 and 1. Defaults are applied to the whole object only: a `spring` object that lacks one of its three fields is used as it is, and K6 then gives a result that is not a number (fixture `easing/spring/config-without-mass/t=0.5`). **Implementation-defined.**
- No parameter is clamped or checked when drawing. Values outside the ranges of protocol 13.2.6 go into the formulas unchanged.

**[K4] Shape of the closed forms.** `linear`, `ease-in`, `ease-out` and `ease-in-out` give 0 at t = 0 and 1 at t = 1, and stay within 0…1. `hold` gives 0 throughout, so a held segment shows A's value until f reaches B.frame, where K7 gives B's value.

**[K5] `cubic-bezier`.** Points (x1, y1, x2, y2). The curve is the cubic Bezier through (0, 0), (x1, y1), (x2, y2), (1, 1), read as y against x:

1. If t = 0, e = 0. If t = 1, e = 1. These two results do not depend on the points.
2. c_x = 3 × x1; b_x = 3 × (x2 − x1) − c_x; a_x = 1 − c_x − b_x. Likewise c_y = 3 × y1; b_y = 3 × (y2 − y1) − c_y; a_y = 1 − c_y − b_y.
3. Solve x(s) = t for the curve parameter s by Newton's method. Start with s = t. Repeat **at most 8 times**:
   - err = ((a_x × s + b_x) × s + c_x) × s − t. If |err| < 10⁻⁶, stop.
   - slope = (3 × a_x × s + 2 × b_x) × s + c_x. If |slope| < 10⁻⁶, stop.
   - s ← clamp(s − err ÷ slope, 0, 1).
4. e = ((a_y × s + b_y) × s + c_y) × s.

There is no bisection fallback and no final check: after 8 steps, or after an early stop, the current s is used whatever its error. 3 × a_x × s is (3 × a_x) × s, and 2 × b_x is exact. This is the solver of T1 in the [render spec](README.md), with the same constants.

- **y outside 0…1.** y1 and y2 are not clamped, so e may leave 0…1 (overshoot and anticipation), and the value then passes beyond A's or B's value. Fixtures `easing/cubic-bezier/overshoot/…`, `…/anticipate/…`, `…/back-in-out/…`.
- **x outside 0…1.** x1 and x2 are not clamped either. The protocol refuses such points (13.5.4), but a graph may hold them; the steps above still run and give the fixture values `easing/cubic-bezier/x-out-of-range/…`. **Implementation-defined.** **Native rule:** write x1 and x2 in 0…1.
- Because of the 10⁻⁶ stopping rule, e is not the exact curve value: for points (0, 0, 1, 1), t = 0.25 gives 0.25000000143119466. A native client must run these steps, not a more accurate solver.

**[K6] `spring`.** Parameters k (`tension`), c (`friction`) and m (`mass`). The curve is the response of a damped spring released from rest at 0 towards 1, over a time span scaled to the spring's own decay:

1. If t = 0, e = 0. If t = 1, e = 1.
2. ω = √(k ÷ m). ζ = c ÷ (2 × √(k × m)). The time span is S = 4 ÷ (ζ × ω), and τ = t × S. (For 0 < ζ, ζ × ω × S = 4: the segment always spans four decay times of the envelope, whatever its length in frames. The spring has no notion of seconds; changing a segment's duration stretches the same curve.)
3. The raw value v depends on ζ:
   - **ζ < 1 (under-damped):** ω_d = ω × √(1 − ζ × ζ); v = 1 − exp(−ζ × ω × τ) × (cos(ω_d × τ) + ((ζ × ω) ÷ ω_d) × sin(ω_d × τ)).
   - **ζ = 1 exactly (critically damped):** v = 1 − exp(−ω × τ) × (1 + ω × τ).
   - **otherwise (over-damped, and every case where ζ is not a number):** r = √(ζ × ζ − 1); s₁ = −ω × (ζ − r); s₂ = −ω × (ζ + r); v = 1 − (s₂ × exp(s₁ × τ) − s₁ × exp(s₂ × τ)) ÷ (s₂ − s₁).
4. e = max(0, min(1.2, v)). When v is not a number, e is not a number.

The branch test is on the computed binary64 ζ. For example, k = 100, c = 20, m = 1 gives ζ = 1 exactly and takes the critical branch.

The following are all **implementation-defined**; a native client reproduces them when it draws:

- **The end jump.** Step 1 forces e = 1 at t = 1, but the formula does not reach 1 there. The default spring (170, 26, 1) gives 0.9101… at t = 0.999 and 1 at t = 1. A strongly over-damped spring is far short: (170, 26, 0.1) gives 0.164 at t = 0.999. The value therefore jumps on the frame of the next keyframe.
- **The 1.2 ceiling and the 0 floor.** An under-damped spring that overshoots past 1.2 is cut flat at 1.2 (fixture `easing/spring/bouncy/t=0.1`). Nothing is cut at 1.
- **`friction` 0, `tension` 0, or `mass` 0.** For 0 < t < 1 the result is not a number (NaN): with `friction` 0, S is infinite and the exponent is 0 × ∞; with `tension` 0, ζ is infinite or 0 ÷ 0; with `mass` 0, ω is infinite. The interpolated property value is then NaN on every frame strictly inside the segment, and A's and B's values on their own frames. The protocol's ranges allow `tension` 0 and `friction` 0 (13.2.6). What the renderer draws from a NaN property is not specified by this page. **Native rule:** never write a spring with `tension` 0 or `friction` 0, and do not offer them in a control.
- **Negative `friction`** makes S negative and the curve is evaluated backwards in time (fixture `easing/spring/negative-friction/…`). Out-of-range positive values are used unchanged (`easing/spring/out-of-range/…`).

√ is correctly rounded by IEEE 754; exp, cos and sin are not, so spring values carry a tolerance in the goldens (K16).

## Scalar groups

**[K7] Value of a scalar group at f.** Let the group's keyframes be K₀ … Kₙ₋₁ in array order, and let the static value be b.

1. n = 0 (an empty group, or no group): the value is b.
2. n = 1: the value is K₀.value, for every f.
3. f ≤ K₀.frame: the value is K₀.value (before and on the first keyframe).
4. f ≥ Kₙ₋₁.frame: the value is Kₙ₋₁.value (on and after the last keyframe).
5. Otherwise, take the **lowest** index i with Kᵢ.frame ≤ f and Kᵢ₊₁.frame > f. With A = Kᵢ and B = Kᵢ₊₁, t and e as in K2, the value is A.value + (B.value − A.value) × e.
6. If no index satisfies step 5, the value is b. With finite frames this cannot happen; it is reachable only when a `frame` is not a number.

The tests are applied in this order. In a well-formed group (ascending frames, one keyframe per frame, protocol 13.2.4) this is ordinary piecewise interpolation: each segment is half-open, [A.frame, B.frame), so on a keyframe's own frame the value is that keyframe's value exactly, and the segment that starts there uses that keyframe's easing.

There is no extrapolation: outside the group's first and last frames the value is constant.

**[K8] Groups that are not well-formed.** The engine does not sort or de-duplicate before interpolating, and K7 is applied to the array as it stands. **Implementation-defined**; the cases matter only for graphs written by other software, and the goldens pin them.

- **Two keyframes on one frame**, in the interior: the segment ending at the earlier one of the pair runs normally and approaches its value; on the shared frame and after it, step 5 picks the segment that starts at the **later** one of the pair. The value jumps from the earlier one's value to the later one's on that frame (fixtures `scalar/same-frame/interior/…`).
- **At the start**: on and before the shared frame the value is K₀.value (step 3); just after it, the segment from K₁ applies (`scalar/same-frame/at-start/…`).
- **At the end**: on and after the shared frame the value is the last keyframe's (step 4).
- **Unsorted frames**: K₀ and Kₙ₋₁ still bound the range in steps 3 and 4 whatever their frames, and step 5 scans adjacent pairs in array order and uses the first pair that brackets f. Pairs whose frames descend never bracket anything (`scalar/unsorted/…`).

**Native rule:** write groups in ascending frame order with one keyframe per frame.

**[K9] Frames and rounding.**

- f need not be a whole number. The picture is evaluated at whole frames, but other callers (the editor's graphs, speed sampling) ask between frames, and every rule here holds for any finite f. The goldens include fractional frames.
- **No rounding is applied to the result**, and it is not clamped to the property's range. Any snapping, clamping or sanitising belongs to the consumer of the value (for an effect parameter, C9 of the render spec).
- Nothing is cached between frames: the value at f depends only on the group, f and b.

## Vector groups

**[K10] Value of a vector group at f.** A vector group (`position`, `scale` or `anchor`) is evaluated as a whole. With static value b = (b.x, b.y):

1. Steps 1 to 4 and 6 of K7 apply unchanged, with `{ x, y }` values taken whole. K8 applies as well.
2. Otherwise A and B are chosen by step 5 of K7.
3. **Hold.** If A.`easing` is the string `hold`, the value is A.value. This test reads the keyframe's `easing` field only. It comes before everything else: a held vector keyframe ignores its `temporalEase` and `spatial`.
4. Otherwise t is the linear progress, u is the **timed progress** of K11, and the value is the point of K12 at u.

**Implementation-defined:** a vector keyframe whose `easing` is not `hold` but whose `easingConfig.type` is `hold` is not held by step 3. Without temporal handles it still shows A's value (K3 gives u = 0); with them it moves (fixtures `vector/hold/via-config-only-…`).

**[K11] Timing of a vector segment (`temporalEase`).** Let **out** be A.`temporalEase.out` and **in** be B.`temporalEase.in`. Only these two handles shape the segment from A to B; A's `in` and B's `out` belong to the neighbouring segments.

- If both are absent, u = e of K2, from A's `easing` and `easingConfig`.
- Otherwise the handles define a cubic timing curve, and **A's `easing` and `easingConfig` are not used at all** (except the hold test of K10).

When at least one handle is present:

1. **Rate.** R is the frame rate used to turn frames into seconds. It is the project rate when the renderer evaluates the clip with the composition's other clips at hand, which preview and export do. When the engine evaluates a clip without that context, R is 30 whatever the project rate. **Implementation-defined.** Then R ← max(1, R). **Native rule:** use the project rate.
2. **Duration and distance.** T = (B.frame − A.frame) ÷ R, in seconds. D is the Euclidean distance between the two values, D = √(Δx² + Δy²) with Δx = B.x − A.x and Δy = B.y − A.y. It is the length of the straight chord, **not** of the spatial path of K12, even when the segment has one. When Δx or Δy is zero, D is exactly the magnitude of the other.
3. **Degenerate segment.** If T ≤ 0 or D ≤ 2⁻⁵², the handles are ignored and u = e of K2, as if they were absent. So handles do nothing on a segment whose two values are equal, even if a spatial path makes the point move.
4. **Average speed.** V = D ÷ T, in property units per second.
5. **Each handle** gives an influence ι and a speed σ:
   - ι = clamp(`influence`, 0, 100) ÷ 100. When the handle, or its `influence`, is absent, `influence` is 100 ÷ 3 (the binary64 quotient, 33.333333333333336).
   - σ = max(0, `speed`). When the handle, or its `speed`, is absent, σ = V.
   - `speed` is in **property units per second**: pixels per second for `position` and `anchor`, percent per second for `scale`. A negative speed counts as 0.
6. **The curve.** With (ι_o, σ_o) from **out** and (ι_i, σ_i) from **in**, the timing curve is the cubic of K5 with points

   x1 = ι_o, y1 = ι_o × (σ_o ÷ V), x2 = 1 − ι_i, y2 = 1 − ι_i × (σ_i ÷ V)

   and u is K5's result for t, using the same solver and the same shortcuts at t = 0 and t = 1.

Consequences, all pinned by fixtures:

- **One side present.** The absent side behaves as a handle of influence 33.33…% at the average speed: its control point lies on the diagonal, at (1⁄3, 1⁄3) or (2⁄3, 2⁄3) within rounding.
- **Speed 0** puts the control point on the horizontal: the motion starts or ends at rest. **Speed equal to V on both sides** with the default influence is the straight line u ≈ t, though not bit for bit.
- **Speed above V ÷ ι** makes y1 exceed 1 (or y2 fall below 0): u leaves 0…1, and the value overshoots the segment along the line or path.
- The slope of u at t = 0 is σ_o ÷ V when ι_o is above 0, so the motion leaves A at speed σ_o measured along the chord. Changing R changes V and so the curve; changing the segment's length in frames does too.
- x1 and x2 are not ordered: influences that sum to more than 100 % give x1 > x2, and K5 runs unchanged.

D uses a library distance routine that IEEE 754 does not require to be correctly rounded. D reaches the result only through σ ÷ V for a handle that states a speed above 0, so such cases with Δx and Δy both non-zero carry a tolerance (K16); every other temporal case is exact.

**[K12] The point at u (`spatial`).** Let P₀ = A.value and P₃ = B.value.

- **Straight segment.** For `scale` and `anchor` always, and for `position` when neither A nor B has `spatial`: each component is P₀ + (P₃ − P₀) × u.
- **Path segment.** For `position` when A or B (or both) has `spatial`: the path is the cubic Bezier with control points

  P₁ = P₀ + A.`spatial.outTangent`, P₂ = P₃ + B.`spatial.inTangent`

  where a keyframe without `spatial` contributes the tangent (0, 0). Tangents are offsets from their own keyframe's value, in property units. With w = 1 − u, the four weights are

  w₀ = w × w × w, w₁ = 3 × w × w × u, w₂ = 3 × w × u × u, w₃ = u × u × u

  and each component is w₀ × P₀ + w₁ × P₁ + w₂ × P₂ + w₃ × P₃, summed left to right.

**The path is parameterised by the curve parameter, not by arc length.** u is used directly as the Bezier parameter. There is no arc-length table, no sampling and no re-timing: equal steps of u are not equal distances along the path, and the speed along the path follows from the control points as well as from the timing.

Consequences:

- **`spatial` with zero tangents is not the straight segment.** P₁ = P₀ and P₂ = P₃ give P₀ + (P₃ − P₀) × (3u² − 2u³): the point stays on the chord but eases in and out. Merely adding `spatial` to either keyframe changes the timing (fixtures `vector/spatial/zero-tangents-are-not-a-straight-lerp/…`). **Implementation-defined.** The path segment equals the straight one only when each tangent is one third of the chord, pointing along it.
- A's `inTangent` and B's `outTangent` are not read for this segment; they belong to the neighbours.
- u outside 0…1 (K5 overshoot, K6 up to 1.2, K11) is put into the same polynomial, so the point runs past the end of the path along the cubic's own continuation.
- `spatial` on a `scale` or `anchor` keyframe is ignored (`vector/spatial/ignored-on-scale/…`).

**[K13] `continuous`, and what is not read.** `spatial.continuous` is an editing constraint (protocol 13.5.3 checks that continuous tangents mirror each other when they are written). Interpolation never reads it: `true`, `false` and absent draw the same, and tangents that do not mirror each other are used as stored even under `continuous: true` (fixtures `vector/spatial/curved/continuous-…`, `…/continuous-true-with-unmirrored-tangents/…`). The speed graph shown in the web editor is measured from these same rules by finite differences; it is a display and defines nothing.

## Colour keyframes

**[K14] A colour parameter of an effect.** An effect parameter of kind colour that the catalogue marks animatable is keyframed in a scalar group `effect:<gpuEffectType>:<effect id>:<parameter>` (protocol 13.2.5). Its keyframe `value` is a **packed colour**, and it is interpolated in OKLCH, not by K7's arithmetic on the packed number.

*Packed colours.* N(v) normalises a stored number: a value that is not finite becomes 0; otherwise v is rounded to the nearest integer, halves upward; a result up to 16777215 is clamped below at 0; a result between 16777216 and 2³² − 1 becomes 16777215; a larger result is capped at 2³² + 4294967295. A normalised value below 2³² is an opaque colour 0xRRGGBB with alpha 255. A value from 2³² up is 2³² + 0xRRGGBBAA and **has alpha**. Its hex form is `#rrggbb` or `#rrggbbaa`, lower-case.

*Selection.* K7 steps 1 to 6 choose the result, with these readings: the static value is the parameter's own hex string, and steps 1 to 4 and 6 give the hex form of the normalised colour (of the static value, of K₀ or of Kₙ₋₁). Step 5 gives A, B and the eased progress e of K2, which is **not clamped**, and the mix below.

*Mix of A and B at e.* For each colour, with 8-bit channels r, g, b:

1. Linearise each channel: c = channel ÷ 255; c ÷ 12.92 when c ≤ 0.04045, otherwise ((c + 0.055) ÷ 1.055)^2.4.
2. l = ∛(0.4122214708 R + 0.5363325363 G + 0.0514459929 B), m = ∛(0.2119034982 R + 0.6806995451 G + 0.1073969566 B), s = ∛(0.0883024619 R + 0.2817188376 G + 0.6299787005 B).
3. L = 0.2104542553 l + 0.793617785 m − 0.0040720468 s; a = 1.9779984951 l − 2.428592205 m + 0.4505937099 s; b = 0.0259040371 l + 0.7827717662 m − 0.808675766 s.
4. C = √(a² + b²); h = (atan2(b, a) × 180 ÷ π + 360) mod 360, in degrees.

Then:

5. **Hue of a neutral colour.** If C_A < 10⁻⁷, h_A ← h_B. Then, if C_B < 10⁻⁷, h_B ← h_A.
6. **Shortest arc.** Δh = ((h_B − h_A + 540) mod 360) − 180.
7. L = L_A + (L_B − L_A) × e; C = C_A + (C_B − C_A) × e; h = h_A + Δh × e.
8. Back to sRGB: a = C × cos(h × π ÷ 180), b = C × sin(h × π ÷ 180); l = (L + 0.3963377774 a + 0.2158037573 b)³, m = (L − 0.1055613458 a − 0.0638541728 b)³, s = (L − 0.0894841775 a − 1.291485548 b)³; R = 4.0767416621 l − 3.3077115913 m + 0.2309699292 s, G = −1.2684380046 l + 2.6097574011 m − 0.3413193965 s, B = −0.0041960863 l − 0.7034186147 m + 1.707614701 s.
9. Encode each: 12.92 × c when c ≤ 0.0031308, otherwise 1.055 × c^(1 ÷ 2.4) − 0.055; clamp to 0…1; multiply by 255; round to the nearest integer, halves upward; clamp to 0…255.
10. **Alpha.** The result has alpha when A or B has it. Then alpha = α_A + (α_B − α_A) × e (an opaque colour counts as 255), rounded and clamped as in step 9. Otherwise the result is opaque.

The result is the hex string of the mixed colour. Out-of-gamut values are clipped per channel in step 9; there is no gamut mapping. On a keyframe's own frame in the interior of a group the result goes through steps 1 to 9 with e = 0 and is that keyframe's colour again. Because of the transcendental functions before the 8-bit rounding, mixed colours carry a tolerance of one step per channel (K16).

An effect parameter is keyframed only while the effect shows the parameter and its group has a keyframe; otherwise it draws at its static value.

## Lanes and order

**[K15] Where the keyframed value sits.** K7, K10 and K14 give the **keyframed value** of a property. What follows it is governed by the protocol, and is listed here only to place the keyframed value.

*Static values.* For the transform fields (`x`, `y`, `width`, `height`, `anchorX`, `anchorY`, `rotation`, `opacity`, `cornerRadius`) the static value is the clip's resolved transform field. Crop, text, shape and effect-parameter properties use the clip's own field of that name. `volume` uses the clip's gain in dB; how gains combine is outside this page.

*An absent anchor.* The resolved transform's `anchorX` and `anchorY`, when the clip stores none, are half its **stored** `width` and `height` (or the fitted defaults of `layers.md` L6), taken before any keyframe. They are the static values of `anchorX`, `anchorY` and `anchor`, and they do **not** follow a keyframed `width`, `height` or `scale`: with a keyframed size and no anchor keyframe, the pivot stays at half the stored size while the box grows around its centre. `layers.md` L6 pins the drawn result with rendered cases.

*Vector lanes own their components.* The three vector properties map to transform fields: `position` to (`x`, `y`), `scale` to (`width`, `height`), `anchor` to (`anchorX`, `anchorY`).

- A vector group **with at least one keyframe** supplies both of its fields, and the scalar groups of those two fields are **not read**, whatever they hold. A vector group with no keyframe leaves the scalar groups in charge.
- `position` and `anchor` supply their fields directly, with static value (x, y) or (anchorX, anchorY).
- `scale` is in percent of the clip's static size, with static value (100, 100): width = static width × (scale.x ÷ 100), height = static height × (scale.y ÷ 100), in that grouping.
- When an entry has two groups for one property, the first in array order is used.

*Fields that interpolation does not read.* **`separatedVectorProperties` and `animationVersion` have no effect on the value.** The engine does not distinguish a "separated" vector property when it renders: if the vector group has a keyframe it wins, and if not the scalar groups apply, with or without the flag and with or without `animationVersion: 2` (fixtures `transform/separated-flag-is-not-read/…`, `…/separated-flag-without-vector-lane/…`, `…/animation-version-absent/…`). **Implementation-defined.** The flag only changes how the web editor presents the lanes. **Native rule** (protocol 13.2.5): animate a pair either as its vector property or as its two scalar properties, never both, so the question does not arise.

*After the keyframed value*, in this order: a property link replaces it with the linked source's value; an enabled expression is evaluated with it as its input (protocol 13.6.1); additive motion layers and then procedural modifiers are applied (13.6.2); and the parent chain of the clip is composed. Expressions and modifiers are out of scope here. The keyframed value is their input, never their output.

## Goldens

**[K16] `goldens/keyframes.json`.** The file is generated from the engine by `../tools/keyframe-goldens.browser.mjs --write`. The inputs are the fixture table of `../tools/keyframe-goldens.mjs`. Each case has a `name`, a `kind`, an `input` and the `expected` engine result:

| `kind` | `input` | Rule | `expected` |
| --- | --- | --- | --- |
| `easing` | `easing`, optional `easingConfig`, `t` | K2 to K6 | e |
| `scalar` | `keyframes`, `frame`, `base` (the static value) | K7 to K9 | a number |
| `vector` | `property`, `keyframes`, `frame`, `base`, optional `fps` (R; absent means 30) | K10 to K13 | `{ x, y }` |
| `colour` | `keyframes` (packed values), `frame`, `base` (hex) | K14 | a hex string |
| `transform` | `base` (the nine static fields), `entry` (a keyframe entry), `frame`, optional `fps` | K15 | the nine fields |

A `transform` case with `fps` is evaluated as preview and export do, with that project rate; without it, the clip is evaluated alone and R is 30. Keyframe `id`s are omitted from the inputs because nothing reads them.

- **Numbers are stored losslessly.** Each is a JSON number in the shortest decimal form that reads back to the same binary64 value, so parsing the file with a correctly rounding parser yields the engine's bits. Values JSON cannot hold are the strings `"NaN"`, `"Infinity"`, `"-Infinity"` and `"-0"`.
- **`"exact": true`** marks a case that these rules reproduce bit for bit: its evaluation uses only +, −, ×, ÷, comparisons and correctly rounded square roots. A native implementation must give the same binary64 value (any NaN where the golden has NaN; NaN has no single bit pattern). Results that are not a number are exact too, since NaN passes through every operation.
- **`"tolerance"`** marks every other case and states why. `{ "abs": 1e-9 }` means each number must be within 10⁻⁹ of the golden, in the property's own units. It applies to springs (exp, cos and sin are not fixed by IEEE 754) and to temporal-ease cases whose distance is diagonal and whose stated speed is above zero (K11). `{ "channel": 1 }` means each 8-bit channel of a colour must be within one step; it applies to mixed colours (K14). The differences between conforming maths libraries are many orders of magnitude below 10⁻⁹; the bound is a ceiling, not a licence to use another formula.

At this revision the file holds 728 cases: 586 exact and 142 with a tolerance (102 spring, 12 distance, 28 colour).

Regenerate after an engine change (Node 24, the prepared engine of `studio/README.md`):

```sh
npm --prefix studio/engine run dev -- --host 127.0.0.1 --port 5186 --strictPort &
node studio/tools/keyframe-goldens.browser.mjs --write   # engine values; fails if this page's reference cannot reproduce them
node studio/tools/keyframe-goldens.browser.mjs           # drift gate: the engine still gives the committed values
node --test studio/tools/keyframe-goldens.test.mjs
```

## Checks

- `node --test studio/tools/keyframe-goldens.test.mjs` (engine-free) verifies that the golden file has the documented structure, case list and coverage; that an independent implementation written from K1 to K15 reproduces every `exact` case bit for bit and every other case within its tolerance; that the comparison rule rejects wrong values; and that this page contains no engine source text.
- `node studio/tools/keyframe-goldens.browser.mjs` (needs the prepared engine; no WebGPU) evaluates every case with the engine's own interpolation and fails when a value differs from the committed golden.
