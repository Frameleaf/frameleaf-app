# Sound: fades and crossfades

**Status: native-app contract (FL-1555).** This page says what a clip's sound fades and a transition's crossfade do to its gain. Like the rest of this directory it describes behaviour only. Gains multiply the clip's sound after its volume and before the track and master stages.

## Fades on a clip

**S1. Fields.** A video or sound item may carry `audioFadeIn` and `audioFadeOut`, in seconds, and for each a bend: `audioFadeInCurve` and `audioFadeOutCurve` in −1..1 (rounded to 0.01, default 0), and `audioFadeInCurveX` and `audioFadeOutCurveX` in 0.04..0.96 (rounded to 0.001, default 0.52). The bend is a control point at `(x, y)` that the gain curve passes through. A fade of zero length has no effect.

**S2. Fade in.** With progress `t` from 0 at the start of the fade to 1 at its end, `x` the curve x and `c` the curve: `y = x + c × (1 − x)` when `c ≥ 0`, else `y = x + c × x`. When `|y − x| ≤ 0.0001` the gain is `t`. When `y > x` the gain is `1 − (1 − t)^k` with `k = ln(1 − y) / ln(1 − x)`; otherwise it is `t^k` with `k = ln(y) / ln(x)`. Both arguments of `ln` are first clamped to 0.0001..0.9999, and `k` is clamped to 1..12.

**S3. Fade out.** With progress `t` from 0 to 1 and `l = 1 − x`: `y = l + c × (1 − l)` when `c ≥ 0`, else `y = l + c × l`. When `|y − l| ≤ 0.0001` the gain is `1 − t`. When `y > l` the gain is `1 − t^k` with `k = ln(1 − y) / ln(x)`; otherwise it is `(1 − t)^k` with `k = ln(y) / ln(1 − x)`, with the same clamps.

**S4. Overlapping fades.** When a fade in and a fade out of one clip meet or overlap, the gain is a straight rise to the middle of the clip and a straight fall after it, peaking at `min(1, middle / fade-in length)`; the bends are not used.

**S5. Named shapes.** Other editors name their fade shapes. These bends reproduce them; the importer writes them, and a native client may offer them as presets:

| Shape | Fade in (`curve`, `curveX`) | Fade out (`curve`, `curveX`) | Largest gain error |
| --- | --- | --- | --- |
| Linear (constant gain) | 0, 0.52 | 0, 0.52 | exact |
| Constant power (`sin`) | 0.42, 0.52 | 0.42, 0.48 | 0.014 |
| Exponential, slow start (`t²`) | −0.48, 0.52 | −0.48, 0.48 | exact |
| Logarithmic, fast start (`1 − (1 − t)²`) | 0.52, 0.52 | 0.52, 0.48 | exact |

An S-shaped fade has no bend; it is written as linear, and the import report says so.

## Crossfades

**S6. Which clips.** A transition joins two video, image or composition clips, or two sound clips that are neither compound items nor linked to another clip (graph protocol 13.2.3). A transition between sound clips draws nothing. A linked sound clip follows its video clip's transition.

**S7. Handles.** Through a transition of `d` frames with `p = floor(d × alignment)`, the outgoing clip's sound plays on for `d − p` frames into its tail handle and the incoming clip's sound starts `p` frames early from its head handle, so both sound together for the `d` frames.

**S8. Gain law.** Over those `d` frames, at progress `t` from 0 to 1, the incoming sound is multiplied by `g(t)` and the outgoing sound by `g(1 − t)`, where the transition's `audioCurve` chooses `g`:

| `audioCurve` | `g(t)` | Sum of the two gains at `t = 0.5` |
| --- | --- | --- |
| `constant-power` (default, also when absent or unknown) | `sin(πt / 2)` | 1.4142 (steady loudness for unrelated sounds) |
| `constant-gain` | `t` | 1.0 (steady level for the same sound) |
| `exponential` | `t²` | 0.5 (a dip between the two) |

The gain law is the same in preview, the meters and export. A clip's own fades (S1 to S4) apply on top of it.

**S9. Worked values.** Two clips whose sound is a steady 0.1, joined by a 10-frame transition at 30 frames a second with alignment 0.5, mix at the cut (frame 30), the middle of the transition, to 0.1414 with `constant-power`, 0.1 with `constant-gain` and 0.05 with `exponential`, and to 0.1 outside it. `studio/engine` checks these values in `canvas-audio.test.ts`.
