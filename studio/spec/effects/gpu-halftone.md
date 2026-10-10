# gpu-halftone

| | |
|---|---|
| Category | stylize |
| Temporal | no |
| Pass | single full-frame fragment pass, output size = input size (W × H) |
| HDR | refused [C4] |

## What it does
Re-draws the frame as a printed halftone screen: a grid of dots (square or hexagonal/staggered lattice) whose size follows the darkness of the image under each dot. Four dot styles (classic circles, merging "gooey" blobs, inverted "holes", soft blurred balls). Dots are drawn in a single front colour over a back ("paper") colour, or in the image's own colours. Optional procedural grain erodes dot edges ("grain mixer") and overlays black/white speckle ("grain overlay").

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| colorFront | color | — | #2b2b2b | sRGB hex | ink colour (ignored when originalColors) |
| colorBack | color | — | #f2f1e8 | sRGB hex | paper colour; its alpha is used |
| originalColors | boolean | — | false | — | dots take the source colour under them |
| inverted | boolean | — | false | — | invert the tone that drives dot size |
| grid | select | hex, square | hex | — | lattice |
| type | select | classic, gooey, holes, soft | gooey | — | dot style |
| size | number | 0 – 1 | 0.5 | — | cell size (0 = finest, 1 = coarsest) |
| radius | number | 0 – 2 | 1.25 | — | base dot radius |
| contrast | number | 0 – 1 | 0.4 | — | tone contrast (sigmoid steepness) |
| grainMixer | number | 0 – 1 | 0.2 | — | grain erosion of dot edges |
| grainOverlay | number | 0 – 1 | 0.2 | — | black/white grain overlay strength |
| grainSize | number | 0 – 1 | 0.5 | — | grain scale (0 = finest) |

Sanitised per [C9]. A parameter key that is absent uses its default (legacy fallbacks in Notes).

**Colour strings** (colorFront, colorBack). Parsed into (R, G, B, A) in 0..1:
- Not starting with `#` → fallback (the default colour, A = 1).
- 3 or 4 hex digits after `#`: each digit d is doubled ("dd") and read as a base-16 byte /255; A = 4th digit or 1. A non-hex character yields NaN for that component (no fallback; implementation-defined result).
- 6 or 8 hex digits: each pair read as a byte /255 with JavaScript `parseInt(pair, 16)` semantics (leading whitespace skipped, optional sign, longest valid hex prefix — e.g. "1z" reads 1); A = 4th pair or 1. If any pair reads as NaN → whole fallback.
- Any other length → fallback.

Internal quantities (binary32):
- Grid code g: square → 0, hex → 1. Style code y: classic → 0, gooey → 1, holes → 2, soft → 3.
- Sub-sample count per axis n: classic 2, gooey 6, holes 1, soft 6. Step s = 1/n.
- aspect a = max(W / max(H, 1), 0.0001).
- cellsPerSide = mix(300, 7, size^0.7) / n.
- pad = (1/cellsPerSide) · (1/a, 1). If y = gooey and g = hex: pad ← 0.7 · pad.
- rawCols = max(1, round(1 / max(pad.x, 1e-4))), rawRows = max(1, round(1 / max(pad.y, 1e-4))) (round = half to even).
- cols = rawCols + 1 if rawCols is even, else rawCols; rows likewise (forced odd). pad ← (1/cols, 1/rows).
- texel = (1/max(W,1), 1/max(H,1)).
- If not originalColors: k = 15 · contrast^1.5, R0 = radius. If originalColors: k = mix(0.1, 4, contrast²), R0 = 2 · (0.5 · radius)^0.3.
- gm = grainMixer, go = grainOverlay, gc = grainSize^0.72.

## Per-pixel definition
Helper functions (all binary32):
- SIG(x) = 1 / (1 + exp(−k · (x − 0.5))).
- HN(p) ("halftone noise") = ( NOISE(p) + NOISE((1.31·p.x + 0.74·p.y, −0.68·p.x + 1.27·p.y) + (11.7, 3.9)) + NOISE((−0.57·p.x + 1.43·p.y, 1.19·p.x + 0.53·p.y) + (−7.4, 13.1)) ) / 3, with NOISE from [C6].
- ON(p) ("overlay noise") = 0.45 · HN(0.73·p + (5.31, −8.17)) + 0.35 · HN((1.41·p.x − 0.52·p.y, 0.67·p.x + 1.28·p.y) + (−11.4, 4.6)) + 0.2 · HN((−0.88·p.x + 1.19·p.y, −1.07·p.x − 0.79·p.y) + (8.2, 10.7)).

Steps:
1. c0 = S(uv) (= F(i, j)). If c0.a ≤ 1e-4 → output (0, 0, 0, 0) and stop. Let Asrc = c0.a.
2. P = (uv − 0.5) · (cols, rows) (cell-space coordinate, origin at frame centre).
3. Accumulators Tshape = 0, Tcol = (0,0,0), Top = 0.
4. For xi = 0..n−1, for yi = 0..n−1:
   1. off = (xi/n − 0.5, yi/n − 0.5).
   2. If g = hex:
      - row = yi, col = xi. If n = 1 (holes only): row = floor(P.y + off.y + 1).
      - If y = gooey: skip this sub-sample when fract((row + col)·0.5) ≥ 0.5 (i.e. row + col odd).
      - Otherwise: if fract(row · 0.5) ≥ 0.5 (row odd; fract(x) = x − floor(x), so negative odd rows are odd too): off.x ← off.x + 0.5·s.
   3. Sample a dot:
      - pp = P + off; ci = floor(pp); fp = fract(pp) (the position inside the cell).
      - sUV = clamp((ci + 0.5 − off) · pad + 0.5, texel/2, 1 − texel/2) (component-wise).
      - Tone: c = S(sUV). If c.a ≤ 1e-4: L = (inverted ? 1 : 0). Else L = LUMA709(SIG(c.r), SIG(c.g), SIG(c.b)) [C7]; if inverted, L = 1 − L.
      - Grain on tone (only if gm > 0.001):
        - D = sUV · mix(2600, 55, gc) + off · 37 + (21, −14).
        - gp = ON(D · mix(1.15, 0.2, gc)).
        - gs = HN(D · mix(2.1, 0.38, gc) + fp · mix(14, 4, gc)).
        - ew = 1 − |2L − 1|.
        - L = clamp(L + (2·gs − 1)·(0.08 + 0.32·gm)·(0.3 + 0.7·ew) − smoothstep(0.45, 0.85 − 0.2·gm, gp)·gm·(0.1 + 0.8·ew), 0, 1).
      - cov = c.a (same sample). If cov ≤ 1e-4: shape = 0, colour = (0,0,0) — go to 4.4.
      - d = length(fp − (0.5, 0.5)). Ball value B by style:
        - classic: r = 0.25·R0·(1 − L); B = 1 − smoothstep(r − 0.02, r + 0.02, d).
        - gooey: r = (g = hex ? 0.42 : 0.3) · R0 · (1 − L); B = (1 − smoothstep(0, r, d))^(2 + R0).
        - holes: r = 0.75·R0·(1 − L); rm = r − 0.5·floor(r/0.5); C = 1 − smoothstep(rm − 0.02, rm + 0.02, d); B = C if r < 0.5, else 1 − C.
        - soft: r = 0.5·clamp(R0, 0, 1)·(1 − L); lin = clamp(d / r, 0, 1); B = (1 − lin)^(4 + 3·(1 − clamp(R0/2, 0, 1))).
      - shape = B · cov; colour = c.rgb · cov (premultiplied).
   4. Tcol += colour · shape; Tshape += shape; Top += shape.
5. Tcol ← Tcol / max(Tshape, 1e-4); Top ← Top / max(Tshape, 1e-4) (so Top = 1 whenever Tshape ≥ 1e-4).
6. Shape: classic, holes → Fs = min(1, Tshape); gooey → Fs = smoothstep(0.42, 0.58, Tshape); soft → Fs = Tshape (unclamped).
7. Grain on shape (always evaluated; inert when gm = 0):
   - Q = uv · (mix(3200, 42, gc) · (1, 1/a)) + (13.1, −9.7).
   - eb = clamp(1 − |2·Fs − 1|, 0, 1)^0.55.
   - field = ON(Q · mix(0.95, 0.16, gc)); detail = HN(Q · mix(1.9, 0.28, gc) + (−17.3, 6.4)).
   - Fs = clamp(Fs + (2·detail − 1)·eb·gm·0.24 − eb·smoothstep(0.42, 0.9, field)·gm·(0.35 + 1.75·gm), 0, 1).
8. Composite over paper (Bk = colorBack, Fr = colorFront):
   - originalColors: col = Tcol·Fs; op = Top·Fs.
   - otherwise: col = Fr.rgb·Fr.a·Fs; op = Fr.a·Fs.
   - then: col += Bk.rgb·Bk.a·(1 − op); op += Bk.a·(1 − op).
9. Grain overlay: o = ON(Q · mix(0.9, 0.14, gc))^1.3; ov = 2·o − 1; gcol = (1,1,1) if ov ≥ 0 else (0,0,0); st = (go·|ov|)^0.8; col = mix(col, gcol, 0.5·st); op += 0.5·st.
10. Output = (clamp(col, 0, 1), clamp(op, 0, 1) · Asrc).

## Edges
Dot sample positions are clamped half a texel inside the frame, then sampled bilinearly with clamp-to-edge [C2]. The odd cell count centres the lattice so the frame edges fall on dot centres (no paper border at the edge from lattice phase).

## Alpha
- Pixels with source alpha ≤ 1e-4 become (0, 0, 0, 0).
- Otherwise output alpha = clamp(op, 0, 1) · source alpha of the pixel itself; RGB is written as straight colour (not multiplied by source alpha).
- Dot colour and coverage use alpha of the sampled dot position (transparent dot centres produce no dot).
- `col` in step 8 is formed like a premultiplied value but is output as straight RGB. With an opaque back colour (default), op ends at 1 and this is exact compositing; with colorBack alpha < 1 or colorFront alpha < 1 the RGB is darkened by the coverage — implementation-defined, reproduce as written.

## SDR and HDR
SDR: all arithmetic on sRGB-encoded values, output clamped to [0, 1] [C3]. HDR: refused [C4].

## Notes
- **GPU-precision dependent.** Grain uses NOISE/HASH ([C6]) at domain coordinates up to several thousand; binary32 sin at those arguments differs between GPUs, so grain speckle (steps 4.3 grain, 7, 9) is not bit-reproducible. Default grainMixer = grainOverlay = 0.2, so default output contains such grain. With both 0 the result depends only on exp/pow/smoothstep and is reproducible to rounding.
- Divisions by zero (implementation-defined): gooey/soft with r = 0 (L = 1 or R0 = 0) evaluate smoothstep/linear step with equal edges; for d > 0 the GPU yields B = 0 (gooey) / B = 0 (soft); at d = 0 exactly the value is undefined (NaN on most GPUs). pow with base 0 and positive exponent = 0.
- Soft style lets Tshape exceed 1 (no clamp in step 6) until step 7's clamp.
- Hex + holes uses floor(P.y + 0.5) as the row parity, which is one more than the sampled cell row floor(P.y − 0.5); reproduce as written.
- Legacy keys (only used when the corresponding catalogue key is absent, never sanitised): if `size` is absent and a positive finite `spacing` exists, size = (clamp((300 − clamp(H/spacing, 7, 300)) / 293, 0, 1))^(1/0.7), else 0.5; if `radius` is absent, radius = clamp(2·dotSize/spacing, 0, 2) when both legacy `dotSize` and `spacing` are non-zero and spacing > 0, else 1.25; if `inverted` is absent, a legacy boolean `invert` is used; if `type` is absent, a legacy `dotStyle` string is used (unknown → gooey).
