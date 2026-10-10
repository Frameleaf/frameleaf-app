# gpu-trigger-wave

| | |
|---|---|
| Category | distort |
| Temporal | yes ([C8] effect clock) |
| Pass | one full-frame pass, one input; 1 bilinear sample per pixel, 3 when `chroma` > 0 |
| HDR | refused ([C4]) |

## What it does

A single expanding ring ("shock wave") travels outward from a centre point. Pixels near the ring are displaced radially by a sine carrier that is strongest on the ring and decays exponentially away from it, and the ring fades out during the last 80 % of its cycle. Optional extras: a red/blue chromatic split along the radial direction on the ring, horizontal sine scanlines over the whole frame, and an additive glow colour on the ring. The ring position cycles with `phase` + `speed` x time.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| strength | number | -0.15 .. 0.15 | 0.035 | uv | displacement amplitude (sign flips push/pull) |
| radius | number | 0.1 .. 1.5 | 0.85 | frame heights | ring radius reached at the end of a cycle |
| frequency | number | 2 .. 64 | 18 | cycles per frame height | carrier frequency across the ring |
| decay | number | 0.01 .. 0.3 | 0.08 | frame heights | exponential width of the ring band |
| phase | number | 0 .. 1 | 0 | cycles | static phase offset |
| speed | number | 0 .. 4 | 1 | cycles per second | not animatable |
| centerX | number | 0 .. 1 | 0.5 | uv | ring centre, horizontal |
| centerY | number | 0 .. 1 | 0.5 | uv | ring centre, vertical (0 = top) |
| chroma | number | 0 .. 0.05 | 0.006 | uv | chromatic split amount |
| scanlineMix | number | 0 .. 1 | 0.18 | - | scanline blend |
| glowColor | color | - | `#2e6b8c` | sRGB hex | additive ring glow colour |

### Mapping to internal quantities

All numbers are sanitised per [C9], then rounded to binary32. A parameter key that is absent from the effect instance takes the default from the table (the same values as the catalogue). Let a = W / max(H, 1) (computed in double precision, then rounded to binary32), t = effect clock in seconds ([C8]).

- s = strength
- R = max(radius, 0.001)
- f = max(frequency, 0.001)
- d = max(decay, 0.001)
- centre c = (centerX, centerY)
- P = fract(phase + speed * t)  (the product and sum are evaluated in binary32)
- k = chroma
- m = clamp(scanlineMix, 0, 1)
- A = max(a, 0.001)
- glow colour G = (gR, gG, gB) * gA, where (gR, gG, gB, gA) = HEXCOLOR(glowColor, fallback (0.18, 0.42, 0.55, 1)).

The `max`/`clamp` guards above are no-ops for sanitised values; they only matter if a native client bypasses sanitising.

### HEXCOLOR(s, fallback)

Colour strings are parsed as follows (no trimming, no named colours, no `rgb()` forms). The result is four numbers used directly as sRGB-encoded values (no linearisation).

1. If s does not start with `#`, return fallback.
2. Let h = s without the leading `#`.
3. If h has 3 or 4 characters: each character c gives value HEXPAIR(c c) / 255 (the character doubled). If the first three values are finite, return (v1, v2, v3, v4), with v4 = 1 when h has 3 characters. Otherwise return fallback. The 4th value is not checked: an invalid 4th character yields alpha = NaN (implementation-defined downstream).
4. If h has 6 or 8 characters: values are HEXPAIR(h[0..1]) / 255, HEXPAIR(h[2..3]) / 255, HEXPAIR(h[4..5]) / 255, and HEXPAIR(h[6..7]) / 255 for 8 characters (else 1). If all four are finite return them, otherwise fallback.
5. Any other length: fallback.

HEXPAIR(p) is a lenient base-16 integer parse of the two-character string p: skip leading white space, accept one optional `+` or `-` sign, accept an optional `0x`/`0X` prefix, then read the longest run of hexadecimal digits (case-insensitive); if there are no digits the result is NaN; otherwise the signed integer value. Consequences (implementation-defined, kept for parity): in the 6/8-digit forms `1z` parses as 1, ` f` as 15, `+f` as 15 and `-f` as -15 (a negative channel); in the 3/4-digit forms only a real hex digit produces a finite value.

Note that the glowColor fallback (0.18, 0.42, 0.55, 1) is not exactly the parsed default `#2e6b8c` = (46/255, 107/255, 140/255, 1).

## Per-pixel definition

Constants: TAU = 6.28318530718. Let uv per [C1]; let y_pix = j + 0.5 (the pixel-centre row coordinate in output pixels, top = 0.5).

1. Aspect-corrected offset from the centre: e = ((u - c.x) * A, v - c.y).
2. dist = length(e); sd = max(dist, 0.0001).
3. Radial direction in uv space: n = (e.x / A, e.y) / sd.
4. Ring radius r0 = P * R.
5. Band: B = exp(-|dist - r0| / d).
6. Tail: T = 1 - smoothstep(0.2, 1.0, P).
7. Carrier: C = sin((dist - r0) * f * TAU).
8. Force: F = C * B * T * s.
9. Warped coordinate: w = uv + n * F.
10. col = S(w) (straight RGBA, [C2]).
11. Chromatic split, only if k > 0:
    - o = n * k * B * (0.25 + |s| * 20)
    - col.r = S(w + o).r ; col.b = S(w - o).b ; col.g and col.a unchanged.
12. Scanlines, only if m > 0:
    - L = 0.78 + 0.22 * sin(y_pix * 2.4 + P * TAU * 8)
    - col.rgb = mix(col.rgb, col.rgb * L, m)
13. Glow: g = B * T * clamp(|s| * 12, 0, 1); col.rgb = col.rgb + G * g.
14. Output: (clamp(col.rgb, 0, 1), col.a).

## Edges

Warped and chroma-offset coordinates outside [0,1] read the nearest edge texel (clamp-to-edge, [C2]). The ring itself is not clipped; when `radius` exceeds the distance to the frame edge the ring simply leaves the frame. Pixels exactly at the centre use the guarded distance 0.0001 so the direction is (0,0) there.

## Alpha

Output alpha = alpha of the main warped sample S(w). The chroma samples contribute only R and B. RGB is computed normally where alpha = 0 (sampled straight RGB plus scanlines plus glow); it is not zeroed, so the glow adds colour even to fully transparent pixels.

## SDR and HDR

SDR: final RGB is clamped to [0,1]; alpha is the sampled alpha (already in [0,1]). HDR projects: refused ([C4]).

## Notes

- Periodicity: the effect repeats every 1/speed seconds; speed = 0 freezes it at `phase`.
- The scanline pattern is defined in output pixels (y_pix * 2.4 radians per pixel), so it does not scale with resolution: a preview rendered at a different resolution than the export shows a different scanline density relative to the picture. Implementation-defined, kept for parity.
- `radius`, `decay` and `frequency` are in aspect-corrected units where 1 = frame height (the horizontal offset is multiplied by the aspect before measuring distance).
- Precision: the carrier sin((dist - r0) * f * TAU) and exp() are evaluated in binary32 on the GPU; at frequency 64 the argument reaches several hundred radians, so pixel values depend on GPU transcendental precision at the level of a few 1e-4 in uv displacement. P is computed in binary32 from phase + speed * t; for very long item-relative times (t of the order of hours) P loses resolution.
