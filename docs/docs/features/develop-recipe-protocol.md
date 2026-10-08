# Develop recipe preservation protocol

A stored develop recipe is bounded, opaque JSON with a positive integer `version`. The server keeps its JSON fields independently from the known render projection. Preservation is semantic JSON equality: object-key order and HTTP whitespace are not retained. The original asset is unchanged.

## Save and read

`PUT /assets/{id}/develop` still takes `recipe`, optional `label`, and `render` (default true). Save with `render: false` to retain unsupported semantics without generating a misleading rendition. Readback returns the stored envelope, not a stripped render projection. Recipe JSON is limited to 512 KiB UTF-8, 32,768 values, depth 16, arrays of 4,096 entries and 128 keys per object; its strings and keys together take at most 64 KiB, and a key is at most 128 characters. Every recipe the known fields allow, including one with all 4,096 stroke points, fits. Only finite numbers, strings, booleans, null, arrays and plain objects are allowed. `__proto__`, `prototype` and `constructor` keys are rejected at any depth.

Known version1 fields must satisfy their existing ranges and geometric constraints. Future versions can retain future meanings of those field names. No opaque field authorizes a filesystem path, mask download, remote job or provider request.

Two optional additive save fields support clients that reconstruct only fields they understand:

- `sourceRevisionId` names an immutable revision of the same owned asset. The repository verifies asset/owner/source together under the existing per-asset transaction before creating the next revision. It never substitutes the latest current revision. A missing, removed or unrelated source is refused.
- `replaceRecipe: true` deliberately replaces the full envelope rather than preserving source omissions. Include any opaque fields that should remain when explicitly replacing. Without a source, every save is standalone, including edits starting from the original after revert.

With a named source and without replacement, omitted object keys are retained recursively and supplied values override them. Version must remain the same; explicitly replace to change version. Null is an explicit value, not omission. Arrays are complete replacements, so removing an element is intentional. For the existing masks array, matching stable mask IDs additionally retain omitted nested properties/adjustments; reordered IDs never inherit another mask's opaque fields. Omitted supported-kind mask IDs are removed intentionally. Omitted unsupported-kind masks remain opaque unless explicitly replacing. Named-source preservation of version1 masks requires unique stable IDs (compared after trimming); ambiguous arrays require explicit replacement. A future operation array has no inferred ID/key semantics: carry its complete opaque value or explicitly replace it. The merged result is revalidated for JSON bounds and renderability inside the transaction; a rejected render creates no new revision.

Already shipped clients that omit fields and do not name a source cannot be retroactively made lossless. Updated clients should carry the entire envelope or opt into the explicit source contract. The current web editor carries an untouched envelope separately from its known UI projection through load/change/history/save, including unknown nested mask data. Unsupported future meanings remain untouched unless a user explicitly changes a projected control; the server still refuses to render that future version.

## Render policy

The known version 1 projection fills the same defaults and renders with `frameleaf-develop/4`. Recipes containing only the fields `frameleaf-develop/2` supported render to the same bytes, including zero adjustments and empty masks, and recipes without `perspective` or `keyFrame` render as under `frameleaf-develop/3`.

Any unsupported version, field, operation, mask kind or nested render property refuses preview and explicit/immediate rendering. Unknown data is never silently passed through radial/linear fallback or ignored as a successful rendition. Startup recovery refuses untracked unsupported recipes, and already-delivered/tracked jobs fail permanently without image decoding, publication or automatic retry. Externally developed revisions still use their already-imported file pipeline rather than interpreting a recipe.

Brilliance, brush and bitmap masks, and Clean Up are part of version 1 from renderer `frameleaf-develop/3`, defined below. A recipe that uses none of them renders to the same bytes as under `frameleaf-develop/2`. Native adoption and parity remain separate gates.

## Renderer v3 (`frameleaf-develop/3`)

The server renderer and both native renderers implement these definitions. The server's golden renders are in `server/src/utils/develop-cleanup.spec.ts`.

### Order of operations

1. Decode the original (EXIF orientation applied). The preview decodes a smaller original; every coordinate below is a fraction of the original, so the same content is affected.
2. Apply the Clean Up operations, in order, to the original.
3. Apply the geometry: quarter turns, flips, straighten, crop.
4. Apply the global tone pass, which now includes Brilliance.
5. Apply the masks, in order.
6. Apply the detail stages (noise reduction, sharpening, clarity).

### Original-image coordinates

Brush strokes, Clean Up areas and bitmap masks use **original-image coordinates**: `[x, y]` fractions of the decoded original, before the recipe's rotation, flips, straighten or crop. Radial and linear masks keep using oriented-frame coordinates. To map an oriented-frame pixel back to the original, undo the flips first, then the clockwise quarter turn (90°: `(X, Y) → (Y, h₀ − X)`; 180°: `(w₀ − X, h₀ − Y)`; 270°: `(w₀ − Y, X)`). Distances are measured in original pixels. A stroke `radius` and a pixelate `blockSize` are fractions of the original's shorter side.

### Brilliance

`brilliance` runs from −100 to 100. With `k = brilliance / 100`, it applies to display-referred RGB in `[0, 1]` after the global tone lookup and before highlights and shadows:

- `L = 0.2126 R + 0.7152 G + 0.0722 B`
- `L' = clamp(L + 1.2 k · L (1 − L)(1 − 2L), 0, 1)`
- every channel is multiplied by `L' / L`; when `L = 0`, `L' − L` is added instead
- chroma around `L'` is multiplied by `1 + 0.12 k`

A positive value opens the shadows and holds the highlights back. Black, middle grey and white are unchanged. A negative value does the reverse. Brilliance is a still-image control: saved develop presets carry it, video edits and the built-in looks do not.

### Masks

Brush, subject, sky and background masks use the existing mask adjustments, `amount`, `enabled` and `invert`.

- **`brush`** — `strokes` (at most 64, each with up to 512 points) is a list of `{ points, radius, erase }`. A recipe carries at most 4,096 stroke points in all, counting masks and Clean Up together. Strokes are painted in order:
  - A stroke covers `1` within `(1 − feather/100) · radius` of its polyline. Coverage falls to `0` at `radius` along a smoothstep. Distances use `sqrt`, never `hypot`.
  - A painting stroke sets the weight to `max(weight, coverage)`. An erasing stroke sets it to `weight · (1 − coverage)`.
  - The weights are computed once, on a grid over the original. The grid has `min(1, 2048 / longest side, 12 / smallest stroke radius in pixels)` cells per original pixel, and each cell is evaluated at its centre. The grid is then sampled bilinearly at every pixel, which keeps the cost proportional to the painted area.
- **`subject`, `sky`, `background`** — `artifact` is the id of a greyscale bitmap uploaded for this photo, or proposed by the server with `POST /assets/{id}/develop/masks/propose` and `{ "target": "subject" | "sky", "coordinates": "original" }` (any still; the proposal runs on the instance-local ML worker and is stored as a mask artifact, at most 1,024 pixels a side). The bitmap is stretched over the whole original and sampled bilinearly; 255 means fully selected. `detector` is an opaque descriptor a client can use to detect the mask again. The server never runs a detector. A bitmap mask without an `artifact` is kept in the recipe but does not render.

### Clean Up

`cleanup` holds at most 32 operations: `{ id, method, enabled, region | strokes, feather, source, fill, blockSize }`. Each operation has exactly one area: a `region` rectangle, or `strokes` (which never erase). Coverage of a region uses its `feather` (percent of half its size on each axis). Strokes are covered as in a brush mask, on a grid over the operation's bounding box with `min(1, 12 / smallest stroke radius in pixels)` cells per pixel. Every result is blended in by that coverage. Each operation reads the result of the one before it.

- **`pixelate`** — blocks of `blockSize` × the shorter side, aligned to the image's top-left corner. Each block is replaced by its mean colour over the whole block.
- **`clone`** — the pixel `source` (`dx`, `dy`, fractions of the width and height) away. The offset is rounded to whole pixels and clamped to the image.
- **`heal`** — the clone, shifted per channel by the difference between the area's coverage-weighted mean colour and the mean colour of its source.
- **`remove`** — `fill` is the id of an RGBA bitmap uploaded for this photo, stretched over the area's bounding box and composited by its alpha. The bounding box is in pixels of the image being rendered (`W` × `H`): a region's runs from `floor(x · W)` to `ceil((x + w) · W)` across and likewise down; strokes' runs from `floor(min(px · W − r))` to `ceil(max(px · W + r))` over their points (`r` the stroke radius in pixels), clamped to the image. The fill is generated by the client or by a worker it chose, or by this server with `POST /assets/{id}/develop/fills/generate` (see Renderer v4). Generative fills follow the existing ML consent and destination rules (FL-201): the server never sends a photo off the instance to make one.

A future Clean Up method stays opaque in the envelope, exactly like a future mask kind.

### Develop artifacts

`POST /assets/{id}/develop/artifacts` (multipart: `kind` = `mask` or `fill`, and `file`) needs the same asset-edit permission as saving a recipe. It stores a bitmap a client computed for this photo:

- **Normalization:** EXIF orientation is applied, metadata is dropped, and the bitmap is stored as an 8-bit PNG (greyscale for a mask, RGBA for a fill).
- **Id:** the returned `id` is the SHA-256 of that PNG, so uploading the same bitmap again returns the same id.
- **Limits:** an upload is at most 64 MiB. A mask is never larger than the original. A fill is at most 4,096 pixels a side and 16 megapixels. A photo keeps at most 64 artifacts; an upload beyond that is refused with `develop_artifact_limit`, however many arrive at once.
- **Storage quota:** a stored artifact's size is added to its owner's storage usage, like a photo's, so later photo uploads count it; an upload that would pass the owner's quota is refused with `develop_artifact_quota`. Uploading the same bitmap again is not counted twice, and the size leaves the usage when the artifact is released.
- **Storage:** artifacts are kept in the thumbnails folder beside the photo's rendered versions (`<thumbs>/<owner>/…/<asset>_develop_artifact_<id>.png`) and recorded in the `public.asset_develop_artifact` table. The name comes from the photo and the id, never from a path a client chose.
- **Backups:** unlike thumbnails, artifacts **cannot be regenerated**: a client computed them. Back them up with the rest of the thumbnails folder. The integrity check never reports them as untracked.
- **Release:** artifacts are released when the photo is deleted. An artifact that no saved version of its photo references is released after seven days.

Saving with `render: true`, rendering, or previewing a recipe that references an artifact this photo does not have returns HTTP 400 with `code: develop_artifact_missing` before anything is written. A recipe saved with `render: false` keeps the reference and renders once the artifact is uploaded.

### Saving from the current editor

The editor sends its complete opaque snapshot with `replaceRecipe: true` and the explicitly loaded source revision ID when available. Original reset clears the opaque snapshot and source ID. Undo restores the snapshot; replacement is still explicit and never inherits the latest working revision implicitly.

Unsupported render semantics return HTTP 400 with `code: develop_renderer_unsupported` before a revision, master, or job is created, including after preservation inside the named-source transaction. The editor initially requests rendering. Only that exact status and code permits retrying the identical source and recipe with `render: false`. The saved-only result announces that a newer renderer is required, retains the current preview, and does not follow a queued render. Authorization, missing sources, conflicts, malformed recipes, and transport failures do not trigger this fallback.

### Saved develop presets

A preset holds the develop sliders (Brilliance included), the look and its strength, and its radial and linear masks.

- **Create:** any setting the request leaves out takes its neutral value. A preset saved from the web, which has no Brilliance control, starts with Brilliance at 0.
- **Update:** `settings` is a patch. Only the settings the request sends change. Every other stored setting keeps its value, including Brilliance and any setting the server or client does not know yet. `masks`, when sent, replaces every mask of the preset.
- **Apply:** every setting of the preset goes into the photo's recipe. A client applies the settings it has no control for too (the web applies Brilliance this way) and carries them like any other field it cannot show.

### HDR renderer lineage

New HDR quick edits use recipe v6 and `frameleaf-develop-hdr/4`, with HDR policy v4
and `sdrToneMapper: libultrahdr/2.0.2-frameleaf.4`. This policy reconstructs ISO HDR-base
PQ/HLG images and their authored SDR alternate, and preserves reduced-map
sampling through fractional crops and applies geometry after RGB conversion.
Historical recipe v5 keeps `frameleaf-develop-hdr/3` and policy v3.
Historical recipe v4 keeps `frameleaf-develop-hdr/2` and policy v2. Recipe v3 keeps
`frameleaf-develop-hdr/1` and its original policy. The server checks the installed
codec renderer before rendering; it never regenerates an old recipe with another
codec policy. Previously published files remain available. Opening a supported
historical HDR recipe for editing creates a v6 draft, retains opaque fields, and
saves a new revision. RAW/native v2 and ordinary SDR v1 remain unchanged.

## Renderer v4 (`frameleaf-develop/4`)

Version 1 recipes gain two optional fields. A recipe without them renders to the same bytes as under `frameleaf-develop/3`.

### Perspective (keystone)

`perspective: { vertical, horizontal }`, each from −100 to 100 (an omitted axis is 0). It corrects the oriented frame after the quarter turns and flips and before the straighten, so the order of operations becomes: Clean Up, quarter turns and flips, **perspective**, straighten, crop, tone, masks, detail.

With `v = vertical / 100`, `h = horizontal / 100` and `K = 0.35`, let `t = K·max(v, 0)`, `b = K·max(−v, 0)`, `r = K·max(h, 0)`, `l = K·max(−h, 0)`. In normalized frame coordinates (−1 at the left and top edges, 1 at the right and bottom), each output corner samples the uncorrected frame at:

| Output corner       | Samples              |
| ------------------- | -------------------- |
| top-left (−1, −1)   | (−(1 − t), −(1 − l)) |
| top-right (1, −1)   | (1 − t, −(1 − r))    |
| bottom-right (1, 1) | (1 − b, 1 − r)       |
| bottom-left (−1, 1) | (−(1 − b), 1 − l)    |

Every other point follows the homography those corners define (Heckbert's square-to-quad), sampled bilinearly. A positive `vertical` widens the top of the picture (verticals that converge upwards), a positive `horizontal` the right side. The sampled quadrilateral lies inside the frame, so the corrected frame keeps its size with no empty corners. Radial, linear, brush and bitmap masks map back through the same homography and stay on the content they were drawn over. HDR revisions (versions 3 to 6) accept `perspective` too.

### Key frame (Live and Motion Photos)

`keyFrame: { timeMs }` (an integer from 0 to 600,000) renders the still from the motion clip of a Live or Motion Photo at that time instead of the original still: one frame is decoded at full clip resolution (rotation applied, HDR clips tone mapped to BT.709 as for video thumbnails) and then rendered like an original. Original-image coordinates are fractions, so masks and Clean Up stay on the same content. Preview, save with `render: true`, and render authorize the linked clip separately with the requesting owner's existing PIN and content-privacy permissions. Missing, deleted, offline or foreign-owner clips refuse rendering; background jobs also refuse independently Locked clips, while ordinary Hidden paired clips remain usable. An offset must be strictly before a known clip duration, including fractional durations (`develop_key_frame_out_of_range`). Motion publication requires the queue adoption database transaction; direct worker calls without that transaction fail closed and discard prepared outputs. Publication locks and rechecks both asset identities, the Live Photo relationship and source checksums, and refuses output if the motion clip changes or becomes unavailable while rendering. The revision response's `sourceAssetId` identifies the actual pixel source, and `sourceChecksum` is its SHA-256; historical revisions retain null source identity. Original export/import checks remain bound to the original still. HDR revisions refuse a key frame (`develop_key_frame_unsupported`).

### Server-generated Remove fills

`POST /assets/{id}/develop/fills/generate` with `{ region | strokes, feather }` (exactly the area the Remove operation carries) fills the area on the instance-local ML worker and stores the result as a `fill` artifact covering the area's bounding box; put the returned `id` in the operation's `fill`. The worker gets the area plus half its longer side of context on every side (at most 1,024 pixels a side) and a greyscale mask (255 where content is removed), as the `inpaint` task with model `frameleaf-inpaint`, and answers `{ "inpaint": { "png", "width", "height" } }` with an RGB PNG of the same size. The worker fills with **LaMa (big-lama, Apache-2.0)**, the owner's choice (2026-10-08): `frameleaf-inpaint` is the fp32 ONNX export of big-lama, which the worker downloads from its model source (`frameleaf/frameleaf-inpaint`, file `visual/model.onnx`, pinned by SHA-256) on first use and runs at its fixed 512 × 512 input; the fill is scaled back and blended through the mask, so pixels outside the area are returned unchanged. When no local worker can fill (machine learning off or remote-only, or the model is not available to the worker), the endpoint answers HTTP 503 with `code: develop_inpaint_unavailable` and clients keep generating fills on the device.
