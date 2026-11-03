# Imported stack relationships

Manifest version 4 adds an explicit, complete stack inventory to the sealed photo fields in version 3. Each stack records its source ID, owner, selected primary photo and member photo IDs. Versions 1–3 retain their existing parsing and fingerprints and do not acquire inferred stacks.

A stack requires at least two distinct, known photos belonging to its known owner, with its primary among those members. A photo cannot belong to multiple stacks. Members must have the same visibility and equivalent effective album grants: grants are combined across albums for each other actor, retaining the stronger editor role. Different private-album membership alone does not grant another actor access. Unknown or incompatible relationships refuse preflight rather than exposing siblings through a new grouping.

These structural checks do not establish source permission equivalence. Adapters must independently qualify the source inventory and its access paths. Unsupported grouping needs protected source retention and an explicit preservation decision; matching bytes or filenames never establishes a source stack.

`CanonicalStackWriter` derives its intent from the bound manifest and reviewed destination plan. It requires the operation's committed owner and photo mappings, an eligible non-administrator owner, unlocked photos with unchanged ownership/visibility/status, and no existing stack assignment. It locks the selected photos in order, creates the stack with the explicitly selected primary, updates every member and commits its recovery mapping in one transaction. It does not change originals, storage paths, quotas or album grants.

Identical retry recovers the committed identity. Interrupted transactions leave neither partial membership nor a mapping; a lost acknowledgement can be retried without creating another stack. Changed source intent, conflicting destination relationships and attempts to write beyond the verification boundary refuse.

`reconcileImportedStacks` independently verifies the exact mappings, stack rows, owner eligibility, primary, complete membership, member ownership, state and absence of locks in a consistent, fenced verification transaction. Its report contains counts and a digest, without media names. Photo reconciliation also checks the expected stack IDs for version 4; legacy manifests still require unstacked photos.

This is an internal relationship stage. Account credentials, original bytes, photo metadata and album permissions require their separate verification. Database tests use real owner/photo writes and mock only filesystem verification; they do not qualify original files or any source application. Source normalization, held regeneration integration, controller/CLI/Manager integration and all ten-source qualification remain required before activation or expanded release. Named faces and media companions have separate preservation requirements.
