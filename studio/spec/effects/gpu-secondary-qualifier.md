# gpu-secondary-qualifier

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass |
| HDR | refused |

## What it does
Builds a soft HSL-style key from hue, saturation and luma ranges. It then applies exposure, temperature, tint and saturation only inside that key, or shows the key itself.

## Parameters
| name | type | range | default | unit | internal value |
|---|---|---|---|---|---|
| hueCenter | number | 0 .. 360 | 0 | degrees | hc = fract(hueCenter/360) |
| hueWidth | number | 0 .. 180 | 35 | degrees (half-width) | hw = clamp(hueWidth/360, 0, 0.5) |
| hueSoftness | number | 0 .. 120 | 20 | degrees | hs = max(hueSoftness/360, 0.0001) |
| satLow | number | 0 .. 1 | 0 | HSV S | |
| satHigh | number | 0 .. 1 | 1 | HSV S | |
| satSoftness | number | 0 .. 1 | 0.1 | HSV S | |
| lumaLow | number | 0 .. 1 | 0 | LUMA601 | |
| lumaHigh | number | 0 .. 1 | 1 | LUMA601 | |
| lumaSoftness | number | 0 .. 1 | 0.1 | LUMA601 | |
| invertMask | boolean | — | false | — | |
| showMask | boolean | — | false | — | output the mask as grey |
| exposure | number | -3 .. 3 | 0 | EV | gain 2^exposure |
| saturation | number | -100 .. 100 | 0 | percent | sat = 1 + saturation/100 |
| temperature | number | -100 .. 100 | 0 | percent | T = temperature/100 |
| tint | number | -100 .. 100 | 0 | percent | Ti = tint/100 |
| strength | number | 0 .. 1 | 1 | fraction | mask multiplier |

Sanitised per [C9]. An absent key takes the default above.

## Per-pixel definition
```
c0 = S(uv),  c = c0.rgb
(h, s, v) = RGB→HSV(c)                       [C7], h in turns
Y = LUMA601(c)

dh = |h - hc|,  dist = min(dh, 1 - dh)       (circular hue distance, 0..0.5)
mask = 1 - smoothstep(hw, hw + hs, dist)

RANGE(x, lo, hi, soft):
    L = min(lo, hi),  H = max(lo, hi),  k = max(soft, 0.0001)
    return clamp01( smoothstep(L - k, L, x) * (1 - smoothstep(H, H + k, x)) )
mask = mask * RANGE(s, satLow, satHigh, satSoftness)
mask = mask * RANGE(Y, lumaLow, lumaHigh, lumaSoftness)

if invertMask: mask = 1 - mask
mask = clamp01(mask * strength)

if showMask:  out = (mask, mask, mask, c0.a),  stop

k = c * 2^exposure
k.r += T*0.1,  k.b -= T*0.1
k.g -= Ti*0.1, k.r += Ti*0.05, k.b += Ti*0.05
g = LUMA601(k),  k = mix(g, k, sat)

out.rgb = clamp01(mix(c, k, mask)),  out.a = c0.a
```

## Edges
No neighbourhood access.

## Alpha
Passed through unchanged, including in show-mask mode, where RGB is replaced by the grey mask.

## SDR and HDR
- SDR: the corrected colour is unclamped until the final `clamp01` of the blend. The show-mask output is already in [0, 1].
- HDR: refused [C4].

## Notes
- Implementation-defined: the mask is inverted *before* strength is applied. With invert on and strength < 1, unkeyed areas get `strength` and keyed areas get 0. Keyed areas do not get `1 − strength`.
- Achromatic pixels have h = 0 under [C7]. With low satLow they therefore join the key when hueCenter is near 0 (red) and are excluded otherwise. This is observed behaviour.
- At hueWidth = 180 the hue factor is 1 for every pixel, because dist ≤ 0.5 = hw and the smoothstep is 0. In other words, the hue range covers everything.
- Uses `exp2` only. A tolerance of 1/255 is adequate.
