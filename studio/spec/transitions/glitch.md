# glitch

| | |
|---|---|
| Category | custom |
| Directions | none |
| Duration (frames) | default 20, min 5, max 60 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A digital-glitch cut: horizontal bands (two band heights) are randomly shifted sideways with RGB channel splitting, the frame switches from outgoing to incoming band by band at random times, glitched bands get noise and posterisation. Randomness is stepped (re-rolled a few times per transition).

## Parameters
| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| intensity | number | 0 – 3 (step 0.05) | 1 | × | overall glitch strength |
| blockSize | number | 6 – 96 (step 1) | 30 | px | band height scale |
| rgbSplit | number | 0 – 3 (step 0.05) | 1 | × | channel separation |

Sanitised per [T4]; absent → 1, 30, 1.

## Progress curve
p is used as received (**not clamped**).
- env = smoothstep(0, 0.2, p) · (1 − smoothstep(0.8, 1, p)); str = env · intensity.
- Random steps: floor(8p), floor(10p), floor(12p), floor(14p), floor(6p) are used as the time input of different hashes (see below), so each random choice is held for 1/8, 1/10, … of the transition.

## Geometry
HASH per [C6]. All band heights are in uv (fractions of H).
1. Big bands: hB = 2 · blockSize / H; yB = floor(v / hB). sB = HASH((17.3 yB, floor(8p))). onB = 1 if sB ≥ 0.55 − 0.35 str, else 0. shiftB = (HASH((31.7 yB, floor(10p))) − 0.5) · str · 0.18 · onB.
2. Slices: hS = max(2, 0.3 · blockSize) / H; yS = floor(v / hS). sS = HASH((53.1 yS, floor(12p))). onS = 1 if sS ≥ 0.65 − 0.25 str, else 0. shiftS = (HASH((71.3 yS, floor(14p))) − 0.5) · str · 0.1 · onS.
3. Δ = shiftB + shiftS; P = (clamp(u + Δ, 0, 1), v).
4. split = rgbSplit · str · 0.015 + 0.2 · |Δ|; PR = (clamp(P.x + split, 0, 1), v); PB = (clamp(P.x − split, 0, 1), v).
5. Switch bands: hW = 0.7 · hB; yW = floor(v / hW); th = 0.7 · HASH((7.3 yW, floor(6p))) + 0.15; w = smoothstep(th − 0.12, th + 0.12, p).

Per clip X ∈ {A, B}: X' = (S(X, PR).r, S(X, P).g, S(X, PB).b, S(X, P).α).

## Blend
1. Empty-sample guard: eA = (A'.α < 0.01), eB = (B'.α < 0.01). A'' = B' if (eA and not eB) else A'; B'' = A' if (eB and not eA) else B'.
2. col = A'' · (1 − w) + B'' · w (all four premultiplied channels).
3. Noise: n = HASH((0.5 · u · W, 0.5 · v · H + 1000 p)); amt = str · 0.1 · max(onB, onS). RGB = col.rgb · (1 − amt) + n · amt (n added equally to all three channels).
4. Posterise: L = 256 + (24 − 256) · (str · onB · 0.4) (i.e. mix(256, 24, 0.4 · str · onB)); RGB = floor(RGB · L + 0.5) / L per channel.
5. α = col.α. No clamp.

## Edges
Shifted sample positions are clamped to [0, 1] horizontally (edge-extend). Band boundaries are hard. Note u · W = i + 0.5 and v · H = j + 0.5 in the noise hash.

## Alpha
Shifts, noise and posterisation act on premultiplied RGB; α is only shifted (sampled at P) and switched. The empty-sample guard replaces a clip with the other where it has (almost) no alpha, so transparent regions of one clip show the other clip instead of transparency. Noise added on pixels with α = 0 is discarded by [T2]; on partly transparent pixels noise and posterisation are amplified by un-premultiplying.

## Notes
- **Endpoints are not identity (SDR float route, observed):** at p = 0 and p = 1, str = 0, so there is no shift, split or noise and w is exactly 0 resp. 1 (th ∈ [0.15, 0.85]), but posterisation with L = 256 still applies: each premultiplied channel becomes floor(256 x + 0.5)/256. For 8-bit input k/255 this changes many values by up to 1/512 (implementation-defined). The empty-sample guard also applies at the endpoints (e.g. p = 0, transparent A pixels show B).
- p outside [0, 1]: env is 0, so the result is the same posterised/guarded A or B as at the nearest endpoint, except that floor(6p) etc. keep changing (irrelevant when str = 0, but w can differ: for p < 0, w = 0; for p > 1, w = 1).
- **Strong GPU-precision dependence:** every band decision and the per-pixel noise come from HASH with large arguments (e.g. 0.5 · v · H + 1000 p up to ≈ 2000, 71.3 · yS up to ≈ 10⁵ for small blocks on tall frames); not bit-reproducible across GPUs. The transition-semantics file allows an SDR parity budget of 4 (8-bit levels) for this transition.
