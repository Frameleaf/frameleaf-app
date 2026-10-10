# gpu-motion-blur

| | |
|---|---|
| Category | blur |
| Temporal | no (static directional blur; does not use the effect clock) |
| Pass | 1 fragment pass |
| HDR | linear-display-bt709-v1 |

## What it does
Smears the frame along a straight line through each pixel, centred on the pixel, using N taps with Gaussian-like weights. The length is scaled by a shutter angle and hard-capped.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| amount | number | 0..0.3 (step 0.005, animatable) | 0.05 | normalised frame units | half-length of the smear at 360° shutter |
| angle | number | 0..6.28318 (step 0.01, animatable) | 0 | radians | direction of the smear |
| samples | number | 4..32 (step 1, not animatable, quality) | 16 | taps | number of taps N |
| shutterAngle | number | 0..360 (step 1, animatable) | 180 | degrees | exposure fraction |

Mapping (after [C9]):
- **The default.** The catalogue default of `shutterAngle` is **180** degrees, and that is what a client writes when it adds the effect (protocol 13.3.1: every parameter is sent). The value 360 below arises only for a stored object that lacks the key.
- Shutter default rule (pinned, legacy compatibility): if `shutterAngle` is **absent** from the stored parameter object, it is taken as **360** when the object has at least one key of any name, and **180** only when the object has no key at all. "Another key" is any own key, whatever its value: a declared parameter (`amount`, `angle`, `samples`), or a key the catalogue does not declare for this effect, which sanitising passes through [C9]. Motion blur is not temporal, so the engine adds no clock key to the object [C8]: an object stored as `{}` stays empty and draws at 180. All other absent parameters take their catalogue default. A `shutterAngle` that is present is used as sanitised: a finite number is clamped to 0..360, and a value that is not a finite number (`null`, a string) is **180**, the catalogue default, not 360. Goldens: `shutterAngle-absent` (360), `only-an-undeclared-key` (360), `empty-parameters` (180), `shutterAngle-not-finite` (180), each in SDR and HDR.
- exposure e = clamp(shutterAngle / 360, 0, 1).
- half-length L = min(max(amount, 0) · e, 0.2). The cap 0.2 is a fixed constant (normalised units).
- N = trunc(clamp(samples, 4, 32)).
- direction d = (cos(angle), sin(angle)) in uv units. Because v grows downward [C1], positive angles turn clockwise on screen; angle 0 is horizontal.

## Per-pixel definition
For output pixel (i, j) with uv from [C1]:

1. If L < 0.001 or e < 0.001: output S(uv) unchanged (identity). Stop.
2. For k = 0, 1, …, N−1 (ascending):
   - t_k = (k/(N−1) − 0.5) · 2, so t runs evenly from −1 to +1 inclusive;
   - tap position p_k = uv + d · t_k · L (an offset of cos(angle)·t_k·L·W pixels horizontally and sin(angle)·t_k·L·H pixels vertically);
   - weight w_k = exp(−2·t_k²);
   - SDR: accumulate w_k·S(p_k); HDR: accumulate w_k·PB(p_k) [C4].
3. Divide by Σ w_k.
4. SDR: write the result. HDR: write HDR-OUT of it [C4].

## Edges
Clamp-to-edge [C2]; taps past the border repeat the edge texel with full weight.

## Alpha
SDR: straight RGBA averaged with the weights (transparent RGB bleeds in). HDR: premultiplied accumulation, binary16 coverage, zero RGB at zero coverage.

## SDR and HDR
Identical geometry in both. SDR: hardware bilinear straight-RGBA taps on sRGB-encoded values, no clamp. HDR: premultiplied linear taps, HDR-OUT. The identity early-exit bypasses HDR-OUT in HDR.


HDR helpers used above (the [C4] blur sampling and output, stated here so this file is self-contained):
- PB(q), premultiplied bilinear tap at uv q: x = q.u·W − 0.5, y = q.v·H − 0.5; x0 = floor(x), y0 = floor(y), fx = x − x0, fy = y − y0. For dx, dy ∈ {0, 1}: texel T = F(clamp(x0+dx, 0, W−1), clamp(y0+dy, 0, H−1)), weight ω = (dx ? fx : 1−fx)·(dy ? fy : 1−fy). PB(q) = Σ ω·(T.r·T.a, T.g·T.a, T.b·T.a, T.a).
- HDR-OUT(c) for an accumulated premultiplied (r, g, b, a): α = clamp(a, 0, 1); κ = α rounded to the nearest binary16 value, ties to even, with binary16 subnormals kept (multiples of 2⁻²⁴; anything ≤ 2⁻²⁵ becomes 0). If κ ≤ 0 output (0, 0, 0, 0); otherwise output (clamp(r/a, −65504, 65504), clamp(g/a, …), clamp(b/a, …), κ). The division uses the unrounded a.

## Notes
- The offset is in normalised (uv) units, not pixels, and is not aspect-corrected: on a non-square frame the smear length in pixels is L·√((W·cos angle)² + (H·sin angle)²), and the on-screen direction is atan2(H·sin angle, W·cos angle), not `angle` itself (implementation-defined, pinned).
- With the cap, the effective maximum half-length is 0.2 of the frame even though `amount` allows 0.3 (0.3 at 360° is capped to 0.2).
- Tap spacing is 2L/(N−1) in uv; with large L and few taps the result shows discrete ghost copies (pinned).
- SDR tap weights within a texel depend on GPU bilinear precision (GPU-defined). cos/sin/exp precision is GPU-defined; the angle range 0..2π exceeds the [−π, π] interval where WGSL guarantees trig accuracy, so tap positions may differ by small amounts across GPUs.
