# gpu-vhs

| | |
|---|---|
| Category | stylize |
| Temporal | yes |
| Pass | single full-frame fragment pass, output size = input size (W × H) |
| HDR | refused [C4] |

## What it does
Video-tape look: horizontal tracking wobble, occasional horizontal band jumps, red/blue chroma bleed (opposite horizontal offsets), alternate-row scanline darkening and per-pixel tape noise, all animated with time.

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| bleed | number | 0 – 2 | 0.4 | — | chroma bleed; offset = 0.012 · bleed of frame width |
| waviness | number | 0 – 2 | 0.3 | — | tracking wobble amplitude; 0.015 · waviness of frame width |
| noise | number | 0 – 1 | 0.25 | — | tape noise amplitude |
| scanline | number | 0 – 1 | 0.35 | — | scanline darkening |
| speed | number | 0 – 4 | 1 | × | time multiplier (not animatable) |

Sanitised per [C9]. Absent keys use defaults.

Time: τ = t · speed, with t from [C8] (callers without a timeline frame fall back to wall-clock seconds; not reproducible). τ is converted to binary32 before use. speed = 0 freezes all animation (τ = 0).

Derived per frame (binary32; mod(x, m) = x − m · floor(x/m), result in [0, m)):
- bandScroll = mod(0.7·τ, 64).
- jumpStep = mod(floor(3·τ), 64) (the jump pattern changes 3 times per τ-second).
- tnx = mod(120·τ, 512); tny = mod(60·τ, 512).

## Per-pixel definition
uv = (u, v) per [C1].
1. Wobble: w = (sin(120·v + 5·τ) + sin(17·v − 2.3·τ)) · 0.5; u1 = u + w · waviness · 0.015.
2. Band jump: band = floor(6·v + bandScroll); hit = 1 if HASH((band, jumpStep)) ≥ 0.92 else 0 [C6]; u2 = u1 + hit · (HASH((band, 7)) − 0.5) · 0.06.
   (v itself is never displaced.)
3. Chroma bleed, off = 0.012 · bleed:
   R = S((u2 + off, v)).r; G = S((u2, v)).g; B = S((u2 − off, v)).b; A = S((u2, v)).a [C2].
4. Scanlines: sl = 0.82 + 0.18 · sin((j + 0.5) · 3.14159265359), i.e. ideally sl = 1.0 on even rows j and 0.64 on odd rows. rgb = mix(rgb, rgb · sl, clamp(scanline, 0, 1)).
5. Noise: n = HASH((u2 · W · 0.5 + tnx, v · H · 0.5 + tny)) − 0.5; rgb = rgb + n · noise · 0.5 (same n on all three channels).
6. Output = (clamp(rgb, 0, 1), A).

## Edges
Displaced sample positions outside [0, 1] read the edge texel (clamp-to-edge [C2]); at the left/right borders the wobble and bleed smear the edge column.

## Alpha
Alpha is A = S((u2, v)).a — taken from the displaced (wobbled/jumped) position, so the alpha mask moves with the picture. R and B come from positions offset by ±off and are straight values sampled independently of alpha; at mask edges colour from transparent texels (hidden RGB) can bleed into visible pixels. Noise and scanlines are applied to RGB everywhere, including where alpha = 0.

## SDR and HDR
SDR: arithmetic on sRGB-encoded values, RGB clamped to [0, 1] [C3]. HDR: refused [C4].

## Notes
- **Strongly GPU-precision dependent.** Tape noise evaluates HASH at arguments up to ≈ W/2 + 512, which after HASH's pre-transform give sin arguments of order 10⁶–10⁸ radians; band-jump hashes reach ≈ 10⁵–10⁶ radians. Binary32 sin there is implementation-specific, so noise values and which bands jump differ across GPUs. Only the statistics are portable: n roughly uniform in [−0.5, 0.5); each band (one sixth of the frame height, about 6–7 visible) jumps with probability ≈ 8 % per jump step; each jump shifts the band horizontally by up to ±3 % of width.
- The wobble terms sin(120v + 5τ), sin(17v − 2.3τ) are **not** wrapped: for long clips (large τ) binary32 loses phase precision (at τ = 3600 s, 5τ = 18 000 rad, ulp ≈ 0.002 rad), so wobble differs slightly between GPUs late in long clips.
- Scanline row parity uses the integer pixel row: sin((j + 0.5)π) is ±1 up to binary32 rounding of the product; resolution-dependent (one dark line every other pixel row, whatever the frame size).
- bandScroll repeats every 64/0.7 ≈ 91.4 τ-seconds, jumpStep every 64/3 ≈ 21.3 τ-seconds, noise offsets every 512/120 and 512/60 τ-seconds.
