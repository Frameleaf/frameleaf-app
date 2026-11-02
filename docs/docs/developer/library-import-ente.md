# Ente Photos import contract

This is an internal component resolver, not an enabled importer or a compatibility claim. The initial research target is the official Rust CLI `ente-cli-v0.4.2`, source commit `d536e8e913443b9d88c1e60e3a5463cb78ba5592`. Legacy Go CLI and desktop exports require separate qualification; Takeout-like fields do not establish an identical export contract.

## Inputs and ownership

`resolveEnteComponents` joins an exported file sidecar with the corresponding authenticated CLI file-inventory record by exact source file ID. Sidecars do not contain file ownership. The owner must come from `ownerId` in the authenticated inventory, including when an account exports another owner's shared album. Never infer file ownership from the current account, album owner, filename or email.

The caller must first verify the exporter build, root `export.json` format/version and account identity, complete pagination, an unchanged source inventory, all selected album memberships and independently captured access permissions. CLI list capture must request `--all`; a successful command with its default result limit is insufficient. Album visibility and file visibility are separate, and shared albums can have account-specific visibility.

The helper validates positive signed 64-bit source identities as decimal strings, matching media types, membership in the supplied album metadata, nonempty unique inventory album references, component roles, distinct safe filenames, byte counts and canonical source hashes. Component paths are single filenames relative to the album directory, not export-root paths. The caller must bind that directory to its `metadata.json` before resolving files. It returns paths and evidence only. It does not establish export completeness, filesystem containment, byte integrity, account mappings or permission equivalence.

## Preservation matrix

| Source evidence                        | Current handling                                                  | Remaining qualification                                |
| -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| File ID and inventory owner ID         | Exact identity join; no email matching                            | Full account mapping and destination creation          |
| Image or video                         | One `original` component                                          | Native media varieties and destination import          |
| Live Photo                             | Retain both `image` and `video` components under the same file ID | Native Live Photo export and pairing                   |
| Component size                         | Reject fractional, negative or unsafe JSON integers               | Independently verify every file's bytes                |
| Component hash                         | Retain Ente's base64 BLAKE2b-512 evidence separately              | Independently compute destination SHA256               |
| Albums, favourites and manual metadata | Retain source records for subsequent mapping                      | Resolve every source relationship and conflicting edit |
| Owners, sharees and public links       | Require complete authenticated evidence                           | Equivalent or stricter destination access              |
| Unsupported metadata                   | Requires a protected migration archive                            | Archive creation and review are not implemented here   |

Ente's portable sidecar uses `livePhoto`, while the pinned CLI inventory uses `livephoto`. Neither spelling implies two independent logical photos. A sidecar for either Live Photo component describes both files; callers must reconcile repeated sidecars without discarding album relationships.

## Native evidence

The sanitized fixture records the published CLI archive and executable hashes, the actual Museum executable hash, the immutable source commit, the qualification image and PostgreSQL 18.6. The upstream Museum account/upload/export integration test passed with the published CLI against a disposable local Museum, PostgreSQL and S3 fixture, without network access. No production account or media was used.

One opaque 32-byte original was encrypted, uploaded, decrypted and exported by both its owner and a VIEWER sharee. The fixture preserves their distinct account identities, the original file owner, album membership and the absence of the owner's private file metadata in the sharee's export. The actual Server Node 22 resolver matched both exported originals, byte lengths, BLAKE2b-512 values and independently computed SHA256 values. Root verifiers, exporter recovery state, encrypted keys, raw API records and credentials are omitted from the public fixture.

This qualifies the small export-component contract exercised here. It does not qualify JPEG/RAW/video decoding, Live Photos, hardlinks, export interruptions, complete-library inventory stability, permissions mapping or a destination migration. Live Photo shape tests are synthetic and do not replace native qualification.

## Storage and recovery

Read actual decrypted export files. Encrypted Museum database records and objects cannot substitute for an authenticated decrypted export. Resolve contained export links safely, check hardlinks and source changes, and independently hash originals before creating Frameleaf records. A filename in export `Trash/` is export history, not definitive source trash state.

Keep root `sourceVerifier`, exporter recovery databases, account credentials and raw API captures private. The verifier is derived from the account master key and is unnecessary for this resolver. Never include these in logs, configuration exports or public fixtures.

Copy/export is the default. Adoption or relocation requires a separately qualified local plaintext staging directory and the common recovery workflow. This helper performs no transfers, activation, permission changes or writes to either application.
