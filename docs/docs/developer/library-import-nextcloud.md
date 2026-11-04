# Nextcloud Photos / Memories import research

This adapter contains an internal frozen-snapshot reader and common-manifest mapper.
It does not resolve host files, grant destination access or advertise compatibility.
The public import flow and combined ten-source release gate remain closed.

## Pinned installation

- Nextcloud 35.0.0 (`da02f41d1cc73607084cd675ee1d849fc8cd2de1`), official ARM image
  `nextcloud@sha256:ec43ff8fbdc0dde4797652b9217c6bef7a5b90b3450eae8a109436a69f398da2`.
- Bundled Photos 8.0.0, stable35 source
  `43b7e05794301a949d7dc61666dca4ca3db3dfb0`. The version file and album mapper
  match the image byte-for-byte. Photos master targets Nextcloud 36 and is outside
  this fixture.
- Memories 10.2.0 (`d59c33d94d4e9627565e2023eb3c5c798788ebe2`), published package
  SHA256 `301635782b420cfc29b9739d04cfd850d4cae4e303a6e7c56442f16dd4afc514`.
- PHP 8.5.10 / SQLite 3.46.1, default `oc_` table prefix. PostgreSQL, MariaDB,
  alternate prefixes, Photos without Memories, different enabled-app combinations,
  and upgrades are unqualified.

The fixture captures 147 tables / 465 catalog objects and 290 migration records.
The reader requires the exact schema fingerprint, migration inventory and installed,
fully enabled Photos/Memories versions. Unexpected schemas or application state fail
closed. Capture a separate consistent SQLite backup after fencing source writers;
include committed WAL contents. The reader opens a read transaction and emits bounded
1,000-row pages with exact signed 64-bit database integers.

## Preservation matrix

| Data                   | Reader behavior                                                                                               | Required before activation                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Users and groups       | IDs, display names and memberships; no account password hashes                                                | Explicit owner mapping; preserve qualified authentication separately; secure claims are fallback   |
| Originals              | File IDs, storage IDs, mounts, internal paths, size, encryption flag and source checksums                     | Storage-aware resolution, containment and independent original-byte hashes                         |
| Albums                 | Owner, location, filters, membership and contributing file owner                                              | Resolve smart filters, dangling records and cross-owner relationships                              |
| Album access           | Distinct user/group/public-link collaborator types; public-link token omitted                                 | Native effective-access and download oracle; equivalent or stricter destination permissions        |
| File sharing           | Source permission bits, download restrictions, attributes and password-presence flag; no share token/password | Interpret all restrictions and global sharing configuration; restrict unsupported sharing          |
| Metadata               | Memories records, file metadata JSON, tags and legacy categories                                              | Manual-edit precedence, timezone and location validation; protected archive for unsupported fields |
| Live Photos and people | Retain available source metadata                                                                              | Verified companion identities, geometry/orientation and native/device acceptance                   |
| Internal state         | Omit sessions, authentication tables, general app configuration and file-metadata sync cursors                | Regenerate destination caches/embeddings; durably schedule jobs                                    |

`filecache.path` is relative to a storage, not a host pathname. `path_hash` and etags
are not original-content checksums. A numeric storage ID must join the storage and
mount records before resolving bytes. Encrypted files, remote storage and object
stores require a verified decrypted staging export. Nothing in this reader authorizes
in-place adoption, relocation, source restart or destination activation.

## Local home original classification

`resolveNextcloudHomeOriginal` joins one file-cache record to its storage, local home
mount, storage-root record, user and MIME record. All numeric identities must match;
the local home storage identity, mount provider, mount point and owner must agree.
Only readable, unencrypted image/video originals under `files/` are accepted. Unsafe
paths, generated application data, trash-tree paths, unavailable storage, object or
external mounts, encrypted files and missing/mismatched records are refused.

The result preserves source file IDs, owner IDs and numeric storage scopes, including
identities beyond JavaScript safe integers. Paths remain relative to the explicitly
bound storage root. File-cache path hashes, etags and stored checksums never become
migration content hashes. The caller must still prove filesystem containment, source
consistency and original bytes independently. Remote/encrypted sources need a
separately qualified decrypted export; this classifier does not provide that export,
interpret sharing restrictions, pair Live Photos or authorize file movement.

The five generated-original classifications match the captured native storage API
inventory below, including separate-owner duplicate bytes. This comparison reuses the
existing pinned fixture; it is not a new full-source or filesystem acceptance run.

## Common-manifest mapping

`readNextcloudManifest` joins file-cache IDs, MIME types, storage identities, local
home mounts and owners before matching independent original receipts. Each storage
is bound to a distinct relative staging prefix; file-cache paths never become host
paths. All readable home images and videos require receipts, including Nextcloud's
stock media. The fifteen home originals in this fixture cannot be represented by
only its five generated-original receipts. Unit tests label synthetic stock receipts
separately from the five native byte proofs. Unmounted `appdata_` media in the local
application storage is archived as generated content. Other unresolvable image/video
records, remote storage, encryption, mismatched paths, timestamps or byte lengths
refuse mapping rather than silently disappearing.

The caller explicitly selects the current Photos or Memories metadata view. Photos
date/GPS edits live in file metadata independently of original EXIF, whereas Memories
edits are reflected in original EXIF and its indexed cache. These views can differ;
the mapper does not silently combine conflicting date/location values. Photos'
missing GPS key means cleared coordinates, including when Memories retains older
coordinates. `editPermission` does not prove manual-edit provenance. Memories dates,
source wall clocks, descriptions, ratings and coordinates are accepted only when its
file modification time still matches the original's file-cache record. Source
metadata outside the selected view remains in the protected archive.

Known Memories capture instants and local clocks remain separate, with no invented
regional timezone. Photos timestamps without an independently known source wall
clock use disclosed UTC presentation. Missing capture dates use the admitted file
modification time and require a separate preservation-loss acknowledgment. These
fallbacks do not establish the original capture timezone. Original filenames,
per-owner legacy tags/favourites and owner-private static album memberships are
mapped. Source sharing, cross-owner album relationships and restricted system tags
remain restricted/archived and disclosed. Dynamic album filters require a separately
verified materialized export; they are not treated as complete static memberships.
Named JPEG/MOV pairs are not automatically paired as Live Photos. Nonempty Memories
Live Photo IDs are archived with a qualification disclosure until companion identity
is independently verified.

All projected noncredential records remain in the protected migration archive.
Unsupported titles, album locations, extra EXIF fields and metadata from the other
application view remain there rather than being silently discarded. Account password
verifiers continue through the existing protected channel, outside this manifest and
archive. Global authentication, hidden-content policy, people and sharing equivalence
still need trusted capture and qualification before activation. The mapper's inventory
fields describe its input contract; they do not authorize capture or activation.

## Native fixture evidence and limits

An isolated installation with no external network or exposed ports created three
synthetic users, five generated originals and four albums through native application
APIs. It covers separate-owner duplicate bytes, JPEG/MOV files, and private,
user-shared, group-shared and public-link albums. An independent expectation matched
all twelve owner/collaborator outcomes from Photos' mapper. These are mapper checks,
not full browser/DAV/download permission acceptance. Public-link credentials are
redacted; source passwords, sessions and configuration remain outside the repository.

All five original lengths and SHA256 values match independently generated inputs and
the native storage API inventory. Alice's and Bob's identical JPEGs retain distinct
file IDs and storage owners. Native Memories indexing produced three JPEG rows and
no video rows: video metadata completeness is unqualified. The named JPEG/MOV pair
has no qualified Live Photo identifier. Manual metadata precedence, RAW, named faces,
trash, restricted downloads, public-link behavior and changing-source refusal still
need application-level qualification. A synthetic unit-test share exercises policy
extraction and credential omission; it is not a native sharing qualification.

The content fixture contains 165 projected records across 18 tables, including native
internal/stock file-cache records. Only the five generated originals have byte-proof
coverage here. The catalog includes authentication table definitions; fixture data
never includes their contents. Sources: [Photos stable35](https://github.com/nextcloud/photos/tree/43b7e05794301a949d7dc61666dca4ca3db3dfb0),
[Memories 10.2.0](https://github.com/pulsejet/memories/tree/d59c33d94d4e9627565e2023eb3c5c798788ebe2).
Inherited AGPL terms accompany the sanitized fixture.

Full native source inventory qualification, account/privacy conversion, destination reconciliation,
transfer/recovery, Manager journeys, every advertised engine and combined ten-source
acceptance remain outstanding. No source-compatibility, release or deployment claim.

Local account password verifiers are available through a separate protected channel. Qualified version-prefixed bcrypt/Argon2 formats retain the password; unprefixed legacy formats remain unsupported. This does not transfer sessions, app passwords or external identity bindings. Multi-factor requirements, disabled accounts and global authentication policy still block activation until equivalent destination handling is proven. See [account authentication](./library-import-adapters.md#php-account-password-formats).
