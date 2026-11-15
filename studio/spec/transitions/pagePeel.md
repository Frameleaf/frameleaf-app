# pagePeel

| | |
|---|---|
| Category | wipe |
| Directions | none |
| Duration (frames) | default 30, min 10, max 90 (editor) |
| Route | GPU, single fragment pass |
| HDR | refused [T5] |

## What it does
The outgoing clip peels away from the bottom-right corner like a page, folding back over itself along a straight crease that moves towards the top-left corner (FL-1564). The back of the folded flap shows the outgoing picture mirrored and paled; the incoming clip is revealed underneath, with a soft shadow along the crease.

## Parameters
None.

## Progress curve
p′ = clamp(p, 0, 1).

## Geometry
Work in aspect-correct coordinates P = (u·a, v) with a = W/H. Let K = (a, 1) (the bottom-right corner), L = |K|, g = K/L, f = p′·L (the crease's distance from K) and w = 0.05·L. For the pixel:

- s = (K − P)·g, the distance from K towards the top-left corner along the diagonal.
- Q = P + 2(s − f)·g, the point of the page that folds onto this pixel, and q = (Q.x/a, Q.y).

## Blend
Samples, premultiplied and at an explicit level 0: a = S(A, uv), b = S(B, uv), a_q = S(A, q). Edges are anti-aliased over one pixel: with px = 1/H (one pixel in these units) and λ = 1 when f > 0, else 0:

1. **Base.** The peeled weight is k_p = λ·clamp((f − s)/px + 0.5, 0, 1). The incoming clip under the crease is b with its RGB multiplied by 1 − 0.35·(1 − p′)·(1 − clamp((f − s)/w, 0, 1)) (the crease shadow). The base is mix(a, that, k_p) on all four premultiplied channels.
2. **Flap.** Its coverage is k_f = λ·clamp((s − f)/px + 0.5, 0, 1)·clamp((2f − s)/px + 0.5, 0, 1)·clamp(0.5 − o/px, 0, 1), where o = max(−Q.x, Q.x − a, −Q.y, Q.y − 1) is how far Q lies outside the frame. Its colour is (mix(a_q.rgb, (a_q.α, a_q.α, a_q.α), 0.6)·k, a_q.α)·k_f with k = 0.85 + 0.15·clamp((s − f)/w, 0, 1): paper-white mixed into the mirrored picture, darker near the crease.
3. Output = flap + base·(1 − flap.α) (premultiplied source-over).

## Edges
The crease, the flap's far edge and the flap's outline (the frame's edge reflected) blend linearly over one pixel width, as above.

## Alpha
As in the blend. Converted to straight alpha per [T2].

## Notes
- Endpoints: p = 0 gives A exactly (λ = 0). At p = 1, f = L: every pixel centre is at least about 0.7 px inside the crease, so k_p = 1 and k_f = 0, and the shadow factor is 0: the output is B.
- The flap's mirror image is the outgoing picture reflected across the crease, as the back of a printed page would show it through thin paper.
