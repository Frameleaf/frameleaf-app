# barnDoor

| | |
|---|---|
| Category | motion |
| Directions | none (any stored direction is ignored) |
| Duration (frames) | default 30, min 5, max 90 (editor) |
| Route | Canvas 2D (transition registry renderer; no GPU transition id) |
| HDR | refused [T5] |

## What it does
The incoming clip B is revealed through a vertical opening that starts as a zero-width line on the vertical centre line and widens symmetrically to the left and right edges, like two barn doors (showing A) sliding apart. The doors do not move their content: A stays fixed in place and is only cropped.

## Route (shared Canvas 2D registry machinery)
This section applies to all 23 Canvas 2D transitions in this folder (barnDoor, split, the seven wipe variants, the nine iris variants, the five shape variants); other files cite it as "barnDoor.md §Route".

- Every one of these ids is registered in the transition registry with a Canvas 2D renderer and **no GPU transition id**. Path resolution therefore yields "registry Canvas 2D" whether or not a GPU is available; the GPU transition pipeline is never tried and the built-in fallback switch is never reached. None of them falls back to a hard cut in production: both the frame renderer and the dispatcher load the registry as a side effect before use. (Only a consumer that skipped registry population would cut at p < 0.5 → A, else B; that does not happen in the shipped preview or export.)
- Preview and export use the same render engine; when the GPU compositor is active it first attempts a GPU transition texture, which fails immediately for these ids (no GPU id), and the frame then falls back to the Canvas 2D drawing described here. The editor's small hover preview of a transition calls the same renderer.
- Output surface: a pooled W×H canvas, reset before use to global alpha 1, source-over compositing, and cleared to transparent black (0,0,0,0). The transition draws onto it, and the result is composited as that track's layer like any other layer. So whatever is not drawn is **transparent**, not black [T2].
- A and B are W×H canvases (the fully rendered outgoing/incoming clips, effects applied). Every image draw places them at (0,0) with destination size W×H, i.e. a 1:1 pixel copy with no resampling.
- Progress p [T1] is clamped to [0,1] by the renderer before use (so overshooting cubic-bezier timings are clipped, not extrapolated). No further reshaping.
- Clipping: "clip to a path" means subsequent draws only affect pixels inside the path (pixels decided at their centres, [T6]). The fill rule is non-zero unless a file says even-odd. All rectangles in these files are axis-aligned with non-negative width and height, traced in the same rotational sense, so a union of rectangles under the non-zero rule is simply the set union.
- An empty clip path means the clipped draw affects nothing.

## Parameters
None. Undeclared properties that are finite numbers are kept by the sanitiser [T4] but not read. No hidden defaults.

## Progress curve
p as given [T1], clamped to [0,1]. Linear geometry in p.

## Geometry
Let d = max(0, (W/2)·(1 − p)) (door width).

1. Draw B at (0,0), size W×H, global alpha 1, source-over.
2. Clip (non-zero) to the union of two rectangles:
   - left door: x ∈ [0, d], y ∈ [0, H];
   - right door: x ∈ [W − d, W], y ∈ [0, H].
3. Draw A at (0,0), size W×H, global alpha 1, source-over, inside the clip.

So B is visible in the central band x ∈ [d, W − d] (width p·W), A elsewhere.

- p = 0: d = W/2, A covers the whole frame.
- p = 1: d = 0, the clip is two zero-width rectangles (empty), output = B.

## Blend
Source-over only, global alpha 1 throughout. Within the doors the result is A over B (where A is fully opaque, pure A; where A has transparency, B shows through it). In the opening, pure B.

## Edges
The door edges at x = d and x = W − d are generally fractional; they are clip edges, decided at pixel centres [T6]. No feathering.

## Alpha
Background is transparent. Output alpha = B alpha in the opening; A-over-B alpha in the doors. If both inputs are opaque the output is opaque everywhere.

## Notes
- Identical geometry to centerWipe (see centerWipe.md); the two ids differ only in category/label.
- The door edges follow the clip rule of [T6]; GPU-accelerated browser canvases anti-alias them instead, within the `edge` tolerances.
