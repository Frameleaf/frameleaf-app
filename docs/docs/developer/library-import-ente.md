# Ente Photos import contract

The component resolver and common-manifest mapper are internal; they do not enable an importer or establish source compatibility. The initial research target is the official Rust CLI `ente-cli-v0.4.2`, source commit `d536e8e913443b9d88c1e60e3a5463cb78ba5592`. Legacy Go CLI and desktop exports require separate qualification; Takeout-like fields do not establish an identical export contract.

## Inputs and ownership

`resolveEnteComponents` joins an exported file sidecar with the corresponding authenticated CLI file-inventory record by exact source file ID. Sidecars do not contain file ownership. The owner must come from `ownerId` in the authenticated inventory, including when an account exports another owner's shared album. Never infer file ownership from the current account, album owner, filename or email.

The caller must first verify the exporter build, root `export.json` format/version and account identity, complete pagination, an unchanged source inventory, all selected album memberships and independently captured access permissions. CLI list capture must request `--all`; a successful command with its default result limit is insufficient. Album visibility and file visibility are separate, and shared albums can have account-specific visibility.

The helper validates positive signed 64-bit source identities as decimal strings, matching media types, membership in the supplied album metadata, nonempty unique inventory album references, component roles, distinct safe filenames, byte counts and canonical source hashes. Component paths are single filenames relative to the album directory, not export-root paths. The caller must bind that directory to its `metadata.json` before resolving files. It returns paths and evidence only. It does not establish export completeness, filesystem containment, byte integrity, account mappings or permission equivalence.

## Preservation matrix

| Source evidence                        | Current handling                                                  | Remaining qualification                                |
| -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| File ID and inventory owner ID         | Exact identity join; no email matching                            | Full account mapping and destination creation          |
| Image or video                         | One `original` component                                          | Native media varieties and destination import          |
| Live Photo                             | Retain both `image` and `video` components under the same file ID | Apple-device acceptance and destination pairing        |
| Component size                         | Reject fractional, negative or unsafe JSON integers               | Independently verify every file's bytes                |
| Component hash                         | Retain Ente's base64 BLAKE2b-512 evidence separately              | Independently compute destination SHA256               |
| Albums, favourites and manual metadata | Retain source records for subsequent mapping                      | Destination relationship mapping and conflicting edits |
| Owners, sharees and public links       | Require complete authenticated evidence                           | Equivalent or stricter destination access              |
| Unsupported metadata                   | Requires a protected migration archive                            | Archive creation and review are not implemented here   |

Ente's portable sidecar uses `livePhoto`, while the pinned CLI inventory uses `livephoto`. Neither spelling implies two independent logical photos. A sidecar for either Live Photo component describes both files; callers must reconcile repeated sidecars without discarding album relationships.

## Common manifest mapping

`readEnteManifest` binds each account to its root export identity and the pinned exporter contract fingerprint. It requires complete, unchanged authenticated inventories and receipts for every album placement and media component. The controller must independently establish this capture evidence; caller-supplied completeness flags do not authorize execution.

The mapper coalesces repeated placements by source file ID and component, selects an original path from the owning account's export, and retains every placement receipt in the protected archive. Equal bytes with different source IDs or owners remain distinct. The canonical destination writer requires review of unresolved duplicate primary bytes within one owner; the adapter never silently drops those records.

| Source evidence                               | Manifest handling                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Current caption, capture instant and location | Authenticated current values override stale embedded metadata; missing location remains explicitly empty |
| Local clock and fixed offset                  | Preserve the encoded clock and six fractional digits; do not invent a named regional zone                |
| Private visibility and favourite state        | Use the owning account's private state; keep sharee views in the protected archive                       |
| Original album memberships                    | Preserve owner content and restrict destination sharing; disclose unsupported access differences         |
| Favorites, hidden and uncategorized albums    | Preserve clearly named membership snapshots                                                              |
| Live Photo components                         | Create the still/motion relationship, with the motion asset hidden                                       |
| Folder named `Trash/`                         | Does not establish source trash state; unsupported authenticated visibility blocks mapping               |
| Other metadata and placement evidence         | Preserve credential-free records in the protected archive                                                |

The synthetic mapping suite expands the native fixture's complete ID inventories using its representative sidecars. It covers repeated placements, distinct owners with equal bytes, edited metadata, album relationships, Live Photos, incomplete or changed captures and safe refusal of unsupported inputs. This is mapping evidence, not a complete native migration or a release qualification. Encrypted account secrets and root verifiers are excluded from both manifest and archive; the export does not provide a compatible destination login verifier.

## Native evidence

The sanitized fixture records the published CLI archive and executable hashes, the actual Museum executable hash, the immutable source commit, the qualification image and PostgreSQL 18.6. The upstream Museum account/upload/export integration test passed with the published CLI against a disposable local Museum, PostgreSQL and S3 fixture, without network access. No production account or media was used.

One opaque 32-byte original was encrypted, uploaded, decrypted and exported by both its owner and a VIEWER sharee. The fixture preserves their distinct account identities, the original file owner, album membership and the absence of the owner's private file metadata in the sharee's export. The actual Server Node 22 resolver matched both exported originals, byte lengths, BLAKE2b-512 values and independently computed SHA256 values. Root verifiers, exporter recovery state, encrypted keys, raw API records and credentials are omitted from the public fixture.

The extended native fixture uses generated JPEG and H264 MOV originals, including an Ente-recognized ZIP Live Photo pair. Alice has 131 logical files and Bob sees 132, including a separate Bob-owned file with identical JPEG bytes. The exporter traversed its 128-record local file-page boundary. The actual Server Node 22 resolver verified all 134 Alice and 133 Bob physical copies, complete source-ID sets, every exported album membership, lengths, BLAKE2b-512 and independent SHA256 values.

Before/after authenticated `--all` file and album inventories matched. Three Alice placements of the manually edited first photo were hardlinked to the same inode; the same bytes owned by Bob retained a distinct source ID, owner and inode. Native Favorites is exported as an album as well as a per-account favourite flag. Owner-only album membership and private file visibility were absent from the sharee's inventory. Generated media, representative sidecars and complete source-ID inventories are included in the sanitized media fixture. The JPEG's intentionally stale embedded date remains in the original bytes while native manual name, caption, date/time-zone and location edits remain in the sidecars and authenticated inventory.

This qualifies the small export-component contract exercised here. It does not qualify destination media decoding, RAW, Apple-device Live Photo acceptance, contained symlinks, transfer/adoption/relocation recovery, export interruptions, the Museum API’s larger page boundary, changing-source refusal, source trash completeness, permissions mapping or a destination migration. The generated Live Photo pair proves the native Ente export/component contract; it is not a captured iOS Live Photo or a device acceptance test.

## Storage and recovery

Read actual decrypted export files. Encrypted Museum database records and objects cannot substitute for an authenticated decrypted export. Resolve contained export links safely, check hardlinks and source changes, and independently hash originals before creating Frameleaf records. A filename in export `Trash/` is export history, not definitive source trash state.

Keep root `sourceVerifier`, exporter recovery databases, account credentials and raw API captures private. The verifier is derived from the account master key and is unnecessary for this resolver. Never include these in logs, configuration exports or public fixtures.

Copy/export is the default. Adoption or relocation requires a separately qualified local plaintext staging directory and the common recovery workflow. This helper performs no transfers, activation, permission changes or writes to either application.
