# Develop recipe preservation protocol

A stored develop recipe is bounded, opaque JSON with a positive integer `version`. The server keeps its JSON fields independently from the known render projection. Preservation is semantic JSON equality: object-key order and HTTP whitespace are not retained. The original asset is unchanged.

## Save and read

`PUT /assets/{id}/develop` still takes `recipe`, optional `label`, and `render` (default true). Save with `render: false` to retain unsupported semantics without generating a misleading rendition. Readback returns the stored envelope, not a stripped render projection. Recipe JSON is limited to 64 KiB UTF-8, depth 16, 4096 values and 128 keys per object; keys are at most 128 characters. Only finite numbers, strings, booleans, null, arrays and plain objects are allowed. `__proto__`, `prototype` and `constructor` keys are rejected at any depth.

Known version1 fields must satisfy their existing ranges and geometric constraints. Future versions can retain future meanings of those field names. No opaque field authorizes a filesystem path, mask download, remote job or provider request.

Two optional additive save fields support clients that reconstruct only fields they understand:

- `sourceRevisionId` names an immutable revision of the same owned asset. The repository verifies asset/owner/source together under the existing per-asset transaction before creating the next revision. It never substitutes the latest current revision. A missing, removed or unrelated source is refused.
- `replaceRecipe: true` deliberately replaces the full envelope rather than preserving source omissions. Include any opaque fields that should remain when explicitly replacing. Without a source, every save is standalone, including edits starting from the original after revert.

With a named source and without replacement, omitted object keys are retained recursively and supplied values override them. Version must remain the same; explicitly replace to change version. Null is an explicit value, not omission. Arrays are complete replacements, so removing an element is intentional. For the existing masks array, matching stable mask IDs additionally retain omitted nested properties/adjustments; reordered IDs never inherit another mask's opaque fields. Omitted supported-kind mask IDs are removed intentionally. Omitted unsupported-kind masks remain opaque unless explicitly replacing. Named-source preservation of version1 masks requires unique stable IDs (compared after trimming); ambiguous arrays require explicit replacement. A future operation array has no inferred ID/key semantics: carry its complete opaque value or explicitly replace it. The merged result is revalidated for JSON bounds and renderability inside the transaction; a rejected render creates no new revision.

Already shipped clients that omit fields and do not name a source cannot be retroactively made lossless. Updated clients should carry the entire envelope or opt into the explicit source contract. The current web editor carries an untouched envelope separately from its known UI projection through load/change/history/save, including unknown nested mask data. Unsupported future meanings remain untouched unless a user explicitly changes a projected control; the server still refuses to render that future version.

## Render policy

The known version1 projection fills the same defaults and uses the same `frameleaf-develop/2` renderer. Recipes containing only existing supported fields retain their render behavior, including zero adjustments and empty masks. There is no new rendering algorithm in this prerequisite packet.

Any unsupported version, field, operation, mask kind or nested render property refuses preview and explicit/immediate rendering. Unknown data is never silently passed through radial/linear fallback or ignored as a successful rendition. Startup recovery refuses untracked unsupported recipes, and already-delivered/tracked jobs fail permanently without image decoding, publication or automatic retry. Externally developed revisions still use their already-imported file pipeline rather than interpreting a recipe.

Brilliance, subject/sky/background/brush masks and ordered Clean Up fills are not implemented by this protocol. Their documented algorithms, original-coordinate mapping, revision artifact ownership, golden renders and consent/destination worker contracts remain subsequent FL233 acceptance packets. Native adoption and parity remain separate gates.

### Saving from the current editor

The editor sends its complete opaque snapshot with `replaceRecipe: true` and the explicitly loaded source revision ID when available. Original reset clears the opaque snapshot and source ID. Undo restores the snapshot; replacement is still explicit and never inherits the latest working revision implicitly.

Unsupported render semantics return HTTP 400 with `code: develop_renderer_unsupported` before a revision, master, or job is created, including after preservation inside the named-source transaction. The editor initially requests rendering. Only that exact status and code permits retrying the identical source and recipe with `render: false`. The saved-only result announces that a newer renderer is required, retains the current preview, and does not follow a queued render. Authorization, missing sources, conflicts, malformed recipes, and transport failures do not trigger this fallback.
