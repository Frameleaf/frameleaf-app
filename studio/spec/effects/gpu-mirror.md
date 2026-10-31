# gpu-mirror

| | |
|---|---|
| Category | distort |
| Temporal | no |
| Pass | 1 fragment pass |
| HDR | refused (engine throws HdrRenderUnavailableError for the whole chain; a native client must refuse) [C4] |

## What it does
Replaces the right half with a mirror image of the left half (horizontal) and/or the bottom half with a mirror image of the top half (vertical).

## Parameters

| name | type | range | default | unit | meaning |
|---|---|---|---|---|---|
| horizontal | boolean | — | true | — | mirror left half onto right half |
| vertical | boolean | — | false | — | mirror top half onto bottom half |

Mapping (after [C9]; a non-boolean value takes the default):
- MH = horizontal; when the parameter is absent it counts as true (only an explicit false disables it).
- MV = vertical; when absent it counts as false (only an explicit true enables it).

## Per-pixel definition
For output pixel (i, j) with uv = (u, v) from [C1]:

1. u' = 1 − u if MH and u > 0.5 (strict), else u.
2. v' = 1 − v if MV and v > 0.5 (strict), else v.
3. Output S(u', v') [C2].

Since 1 − (i + 0.5)/W = ((W − 1 − i) + 0.5)/W, the mirrored sample lands exactly on a texel centre. Equivalently: output(i, j) = F(i', j') with i' = W − 1 − i when MH and i > (W − 1)/2, else i; j' = H − 1 − j when MV and j > (H − 1)/2, else j.

## Edges
No out-of-frame reads.

## Alpha
Alpha is copied from the sampled (mirrored) texel together with RGB; nothing cleared.

## SDR and HDR
SDR only. HDR: refused.

## Notes
- For odd W the centre column (u = 0.5 exactly) is not mirrored (it is its own mirror anyway); same for the centre row with odd height.
- Treat the effect as an exact texel copy; tiny uv interpolation error on a GPU can introduce a vanishing bilinear contribution from a neighbour, which is not part of the intended behaviour.
