# gpu-hue-curves

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass with a data texture |
| HDR | refused |

## What it does
Three curves over the hue circle (FL-1559): hue against hue shifts colours of one hue towards another, hue against saturation strengthens or mutes them, and hue against luma brightens or darkens them. Greys are left alone.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| hueHuePoints | json | — | "" | — | points `[hue, shift]`, shift in turns, −0.5 .. 0.5 |
| hueSatPoints | json | — | "" | — | points `[hue, gain]`, gain 0 .. 2 (1 = unchanged) |
| hueLumaPoints | json | — | "" | — | points `[hue, gain]`, gain 0 .. 2 (1 = unchanged) |
| mix | number | 0 .. 1 | 1 | fraction | blend between the input and the graded result |

Sanitised per [C9]; JSON values are parsed as below.

## Points
Each JSON value must be an array of two-number arrays `[h, v]`. Entries that are not two finite numbers are skipped, and a value that is not valid JSON or not an array gives no points. h is in turns and is wrapped into [0, 1) (h − floor(h)); v is clamped to the curve's range. The points are sorted by h and at most the first 16 are kept.

## Curve
A curve with no points is its neutral value (shift 0, gains 1); one point gives a constant. Otherwise the curve is periodic: the points repeat every turn (point i + n is point i one turn later). For a hue h, let k be the last point with h_k ≤ h; if there is none, k is the last point and h is taken as h + 1. With P0, P1, P2, P3 the points k − 1, k, k + 1, k + 2 of the periodic sequence, t = (h − h₁)/(h₂ − h₁) (0 when h₂ = h₁), and the value is the uniform Catmull-Rom spline

v = ½·(2v₁ + (v₂ − v₀)t + (2v₀ − 5v₁ + 4v₂ − v₃)t² + (3v₁ − v₀ − 3v₂ + v₃)t³).

## Data texture
The curves are evaluated in binary64 at the 256 hues i/255 (i = 0 … 255) and stored in a 256 × 1 rgba8 texture, rounded to whole bytes and clamped to 0 … 254: R = 127 + 254·shift, G = 127·saturation gain, B = 127·luma gain, A = 255. An empty curve is exactly byte 127.

## Per-pixel definition
```
c = S(uv)
(H, S, V) = RGB→HSV(clamp01(c.rgb))                          [C7]
e = bilinear tap of the table at u = (255 H + 0.5) / 256, level 0     [C2]
shift = (255 e.r - 127) / 254,  gS = 255 e.g / 127,  gL = 255 e.b / 127
x = HSV→RGB(fract(H + shift), clamp01(S · gS), V · mix(1, gL, S))   [C7]
out.rgb = clamp01(mix(c.rgb, x, mix)),  out.a = c.a
```

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged.

## SDR and HDR
- SDR: as above.
- HDR: refused [C4]. A native client must refuse it too.

## Notes
- With no points the effect is the identity within the HSV round trip.
- The luma gain is weighted by saturation so greys (S = 0), whose hue is undefined, never change.
