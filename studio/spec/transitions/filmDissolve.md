# filmDissolve

| | |
|---|---|
| Category | dissolve |
| Directions | none |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
A cross dissolve computed in linear light (FL-1564), the way film and the "film dissolve" of other editors blend: bright areas of the incoming clip come through sooner and dark areas linger less than in the ordinary cross dissolve. Nothing moves.

## Parameters
None.

## Progress curve
t = clamp(p, 0, 1), used linearly (no ease).

## Geometry
None: a = S(A, uv), b = S(B, uv), premultiplied [T2].

## Blend
With DEC(x) = x/12.92 when x ≤ 0.04045, else ((x + 0.055)/1.055)^2.4, and ENC(x) = 12.92x when x ≤ 0.0031308, else 1.055·x^(1/2.4) − 0.055, each applied per channel to max(x, 0):

- For each clip, its linear premultiplied colour is ℓ = DEC(rgb / max(α, 10⁻⁶)) · α when α > 0, else (0, 0, 0).
- α_out = α_a·(1 − t) + α_b·t; ℓ_out = ℓ_a·(1 − t) + ℓ_b·t.
- Output premultiplied RGB = ENC(ℓ_out / max(α_out, 10⁻⁶)) · α_out when α_out > 0, else (0, 0, 0); output alpha α_out.

No clamp beyond the max(x, 0) inside DEC and ENC.

## Edges
None.

## Alpha
Alpha mixes linearly with t. The result is converted to straight alpha per [T2].

## Notes
- Endpoints (SDR float route): p = 0 gives A and p = 1 gives B, within the binary32 round trip of DEC and ENC (about 10⁻⁶).
- At t = 0.5 between black and white the output is ENC(0.5) ≈ 0.735, where the ordinary dissolve gives 0.5.
