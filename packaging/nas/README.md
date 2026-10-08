# Frameleaf NAS distribution

The Manager installation path uses `node packaging/nas/build-manager.cjs
MANAGER_MANIFEST OUTPUT`. It authenticates the independently published Manager
component, exact successful two-architecture build, immutable image digest and
signed release predicate before writing the Unraid Manager template or TrueNAS
Custom App Compose file. Install via TrueNAS's supported **Install via YAML**
flow. Set the exact HTTPS origin and persistent host folders first; keep host
and container paths identical. Map additional source media/database folders
before import. Manager has Docker socket access to coordinate its library.
For an Unraid import, fill the autostart file field with the existing
`unraid-autostart` file beneath the exact `DockerRootDir` returned by
`docker info --format '{{.DockerRootDir}}'`, and set **Autostart controller path**
to `/run/frameleaf-host/unraid-autostart`. Leave both fields blank when no file
is mounted. Its writable mount lets Manager
preserve other entries while preventing the source from starting during import.

The older direct-stack catalog builder below is retained for existing release
compatibility. New NAS installations use the Manager artifacts. No Manager
digest is invented when publication is unavailable.

`node packaging/nas/build.cjs RELEASE frameleaf-vX.Y.Z-N OUTPUT` builds TrueNAS Community app source and Unraid XML templates from one Frameleaf release. Before writing output it verifies version 3 release and NAS manifests, SHA256SUMS, asset hashes, all application image signatures, exact release attestations using committed `cosign.pub`, and the successful source build run. Install Cosign and server workspace dependencies; use `GITHUB_TOKEN` for authenticated reads when needed. Keep both manifests with packages and preserve digest references.

These packages create a fresh canonical Frameleaf database on PostgreSQL 19 beta 4 with pgvector 0.8.7 and HNSW. Mount the database directory at `/var/lib/postgresql`; PostgreSQL writes its versioned data beneath it. An offline, read-only Immich 3.x export through stable 3.2.4 is a separate one-time import source. Never reuse an older PostgreSQL volume as the canonical database.

Follow the [offline import procedure](../../docs/docs/administration/import-immich.md) for source-version and read-only-role preflight, independent media copies, interruption/resume and verification before activation. Retain the stopped source database and media as the import recovery point. For an existing canonical Frameleaf installation, preserve a matched database, media, configuration and encryption-key backup before upgrading; [restore that recovery point with its matching release](../../docs/docs/administration/backup-and-restore.md) if recovery is needed. Downgrading an image against an upgraded schema is not rollback. Rehearse imports and recovery only on disposable copies.

All DSM/Synology package source, SPK builds, native UI and package releases now
belong in the private `Frameleaf/frameleaf-synology` repository. The approved
interactive prototype lives there. This public repository must not produce DSM
packages. Historical direct-stack packaging was moved with its original license;
the original native DSM application is a separate commercial product. See
[AGENTS.md](../../AGENTS.md) for the standing ownership rule.

Copy the rendered `truenas/ix-dev/community/frameleaf` directory into the TrueNAS apps catalog and use its matching pinned `base_v2_3_4` library. The app maintains independent media and PostgreSQL datasets, an internal network and optional ML. The renderer checks the library's committed hash before import, rejects symlinks and disables bytecode writes. `requirements-render.lock` pins the hosted Linux CPython 3.11.15 renderer dependencies with hashes. Run the real library render in hosted CI in both ML modes.

Unraid templates use an external PostgreSQL container with the digest in `nas-manifest.json`; configure it on the same network as the server. Configure media storage, database credentials and optional ML according to the templates. Database backups and media originals must be retained before upgrades.

Hosted validation: `node --test --test-concurrency=1 .github/frameleaf-release.test.cjs .github/verify-release-bundle.test.cjs packaging/nas/build.test.cjs`. `TRUENAS_LIBRARY` enables actual catalog rendering. Tests retain negative signature, attestation, source-run, checksum, TrueNAS and Unraid rendering cases; Synology installer/lifecycle tests moved with their source to the private repository. Fixture trust responses exercise release authentication; physical NAS and store submission behavior require separate evidence.

## Qualification and listing status

The [FL-199 record](https://heroit.atlassian.net/browse/FL-199), reviewed on 2026-10-06, contains no verified platform submission or published-listing receipt. Source completion and fixture validation do not establish platform certification or publication.

| Platform | Reviewable source                                                   | Listing evidence recorded in FL-199                                     |
| -------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Synology | Source and releases owned by private `Frameleaf/frameleaf-synology` | Package Center submission and accepted listing unverified               |
| TrueNAS  | Community-train app source with pinned catalog-library renderer     | External catalog PR and accepted listing unverified                     |
| Unraid   | Server and optional ML Community Apps XML templates                 | Community Apps Validate/Scan submission and accepted listing unverified |

Before submission, retain exact release/image digests and platform versions with receipts for fresh install, restart, upgrade, failed-upgrade recovery, uninstall with data retained, and backup restore. Qualify the supported offline import and recovery on sanitized production-shaped copies, including interrupted import/resume and content/access verification. Record the submission URL or ID and final listing URL separately for each platform after those gates pass.

Manager component releases include `frameleaf-manager.xml` and `frameleaf-manager.compose.yaml`.
Their exact SHA256 digests, image, tag and source commit are part of the signed Manager predicate.
After downloading the manifest and both installers into a directory, verify the authenticated bytes
with `node .github/verify-manager-installers.cjs manager-manifest.json <directory>` before installation.
`SHA256SUMS` alone does not authenticate an installer. The catalog builder also refuses templates
that differ from the authenticated binding, before creating its output directory.
Older signed Manager manifests remain usable for image-based packaging, but lack authenticated
installer-byte qualification; the downloaded-installer checker refuses those manifests.
