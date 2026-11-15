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
Samples, premultiplied and at an explicit level 0: a = S(A, uv), b = S(B, uv), a_q = S(A, q).

1. **Base.** Where s < f (peeled) the base is b with its RGB multiplied by 1 − 0.35·(1 − p′)·(1 − clamp((f − s)/w, 0, 1)) (the crease shadow); elsewhere it is a.
2. **Flap.** The pixel is on the flap when f > 0, s ≥ f, s ≤ 2f and q lies in [0, 1] × [0, 1] (inclusive). The flap colour is (mix(a_q.rgb, (a_q.α, a_q.α, a_q.α), 0.6)·k, a_q.α) with k = 0.85 + 0.15·clamp((s − f)/w, 0, 1): paper-white mixed into the mirrored picture, darker near the crease.
3. On the flap the output is flap + base·(1 − flap.α) (premultiplied source-over); elsewhere it is the base.

## Edges
The crease and the flap's outline are hard (no anti-aliasing).

## Alpha
As in the blend: the base's alpha, or the flap composited over it. Converted to straight alpha per [T2].

## Notes
- Endpoints: p = 0 gives A exactly (f = 0, no flap, nothing peeled). At p = 1, f = L: every pixel centre is peeled (s < L inside the frame) and the shadow factor is 0, so the output is B.
- The flap's mirror image is the outgoing picture reflected across the crease, as the back of a printed page would show it through thin paper.
