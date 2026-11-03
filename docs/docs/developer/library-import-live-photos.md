# Imported Live Photos

Manifest version 5 extends the sealed version 4 contract with a required `livePhotos` inventory. Each pair identifies `photoAssetId` and `videoAssetId`: an original image and an original motion video belonging to the same source owner. Each asset can occur in only one pair. Empty pair inventories are valid; legacy manifests keep their existing shapes and fingerprints.

Both originals remain independently checksummed, transferred and charged to their mapped owner. The motion video must already be hidden, active, outside albums and outside stacks. The still can be in the timeline, archive or hidden. Locked and trashed pairs require a separately qualified contract and are refused. Import does not infer a pair from filenames, capture times or embedded identifiers.

Frameleaf serves the motion original through the still's Live Photo relationship. Adapters must independently establish that this preserves source ownership and sharing restrictions. A standalone video, separate motion-album membership or incompatible source permissions cannot silently become a hidden companion. Such a source requires reviewed normalization or an explicitly acknowledged preservation difference before it can enter this contract.

## Atomic creation and recovery

The internal controller writes the motion asset before the still. `CanonicalAssetWriter` requires its committed mapping from the same operation, including its sealed record fingerprint. Within the still's journal transaction it locks and checks the actual motion record's owner, video type, active/hidden state and absence of locks, stacks, albums or existing Live Photo references. It then creates the still with its explicit motion reference, original records, metadata, quota update and recovery mapping together. Interruption rolls these changes back; retry after a committed write returns the retained identity.

The still's prepared-record fingerprint includes the source motion identity. Earlier manifest versions retain their existing prepared hashes. Independent photo readback resolves the sealed pair through committed mappings and compares the actual reference alongside all original files, owners, quotas, metadata, visibility and stack relationships. Missing or substituted references refuse reconciliation.

## Regeneration and qualification

Held regeneration accepts sealed versions 3 through 5 and includes motion originals in its frozen cohort. Imported metadata jobs preserve the qualified relationships: stale embedded identifiers cannot relink them, and embedded motion extraction cannot create a replacement original. Ordinary metadata extraction retains its existing behavior.

This is an internal preservation stage. Its database fixtures mock file verification and do not qualify source bytes, source export completeness or source permission semantics. Source normalization, required sidecars, named faces, the lifecycle commands, Manager integration and combined ten-source qualification remain required before activation or expanded release. No publication or deployment is authorized by these checks.
