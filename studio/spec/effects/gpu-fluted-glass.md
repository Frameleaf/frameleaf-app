# gpu-fluted-glass

| | |
|---|---|
| Category | distort |
| Temporal | no |
| Pass | one full-frame pass, one input; 1 bilinear sample per pixel, or up to 101 bilinear samples when `blur` gives sigma > 0.5 (vertical Gaussian) |
| HDR | refused ([C4]) |

## What it does

Simulates looking through a sheet of fluted (ribbed) glass. The frame is divided into parallel flutes (optionally curved, zig-zagged or patterned) at a chosen angle. Within each flute the image is shifted across the flute by a profile chosen by `distortionShape`, so each flute shows a refracted slice of the picture. A lighting model adds a thin highlight line at each flute seam and a shadow ramp across each flute; an optional vertical blur, a "stretch" that pulls flute edges towards the frame's vertical centre, a frame fade at the picture boundary, optional margins that leave a border of undistorted image, and two optional grain layers complete the look. The result is composited over a back colour, so the effect can produce transparency.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| colorBack | color | - | `#00000000` | sRGB hex + alpha | colour behind the glass (shows where the image is faded out) |
| colorShadow | color | - | `#000000` | sRGB hex + alpha | shadow tint |
| colorHighlight | color | - | `#ffffff` | sRGB hex + alpha | seam highlight colour |
| shadows | number | 0 .. 1 | 0.25 | - | shadow strength (applied squared) |
| highlights | number | 0 .. 1 | 0.1 | - | seam highlight strength |
| size | number | 0 .. 1 | 0.5 | - | flute size: 0 = 200 flutes across, 1 = 5 flutes across |
| shape | select | lines, linesIrregular, wave, zigzag, pattern | lines | - | flute path shape |
| angle | number | 0 .. 180 | 0 | degrees | flute orientation |
| distortionShape | select | prism, lens, contour, cascade, flat | prism | - | refraction profile across one flute |
| distortion | number | 0 .. 1 | 0.5 | - | refraction strength |
| shift | number | -1 .. 1 | 0 | flute widths | constant offset of the refraction |
| stretch | number | 0 .. 1 | 0 | - | pull of flute edges towards v = 0.5 |
| blur | number | 0 .. 1 | 0 | - | vertical blur, sigma = 50 px at 1 |
| edges | number | 0 .. 1 | 0.25 | - | width of the image fade at the warped frame boundary |
| margin | number | 0 .. 1 | 0 | uv | fallback for any absent per-side margin |
| marginLeft | number | 0 .. 1 | 0 | uv | undistorted border, left |
| marginRight | number | 0 .. 1 | 0 | uv | undistorted border, right |
| marginTop | number | 0 .. 1 | 0 | uv | undistorted border, top (v = 0 side) |
| marginBottom | number | 0 .. 1 | 0 | uv | undistorted border, bottom (v = 1 side) |
| grainMixer | number | 0 .. 1 | 0 | - | noise that locally cancels distortion |
| grainOverlay | number | 0 .. 1 | 0 | - | black/white grain overlay |

### Mapping to internal quantities

All numbers are sanitised per [C9], then rounded to binary32. A parameter key that is absent from the instance takes the default in the table, except the four per-side margins, which fall back to the value of `margin` when absent, and to 0 when `margin` is absent too. Effects created in the editor carry every key, so in practice `margin` has no effect unless a side key is missing (implementation-defined, kept for parity).

Select mapping:

| shape | code | | distortionShape | code |
|---|---|---|---|---|
| lines | 1 | | prism | 1 |
| linesIrregular | 2 | | lens | 2 |
| wave | 3 | | contour | 3 |
| zigzag | 4 | | cascade | 4 |
| pattern | 5 | | flat | 5 |

Colours: B = HEXCOLOR(colorBack, fallback (0,0,0,0)); Sc = HEXCOLOR(colorShadow, fallback (0,0,0,1)); Hc = HEXCOLOR(colorHighlight, fallback (1,1,1,1)). HEXCOLOR is defined in the section below.

Derived quantities (W, H are the output dimensions):

- Wd = max(W, 1), Hd = max(H, 1); a = max(W / max(H,1), 0.0001)
- size' = clamp(size, 0, 1); shAmt = clamp(shadows, 0, 1); hlAmt = clamp(highlights, 0, 1); dAmt = clamp(distortion, 0, 1); stAmt = clamp(stretch, 0, 1); blAmt = clamp(blur, 0, 1); edAmt = clamp(edges, 0, 1); gm = clamp(grainMixer, 0, 1); go = clamp(grainOverlay, 0, 1); shift is used unclamped (sanitised range -1..1).
- angle in radians: phi = angle * PI / 180, PI = 3.14159265359. Pattern rotation theta = -phi.
- Pattern scale: Ps = mix(200, 5, size') = 200 - 195 * size'.
- Margins mL, mT, mR, mB as described above (used unclamped).

### HEXCOLOR(s, fallback)

Colour strings are parsed as follows (no trimming, no named colours). The result is four numbers used directly as sRGB-encoded values (no linearisation).

1. If s does not start with `#`, return fallback.
2. Let h = s without the leading `#`.
3. If h has 3 or 4 characters: each character c gives value HEXPAIR(c c) / 255 (the character doubled). If the first three values are finite, return (v1, v2, v3, v4), with v4 = 1 when h has 3 characters. Otherwise fallback. The 4th value is not checked: an invalid 4th character yields alpha = NaN (implementation-defined).
4. If h has 6 or 8 characters: values HEXPAIR of characters 0-1, 2-3, 4-5 (and 6-7 for 8 characters, else alpha 1), each / 255. If all four are finite return them, otherwise fallback.
5. Any other length: fallback.

HEXPAIR(p): lenient base-16 parse of the two-character string p: skip leading white space, one optional `+`/`-` sign, optional `0x`/`0X` prefix, then the longest run of hex digits (case-insensitive); no digits gives NaN, otherwise the signed integer. So in the 6/8-digit forms `1z` -> 1, ` f` -> 15, `-f` -> -15 (negative channel). Implementation-defined, kept for parity.

## Per-pixel definition

### Notation

- uv = (u, v) per [C1]. ROT(p, ang) = (p.x cos ang - p.y sin ang, p.x sin ang + p.y cos ang).
- RA(p, ang) ("aspect rotation"): scale p.x by a, apply ROT by ang, divide the resulting x by a. Explicitly RA(p, ang) = ((a p.x cos ang - p.y sin ang) / a, a p.x sin ang + p.y cos ang). RA(., -ang) is the exact inverse of RA(., ang).
- FW(f): the coarse screen-space derivative width of [C10], |df/di| + |df/dj| from the top row and left column of the 2x2 pixel quad (quads start at even i and even j). Pixels outside the frame that complete a quad evaluate the same formulas. For quantities linear in (i, j) this equals the analytic value; for discontinuous quantities (anything containing fract) it is large in quads that straddle the discontinuity. See Notes.
- SMOOTHFRACT(x): f = fract(x); w = FW(x); e = |f - 0.5| - 0.5; b = smoothstep(-w, w, e); result mix(f, 1 - f, b). (Away from the integer seams it equals fract(x); at a seam it blends towards 0.5 over about one derivative width.)
- Reversed smoothstep: smoothstep(e0, e1, x) is always evaluated with the formula t = clamp((x - e0) / (e1 - e0), 0, 1), result t*t*(3 - 2t), including when e0 > e1 (used below several times).
- pow(0, y) for y > 0 is 0.

### Step 1: margin masks

Let (mu, mv) = ((i + 0.5) / Wd, (j + 0.5) / Hd) (equal to uv). sw = 0.005.

- mask = smoothstep(mL, mL + sw, mu + sw) * smoothstep(mR, mR + sw, 1 - mu + sw) * smoothstep(mT, mT + sw, mv + sw) * smoothstep(mB, mB + sw, 1 - mv + sw)
- maskOuter = same product with each factor smoothstep(m - sw, m, coordinate + sw)
- maskStroke = maskOuter - mask
- maskInner = product of smoothstep(m - 2 sw, m, coordinate) (no + sw on the coordinate)
- maskStrokeInner = maskInner - mask

With all margins 0: mask = maskOuter = maskInner = 1 and both strokes are 0 everywhere.

### Step 2: pattern coordinates

- q = (uv - 0.5) * Ps (both components)
- U = RA(q, theta) (theta = -phi)
- Y = U.y / a

Curve by shape code:

| code | curve |
|---|---|
| 1 lines | 0 |
| 2 linesIrregular | 0.5 + 0.5 sin(0.5 U.x) sin(1.7 U.x) |
| 3 wave | 4 sin(0.23 Y) |
| 4 zigzag | 10 abs(fract(0.1 Y) - 0.5) |
| 5 pattern | 0.5 + 0.5 sin(0.5 PI U.x) cos(0.5 PI Y) |

- X = U.x + curve (only the x component of "U + curve" is used)
- fo = fract(U) (componentwise), fl = floor(U)
- x = SMOOTHFRACT(X)
- xn = fract(X) + 0.0001

### Step 3: seam highlights

- hw = 2 max(0.001, FW(X)) + 2 maskStrokeInner
- hl = 1 - smoothstep(0, hw, xn) * smoothstep(1, 1 - hw, xn)
- hl = clamp(hl * hlAmt, 0, 1) * mask

### Step 4: refraction profile

Initialise: sh = pow(x, 1.3); dist = 0; fadeX = 1; ff (frame fade) = 0.
aa = max(FW(xn), FW(U.x), FW(X), 0.0001).

FADE(aa) := smoothstep(0, aa, xn) * smoothstep(1, 1 - aa, xn).

- distortionShape 1 (prism):
  dist = -(1.5 x)^3 + 0.5 - shift; ff = (1.5 x)^3; aa = max(0.2, aa) + 0.2 (1 - size'); fadeX = FADE(aa); dist = mix(0.5, dist, fadeX).
- distortionShape 2 (lens):
  dist = 2 x^2 - (0.5 + shift); ff = |x - 0.5|^4; aa = max(0.2, aa) + 0.2 (1 - size'); fadeX = FADE(aa); dist = mix(0.5, dist, fadeX); ff = mix(1, ff, 0.5 fadeX).
- distortionShape 3 (contour):
  dist = POW6(2 (xn - 0.5)) - 0.25 - shift; ff = 1 - 2 |x - 0.4|^2; aa = 0.15 + 0.1 (1 - size'); fadeX = FADE(aa); ff = mix(1, ff, fadeX). dist is not faded. POW6 see Notes (base is negative for xn < 0.5).
- distortionShape 4 (cascade):
  x is replaced by xn; dist = sin((xn + 0.25) TAU); sh = 0.5 + 0.5 asin(dist) / (0.5 PI); dist = 0.5 dist - shift; ff = 0.5 + 0.5 sin(xn TAU). TAU = 6.28318530718.
- distortionShape 5 (flat):
  dist = -(|x|^0.2 * x) + 0.33 - 3 shift; dist = 0.33 dist; ff = 0.3 smoothstep(0, 1, x); sh = x^2.5; aa = max(0.1, aa) + 0.1 (1 - size'); fadeX = FADE(aa); dist = dist * fadeX.

### Step 5: grain mixer and grain coordinate

Only when gm > 0 or go > 0, define the grain coordinate:
- gUV = (uv - 0.5) * (0.8 / max(du, 0.0001), 0.8 / max(dv, 0.0001)) + 0.5, where du and dv are the per-pixel increments of u and v (the engine takes the length of the screen-space derivative of uv along i and along j; these are exactly 1/W and 1/H). For W, H <= 10000 this is (uv - 0.5) * (0.8 W, 0.8 H) + 0.5.

GRAINNOISE(p) = 0.45 NOISE(p * 0.83 + (4.1, -7.3)) + 0.35 NOISE((1.27 p.x - 0.58 p.y, 0.71 p.x + 1.19 p.y) + (-10.2, 5.4)) + 0.2 NOISE((-0.92 p.x + 1.11 p.y, -1.06 p.x - 0.82 p.y) + (7.8, 9.6)), with NOISE per [C6].

If gm > 0: g = smoothstep(0.4, 0.7, GRAINNOISE(gUV)) * gm; dist = mix(dist, 0, g).

### Step 6: shadows and scaling

- sh = min(sh, 1); sh = sh + maskStrokeInner; sh = sh * mask; sh = min(sh, 1); sh = sh * shAmt^2; sh = clamp(sh, 0, 1).
- dist = dist * 3 * dAmt
- ff = ff * dAmt

### Step 7: warped sample coordinate

- fo' = (fo.x + dist, fo.y)
- p = (RA(fl, phi) + RA(fo', phi)) / Ps + (maskStroke^4, maskStroke^4) + 0.5
  (Algebraically p = uv + (dist cos phi, a dist sin phi) / Ps + maskStroke^4; the order above is the reference order; the difference is binary32 rounding only.)
- p = mix(uv, p, smoothstep(0, 0.7, mask))

### Step 8: blur sigma and frame fade

- sigma = 50 blAmt * smoothstep(0.5, 1, mask)
- ed = (0.04 edAmt + 0.06 ff edAmt) * mask
- FRAME(p, s) := smoothstep(0, 2 FW(p.x) + s, p.x) * (1 - smoothstep(1 - s - 2 FW(p.x), 1, p.x)) * smoothstep(0, 2 FW(p.y) + s, p.y) * (1 - smoothstep(1 - s - 2 FW(p.y), 1, p.y))
- fr = FRAME(p, ed)

### Step 9: stretch (only if stAmt > 0)

- st = 1 - smoothstep(0, 0.5, xn) * smoothstep(1, 0.5, xn)
- st = st^2 * mask * FRAME(p, 0.1 + 0.05 mask ff) (FRAME on the pre-stretch p)
- p.y = mix(p.y, 0.5, stAmt * st)

### Step 10: image sample (vertical Gaussian)

- If sigma <= 0.5: img = S(p) (straight).
- Otherwise: R = min(50, ceil(3 sigma)) (integer). Weights wk = exp(-k^2 / (2 sigma^2)) for k = 0..R (w0 = 1). Accumulate premultiplied samples: acc = w0 PM(S(p)) + sum over k = 1..R of wk (PM(S(p + (0, k / Hd))) + PM(S(p - (0, k / Hd)))), where PM(c) = (c.rgb c.a, c.a); wsum = w0 + 2 sum wk. res = acc / wsum. If res.a > 0, img = (res.rgb / res.a, res.a); else img = res. (The engine multiplies every weight by 1/sqrt(TAU sigma^2); it cancels.)
- Premultiply: I = (img.rgb img.a, img.a).

### Step 11: compositing

Back colour premultiplied: Bp = (B.rgb B.a, B.a). Highlight premultiplied: Hp = (Hc.rgb Hc.a, Hc.a). Shadow colour Sc is used straight.

1. col = Hp.rgb hl; op = Hp.a hl
2. sh2 = sh Sc.a (1 - hl)
3. col = mix(col, Sc.rgb Sc.a, 0.5 sh2)
4. col = col + 0.5 sqrt(sh2) Sc.rgb   (engine uses pow(sh2, 0.5))
5. op = op + sh2
6. col = clamp(col, 0, 1); op = clamp(op, 0, 1)
7. col = col + I.rgb (1 - op) fr; op = op + I.a (1 - op) fr
8. col = col + Bp.rgb (1 - op); op = op + Bp.a (1 - op)

### Step 12: grain overlay (only if go > 0)

- n = GRAINNOISE(ROT(gUV, 1.0) + (3, 3))
- n = mix(n, GRAINNOISE(ROT(gUV, 2.0) + (-1, -1)), 0.5)
- n = n^1.3
- gv = 2 n - 1; gc = 1 if gv >= 0 else 0 (all three channels)
- gs = (go |gv|)^0.8 * mask
- col = mix(col, (gc, gc, gc), 0.35 gs); op = op + 0.5 gs

### Step 13: output

op = clamp(op, 0, 1). Output (col, op). col is not clamped again.

## Edges

- All samples use clamp-to-edge ([C2]); the blur taps step 1/H vertically and also clamp.
- FRAME fades the image towards the back colour wherever the warped coordinate p comes within about `ed` + 2 FW(p) of the frame boundary. Because `edges` defaults to 0.25 (ed about 0.01 to 0.025) and the back colour defaults to fully transparent, the default output has a partially transparent border roughly 1 % to 2.5 % of the frame wide, plus extra transparency where flutes refract coordinates past the boundary. Even with `edges` = 0 the outermost pixel row/column is faded (for an undistorted p the first column gives smoothstep(0, 2/W, 0.5/W) = 0.156).
- Margins: inside a margin band mask falls to 0, p returns to uv (undistorted), highlights, shadows, stretch, blur and grain-overlay strength go to 0; the thin strokes maskStroke and maskStrokeInner draw a highlight/shadow line and a small diagonal offset along the margin boundary.

## Alpha

Output alpha is the composited opacity op (highlight, shadow, image coverage x frame fade, back colour, grain overlay). The returned RGB is the premultiplied composite (Step 11 accumulates premultiplied contributions) but is written into a pipeline that treats outputs as straight alpha ([C5]). For op = 1 this is exact; for 0 < op < 1 the colour is effectively darkened by op when later stages composite it. Implementation-defined, kept for parity. Where op = 0, RGB is 0.

## SDR and HDR

SDR: the only RGB clamp is Step 11.6; the final RGB is not clamped and can exceed 1 when the shadow colour is not black (the sqrt term adds colour faster than opacity), and those values survive in the binary16 pass storage ([C3]). HDR projects: refused ([C4]).

## Notes

- Derivatives (FW): WebGPU lets the implementation choose coarse or fine derivatives. For a linear coordinate the value is exact: FW(U.x) = (Ps / W)(|cos phi| + |sin phi|), FW(u) = 1/W, FW(v) = 1/H. For X with curved shapes, xn (which jumps at every flute seam), and the warped p (which jumps where dist jumps between flutes), the value depends on the 2x2 quad grouping and on coarse vs fine choice. In particular aa is close to 1 in quads straddling a seam, which widens FADE there for prism/lens/flat, and FRAME widens at seams near the frame edge. A native implementation uses the coarse quads of [C10], which the canonical backend uses. Hardware with fine derivatives differs only at flute seams.
- POW6 (contour): the engine raises 2 (xn - 0.5) to the real power 6.0. For xn < 0.5 the base is negative and the WGSL/backends define pow as exp2(6 log2(base)), which is undefined/NaN for negative bases; some compilers instead expand an integer-literal exponent into multiplications and return the even power. The resulting distortion (and then the sample coordinate) is therefore implementation-defined on the left half of every flute. The evident intent is |2 (xn - 0.5)|^6; native clients should use that and treat contour goldens on the left half of each flute as non-normative.
- pow with base exactly 0 (e.g. maskStroke^4 when there are no margins, sh^0.5 when sh = 0) is taken as 0, matching all known GPU backends.
- Blur is vertical only (along v), independent of `angle`. The kernel is truncated at 50 taps each side, so for sigma > 16.7 it is cut off before 3 sigma (at sigma = 50 the kernel spans only 1 sigma).
- Precision: the curved shapes use sin/cos of arguments up to about 0.5 x 200 x 1.2; the grain layers call NOISE on coordinates of the order of 0.8 x W (thousands), so HASH's sin(...) x 43758.5453 makes grain pixel values highly sensitive to GPU sin precision; grain is reproducible only statistically across GPUs.
- smoothstep(0, 0, ...) never occurs for valid inputs because every width has a positive floor (0.001, 0.0001, 0.1, 0.15, 0.2) except FRAME with ed = 0, where 2 FW(p) > 0 for any non-degenerate frame.
