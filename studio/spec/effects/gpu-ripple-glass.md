# gpu-ripple-glass

| | |
|---|---|
| Category | distort |
| Temporal | no |
| Pass | one full-frame pass, one input; 1 bilinear sample per pixel, 4 when `aberration` > 0 |
| HDR | refused ([C4]) |

## What it does

Concentric-ring ("bullseye" / rippled pond) glass. Rings of equal width spread from an origin; within each ring the image is refracted radially by a cylindrical-lens profile, a thin bright line marks each seam between rings, and a shadow deepens towards the seams. All three fade exponentially with distance from the origin. Optional chromatic aberration splits red and blue along the radial direction.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| colorShadow | color | - | `#000000` | sRGB hex + alpha | groove shadow colour (alpha scales it) |
| colorHighlight | color | - | `#ffffff` | sRGB hex + alpha | seam highlight colour (alpha scales it) |
| amount | number | 0 .. 1 | 0.5 | - | refraction strength |
| rings | number | 1 .. 64 | 14 | rings per frame height | ring density |
| shadows | number | 0 .. 1 | 0.25 | - | shadow strength |
| highlights | number | 0 .. 1 | 0.1 | - | seam highlight strength |
| originX | number | 0 .. 1 | 0.5 | uv | ring origin, horizontal |
| originY | number | 0 .. 1 | 0.5 | uv | ring origin, vertical (0 = top) |
| phase | number | -1 .. 1 | 0 | ring widths | shifts the rings radially (positive = outward) |
| falloff | number | 0.05 .. 2 | 0.35 | frame heights | e-folding distance of the envelope |
| aberration | number | 0 .. 1 | 0 | - | chromatic split |

### Mapping to internal quantities

Numbers are sanitised per [C9], then rounded to binary32; an absent key takes the table default.

- Sc = HEXCOLOR(colorShadow, fallback (0, 0, 0, 1)); Hc = HEXCOLOR(colorHighlight, fallback (1, 1, 1, 1)).
- am = amount (no further clamp); n = max(rings, 1); shA = clamp(shadows, 0, 1); hlA = clamp(highlights, 0, 1); o = (originX, originY); ph = phase; fo = max(falloff, 0.001); ab = aberration.
- a = max(W / max(H, 1), 0.0001).

### HEXCOLOR(s, fallback)

1. If s does not start with `#`, return fallback. Let h = s without the `#`.
2. h of 3 or 4 characters: each character c gives HEXPAIR(c c) / 255 (character doubled). If the first three are finite return (v1, v2, v3, v4 or 1); else fallback. The 4th value is not checked (invalid 4th character gives alpha NaN; implementation-defined).
3. h of 6 or 8 characters: HEXPAIR of characters 0-1, 2-3, 4-5 (and 6-7, else alpha 1), each / 255; all four finite, else fallback.
4. Any other length: fallback.

HEXPAIR(p): lenient base-16 parse: skip leading white space, optional `+`/`-`, optional `0x`/`0X`, then the longest run of hex digits (case-insensitive); no digits gives NaN. So `1z` -> 1, `-f` -> -15 in the 6/8-digit forms (implementation-defined, kept for parity). Values are used directly as sRGB-encoded numbers.

## Per-pixel definition

uv per [C1]. FW(f) is the coarse screen-space derivative width of [C10]. pow(0, y > 0) = 0.

1. pv = ((u - o.x) · a, v - o.y); dist = length(pv); dir = pv / max(dist, 0.0001).
2. Radial direction in uv space: rd = (dir.x / a, dir.y).
3. rw = 1 / n (ring width); rc = dist / rw - ph (ring coordinate; its integer part is the ring index).
4. x = fract(rc); cx = x - 0.5.
5. bend = -sign(cx) · (2 · |cx|)^1.5   (sign(0) = 0).
6. env = exp(-dist / fo).
7. push = bend · am · rw · 1.5 · env; off = rd · push.
8. Sample:
   - if ab > 0: ca = rd · ab · rw · env; R = S(uv + off + ca).r; G = S(uv + off).g; Bc = S(uv + off - ca).b; A = S(uv + off).a; col = (R, G, Bc, A).
   - else col = S(uv + off).
9. aa = 2 · max(0.001, FW(rc)).
10. hl = 1 - smoothstep(0, aa, x) · smoothstep(1, 1 - aa, x) (the second smoothstep has reversed edges and is evaluated with the plain Hermite formula, t = clamp((x - 1) / (-aa), 0, 1)); hl = clamp(hl · hlA · env, 0, 1).
11. sh = (2 · |cx|)^1.3; sh = clamp(sh · shA · env, 0, 1).
12. rgb = mix(col.rgb, Sc.rgb, 0.5 · sh · Sc.a); rgb = rgb + Hc.rgb · hl · Hc.a; rgb = clamp(rgb, 0, 1).
13. Output (rgb, col.a).

## Edges

Displaced and aberration coordinates outside [0,1] read the nearest edge texel ([C2]). Rings are not clipped by the frame. At the origin itself dir = (0, 0), so there is no displacement there.

## Alpha

Output alpha = the alpha sampled at uv + off. RGB is computed normally where alpha = 0 (shadow mix and highlight are applied to the sampled straight RGB); it is not zeroed.

## SDR and HDR

SDR: RGB clamped to [0,1]; alpha passes through. HDR projects: refused ([C4]).

## Notes

- Units: distances are aspect-corrected so that 1 = frame height; `rings` is rings per frame height, `falloff` is in frame heights, the displacement is at most 1.5 · am / n frame heights (radially, converted back to uv).
- Sign convention: in the outer half of a ring (cx > 0) the offset points towards the origin, in the inner half away from it, so samples are pulled towards each ring's middle (magnifying the band).
- FW(rc): rc is smooth except at the origin, so quad differences approximate the analytic value n · (|dir.x| + |dir.y|) / H; the per-pixel value follows the coarse quads of [C10] (GPUs that use fine derivatives differ slightly; it only sets the anti-aliasing width of the seam highlight, floored at 0.002).
- rc is computed as dist divided by the binary32 value of 1/n, not dist times n; the difference is rounding only.
- Precision: exp, pow and fract of rc (up to about 64 · 1.2) are binary32; seam positions can shift by about 1e-5 ring widths across GPUs. Not strongly transcendental-sensitive.
