# gpu-chroma-key

| | |
|---|---|
| Category | keying |
| Temporal | no |
| Pass | 1 fragment pass (per-pixel, no neighbourhood) |
| HDR | refused (engine throws HdrRenderUnavailableError for the whole chain; a native client must refuse) [C4] |

## What it does
Makes pixels whose chroma is close to pure green (or pure blue) transparent, with an optional soft edge, and optionally removes green/blue spill from the remaining colours.

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| keyColor | select | green, blue | green | — | key colour |
| tolerance | number | 0..1 (step 0.01, animatable) | 0.2 | CbCr distance | fully keyed radius |
| softness | number | 0..0.5 (step 0.01, animatable) | 0.1 | CbCr distance | width of the soft edge beyond the tolerance |
| spillSuppression | number | 0..1 (step 0.01, animatable) | 0.5 | fraction | spill removal strength |

Mapping (after [C9]; missing → default):
- Key colour K (encoded R'G'B'): green → (0, 1, 0); blue → (0, 0, 1). Any value other than exactly "blue" (after sanitising, only "green") gives green.
- τ = tolerance; τ_out = tolerance + softness (computed in 32-bit float); σ = spillSuppression.

## Per-pixel definition
Chroma transform used here (on encoded values, not one of the shared helpers):
- Y = 0.299·R + 0.587·G + 0.114·B
- Cb = 0.564·(B − Y)
- Cr = 0.713·(R − Y)

For output pixel (i, j):

1. P = S(uv) [C2] (the input texel; straight RGBA, components R, G, B, A).
2. Compute (Cb_p, Cr_p) for P.rgb and (Cb_k, Cr_k) for K. Reference key values: green → Cb_k = −0.331068, Cr_k = −0.418531; blue → Cb_k = 0.499704, Cr_k = −0.081282 (computed in 32-bit float in the engine). Y is computed but not used in the distance.
3. d = √((Cb_p − Cb_k)² + (Cr_p − Cr_k)²).
4. Key matte m:
   - if τ_out > τ (as 32-bit floats): m = smoothstep(τ, τ_out, d);
   - otherwise (softness = 0, or so small it vanishes in the float sum) hard key: m = 1 if d > τ + 2⁻¹⁶ (= τ + 0.0000152587890625), else m = 0.
5. Spill suppression, only if σ > 0, applied to P.rgb independently of m:
   - green key: s = max(0, G − max(R, B)) · σ; G' = G − s; R' = R + s/2; B' = B + s/2.
   - blue key: s = max(0, B − max(R, G)) · σ; B' = B − s; R' = R + s/2; G' = G + s/2.
   - (The branch is chosen by which key channel strictly dominates; for the two available keys this is always the matching branch.)
   - if σ = 0: RGB unchanged.
6. Output (R', G', B', A · m).

## Edges
Single tap at the pixel's own texel centre; no edge handling needed.

## Alpha
Output alpha = input alpha × m. RGB is NOT premultiplied or cleared where the result is transparent: keyed pixels keep their (spill-suppressed) RGB with alpha 0.

## SDR and HDR
SDR only. Operates on sRGB-encoded values [C3]; the YCbCr coefficients are applied to encoded values. No output clamp is applied; for inputs in 0..1 the spill step keeps RGB within 0..1 (R + s/2 ≤ (R+G)/2). HDR: refused.

## Notes
- Frameleaf deviation from the upstream Freecut shader (engine patches 0021 and 0026): upstream evaluated smoothstep(τ, τ+softness, d) unconditionally, which is undefined when softness = 0. The engine instead (a) uses a hard step when the soft band has zero width, and (b) widens that hard step by 2⁻¹⁶ so that a pixel exactly equal to the key colour, whose computed distance can come out at ~1e‑8 instead of 0 when a GPU fuses multiply-adds differently for pixel and key, is still keyed. The margin applies only to the hard-key branch; with any softness > 0 the smoothstep branch is used and no margin is added.
- At τ = 0 with softness > 0, smoothstep(0, softness, d) is used, so an exact key pixel (d = 0) gets m = 0 (or a negligible value if the GPU measures d ≈ 1e‑8).
- The hard-key comparison at d ≈ τ is sensitive to float rounding by design; values within 2⁻¹⁶ of τ are keyed.
- The "key" is a fixed pure primary; there is no custom key colour.
