# PiGallery2 import qualification

PiGallery2 migration is internal groundwork and is not available through a CLI or the Manager. The expanded migration feature remains unreleased until all ten source families qualify.

## Pinned native evidence

The synthetic source uses PiGallery2 `3.5.2`, source commit [`ed21d7f94bb346b5ba98e846bd71cd59782b453a`](https://github.com/bpatrik/pigallery2/tree/ed21d7f94bb346b5ba98e846bd71cd59782b453a), archive SHA256 `e63cc03767d4b97d9f6bcc1c0f6bfb31cd7262a4afc81c3af176866eee1741d1`. The official ARM image is `bpatrik/pigallery2@sha256:afc40f0513831ff260171c37bdbf872e52505cd2b35fa7276f0a28566bb43739`; its ARM SLSA provenance records that source commit. Native runtime versions are Node `v22.22.0`, better-sqlite3 `11.10.0`, SQLite `3.49.2` and application data-structure version `41`.

The native application created 13 tables and 47 schema objects. Its complete schema fingerprint is `c2cb2ba31b20e4e37d8ef198fe6eafd79327d43536b81914c4599f32388dae89`, independently established in Python and the actual Server Node 22 reader. Public fixtures contain native DDL, eight credential-free content projections, selected global privacy configuration, independently defined access expectations and original-file hashes. Required source MIT provenance is retained beside them. Raw snapshots, passwords, share keys, cookies and full configuration remain private.

The installer does not have a conventional migration inventory: [SQLConnection](https://github.com/bpatrik/pigallery2/blob/ed21d7f94bb346b5ba98e846bd71cd59782b453a/src/backend/model/database/SQLConnection.ts) drops and rebuilds the database when its recorded data-structure version differs. Never start a source application against an unqualified snapshot to inspect or upgrade it. Extraction requires a frozen, consistent backup and reads it without running the source application.

## Read-only snapshot extraction

`openPigallery2Snapshot` requires the pinned application version, exact complete schema, exactly one matching data-structure-version record and valid declared foreign keys. Unknown or modified schemas fail before content. It uses one read-only transaction, disallows SQLite extensions and returns integer-safe batches of at most 1,000 rows. Authentication material and generated projection caches are excluded. Query and file errors use sanitized refusal codes.

This reader preserves source records; it does not interpret access predicates or establish ownership. Global authentication, guest-role and allow/block settings require a separately verified configuration inventory. Database rows alone are insufficient privacy evidence. Username, directory names, sharing creators and content hashes must never become inferred owners. The destination requires explicit library/owner mappings and equivalent or stricter access before activation.

## Preservation requirements

| Source information | Captured evidence | Required destination behavior |
| --- | --- | --- |
| Directories, media and metadata files | Directory hierarchy, media/file identities and names | Resolve actual originals and required sidecars through a verified storage root; independently hash bytes and retain every relationship |
| Captions, titles, dates and location | Current metadata columns, source date value and separate nullable offset | Preserve current values ahead of stale embedded metadata; do not infer a known timezone from a missing offset |
| People and faces | Person records, junctions and source metadata fields | Retain unsupported data in the protected archive; assign names/coordinates only after verified orientation and geometry conversion |
| Saved searches | Album identity, name and serialized search predicate | Preserve the predicate; materialize unsupported dynamic albums as explicitly identified, verified membership snapshots |
| Users and privacy | Roles and per-user override/allow/block predicates, plus separate global configuration | Require explicit mappings and evaluate inherited settings and block precedence; missing or unsupported privacy evidence blocks activation |
| Public sharing | Creator, search predicate, expiry and password-presence flag | Never migrate bearer keys or password hashes; recreate only equivalent or stricter sharing, otherwise restrict affected content |
| Projection caches | Excluded from extraction | Regenerate from preserved source records and destination permissions |

## Native comparison and limits

Four generated JPEG originals include duplicate bytes in different directories, EXIF captions and a date without a recorded timezone offset. Four source accounts and a saved search were created through the native application. Caption-based allow predicates combined with a filename block predicate produced independently expected search inventories: administrator four, Alice two, Bob two and Mallory one. Nine permitted original downloads matched independent SHA256 values; seven prohibited original requests returned HTTP 403 without media bytes. An Alice-created password-protected share exposed only the shared original and retained her filename block restriction. A separate native installation restored from the stopped database backup and copied generated originals reproduced all four identities, exact search inventories, nine original hashes, seven denials, the saved search and protected share. All 14 projected records, complete schema and selected global privacy settings remained unchanged after that restored application ran. These checks establish that synthetic baseline, not general permission equivalence.

Directory-type allow predicates caused the pinned native SQLite application's restricted root listing to fail with `no such column: directory.path`. That failure is retained as a separate qualification risk. It is not evidence of an empty or unrestricted library and must not be silently converted into either. The final fixture's successful account rules use caption predicates; its saved search retains a directory predicate. General directory-query behavior and saved-search membership evaluation remain unqualified.

The actual Server Node 22 reader reconciles all 14 projected records across eight tables against the stopped source capture. People, metadata files, native RAW/JPEG pairs, Live Photos, video, missing files, additional global/per-user policy combinations, encrypted/remote storage, MySQL, broader restored-application cases and complete semantic reconciliation remain unqualified. Destination accounts, protected archive persistence, Manager integration, transfer/recovery, activation and combined ten-source acceptance remain incomplete. Protected Unraid shares remain entirely outside qualification and agent access.
