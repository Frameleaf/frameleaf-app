# Frameleaf NAS distribution

`node packaging/nas/build.cjs RELEASE frameleaf-vX.Y.Z-N OUTPUT` builds the DSM SPK, TrueNAS Community app source and Unraid XML templates from one Frameleaf release. Before writing output it verifies version 3 release and NAS manifests, SHA256SUMS, asset hashes, all application image signatures, exact release attestations using committed `cosign.pub`, and the successful source build run. Install Cosign and server workspace dependencies; use `GITHUB_TOKEN` for authenticated reads when needed. Keep both manifests with packages and preserve digest references.

These packages create a fresh canonical Frameleaf database on PostgreSQL 19 beta 4 with pgvector 0.8.7 and HNSW. Mount the database directory at `/var/lib/postgresql`; PostgreSQL writes its versioned data beneath it. An offline, read-only Immich 3.x export through stable 3.2.4 is a separate one-time import source. Never reuse an older PostgreSQL volume as the canonical database.

Follow the [offline import procedure](../../docs/docs/administration/import-immich.md) for source-version and read-only-role preflight, independent media copies, interruption/resume and verification before activation. Retain the stopped source database and media as the import recovery point. For an existing canonical Frameleaf installation, preserve a matched database, media, configuration and encryption-key backup before upgrading; [restore that recovery point with its matching release](../../docs/docs/administration/backup-and-restore.md) if recovery is needed. Downgrading an image against an upgraded schema is not rollback. Rehearse imports and recovery only on disposable copies.

DSM 7.2.1+ with Container Manager 1432+ on a 64-bit x86 or ARM host is required. The SPK includes server, PostgreSQL and optional CPU ML. Wizard media/database paths must already exist and must not overlap. Data remains outside the SPK, and uninstall retains it. `preinst` stages private configuration under `SYNOPKG_PKGINST_TEMP_DIR`; Container Manager acquires the project before `postinst` persists configuration under `SYNOPKG_PKGVAR`. Upgrade checks the retained configuration and a backup acknowledgement. Platform behavior still requires actual install, restart, upgrade, restore and retained-data uninstall checks before a store submission.

Copy the rendered `truenas/ix-dev/community/frameleaf` directory into the TrueNAS apps catalog and use its matching pinned `base_v2_3_4` library. The app maintains independent media and PostgreSQL datasets, an internal network and optional ML. The renderer checks the library's committed hash before import, rejects symlinks and disables bytecode writes. `requirements-render.lock` pins the hosted Linux CPython 3.11.15 renderer dependencies with hashes. Run the real library render in hosted CI in both ML modes.

Unraid templates use an external PostgreSQL container with the digest in `nas-manifest.json`; configure it on the same network as the server. Configure media storage, database credentials and optional ML according to the templates. Database backups and media originals must be retained before upgrades.

Hosted validation: `node --test --test-concurrency=1 .github/frameleaf-release.test.cjs .github/verify-release-bundle.test.cjs packaging/nas/build.test.cjs`. `TRUENAS_LIBRARY` enables actual catalog rendering. Tests retain negative signature, attestation, source-run, checksum, installer path, startup failure and retained-state cases. Fixture trust responses exercise release authentication; physical NAS and store submission behavior require separate evidence.

## Qualification and listing status

The [FL-199 record](https://heroit.atlassian.net/browse/FL-199), reviewed on 2026-10-06, contains no verified platform submission or published-listing receipt. Source completion and fixture validation do not establish platform certification or publication.

| Platform | Reviewable source                                                | Listing evidence recorded in FL-199                                     |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Synology | DSM SPK, wizard, Container Manager project and lifecycle scripts | Package Center submission and accepted listing unverified               |
| TrueNAS  | Community-train app source with pinned catalog-library renderer  | External catalog PR and accepted listing unverified                     |
| Unraid   | Server and optional ML Community Apps XML templates              | Community Apps Validate/Scan submission and accepted listing unverified |

Before submission, retain exact release/image digests and platform versions with receipts for fresh install, restart, upgrade, failed-upgrade recovery, uninstall with data retained, and backup restore. Qualify the supported offline import and recovery on sanitized production-shaped copies, including interrupted import/resume and content/access verification. Record the submission URL or ID and final listing URL separately for each platform after those gates pass.
