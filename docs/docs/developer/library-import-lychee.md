# Lychee import qualification

The Lychee adapter is under development. A source reader and synthetic fixtures do not establish migration compatibility or destination privacy enforcement. Keep the expanded feature internal until all ten source families pass combined qualification.

## Pinned native evidence

Lychee `v7.12.0` is pinned to commit `8794fe0b5616830c63fda1fbf700b286211963b6`. The official ARM64 image is `lycheeorg/lychee@sha256:712e8da972c037e6c8d4addb0bc26f43f05eebfd4b909ce97a3345aca88dad2f`, running PHP `8.5.12` and SQLite `3.46.1`. The fixture records the immutable image, source archive checksum, complete structural inventory and 580 native migration records. OCI revision/version metadata and an independent source/model checksum agree with the pinned source. The installer created 56 tables, including SQLite's internal sequence/statistics tables.

The native application created four synthetic accounts, three owner-specific private albums, four generated PNG originals, manual titles/captions and a view-only share. Authenticated identity readbacks, nine account/album visibility cases and permission responses were checked through the application. All four independent generated SHA256 values match authenticated HTTP originals and the stopped source's filesystem originals. One original is 3200×2400; the other three are 640×480. The content fixture contains 42 credential-free records across 18 selected tables and generated original bytes. Required upstream MIT attribution accompanies the fixtures.

Source services were stopped with restart disabled before copying the owned test data and taking a standalone SQLite backup. Integrity and foreign-key checks passed. Independent Python and pinned Server Node 22 SQLite calculations agree on structural fingerprint `73fb240f5b51192b7d29ea0a72da6660680295f5e577ad1e77fa6ef0dc227c5d`. These are synthetic capture/byte checks, not a restored-application or complete migration acceptance claim.

## Read-only extraction

`openLycheeSnapshot` accepts only the pinned version and exact structural fingerprint, checks the complete migration-name inventory with positive applied batches, and refuses broken declared foreign keys. Added, missing, duplicated or unknown migration names refuse admission. One read-only transaction, disabled extension loading and untrusted schema execution settings cover admission and extraction together. Content is read in batches of at most 1,000 rows with integer-safe rowid cursors. A caller must independently prove source application/build identity, snapshot completeness, original-file consistency and service/restart fencing; supplying a version string is not that proof.

The allowlist captures photos, size variants, regular/tag/person albums, memberships, tags, ratings, user/group records, explicit permissions and selected person/face records. User password hashes, bearer/remember tokens, OAuth/WebAuthn credentials and face crop tokens are excluded. Sharing retains only the presence of a password, never its hash. Configuration is not dumped wholesale because it can contain credentials. Global configuration defaults and their permission effects still require a separately qualified allowlist before a complete privacy inventory can be claimed.

Schema admission and declared foreign-key checks do not establish semantic completeness. The controller must reconcile owners, album types, every relationship, required original variants, group/inherited permissions and source configuration before activating any destination. New accounts require explicit mappings and remain inactive until claimed; source administrative flags do not grant destination administration.

## Preservation requirements

| Source information         | Captured evidence                                                                           | Required destination behavior                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Originals and RAW variants | Size variant type, storage disk, short path, exact byte count and separate watermarked path | Resolve original/RAW files through the verified storage disk; independently hash bytes and never substitute thumbnails or watermarked renditions |
| Live Photos                | Separate live-photo path, checksum and content identity on photos                           | Preserve companions using qualified storage semantics and byte verification; native Live Photo content remains unqualified                       |
| Manual metadata            | Current titles, descriptions, camera/location/date/timezone fields and highlight state      | Preserve manual source values ahead of embedded metadata; do not assign an instant without timezone evidence                                     |
| Albums, tags and ratings   | Separate regular/tag/person albums, memberships, tag links and per-user ratings             | Retain each source relationship and user boundary; unsupported dynamic behavior needs an identified snapshot/archive treatment                   |
| Ownership and permissions  | Explicit owners, groups, access flags and password/link requirements                        | Require explicit owner mappings and equivalent or stricter destination access; never treat a file URL as permission                              |
| People and face geometry   | Named person records and selected coordinates; no crop tokens or embeddings                 | Transfer assignments only after orientation/geometry conversion is verified; regenerate embeddings and previews                                  |

The native view-only share reports download and full-original rights disabled for Bob. In this configuration, photo resources still contain original variants and known static original URLs remain reachable by an unrelated account, including for the larger photo. This observed URL behavior must not authorize destination sharing: preserve the explicit permission restrictions and use stricter destination access where necessary. Visibility checks, permission intent and URL reachability are separate evidence.

## Outstanding acceptance

Restored-application comparison, global configuration/privacy defaults, group/inherited access, public/password-protected albums, non-empty tag/rating/people cases, orientation conversion, RAW/JPEG pairs, Live Photos, video, missing files, S3/remote/encrypted storage, alternate database engines and source versions need further native qualification. File/storage resolution, protected unsupported metadata, destination accounts and relationships, durable regeneration, transfer/recovery and Manager/Server lifecycle integration remain incomplete. This reader is not exposed as a migration command or UI. Protected Unraid shares are entirely outside qualification and agent access.
