# Frameleaf NAS packages

`node packaging/nas/build.cjs RELEASE/nas-manifest.json OUTPUT` builds the DSM SPK, the TrueNAS Community app source, and the Unraid Community Apps XML templates from one certified Frameleaf release. It refuses to render a distributable package until `nas-manifest.json` names externally qualified Immich and prior Frameleaf migration sources. `release-manifest.json` and `nas-manifest.json` are release assets; keep both with the generated packages. Never replace a digest with `latest` or `release`.

The current repository's `server/src/fork-schema/supported-versions.json` has `externalProductionGate: required`, and that gate covers the fork handoff in the opposite direction. No Immich or older Frameleaf source is certified for NAS import. To lift the build gate, qualify the exact release on sanitized production-shaped source copies, record the source versions and evidence in `certified-sources.json` through a reviewed change, then rerun the exact-head release workflow. Do not edit the generated manifest or bypass `build.cjs`.

## Synology

DSM 7.2.1 or later with Container Manager 1432+ and a 64-bit x86 or ARM host is required. The SPK contains a Docker Project with server, PostgreSQL 14, Valkey and optional CPU ML. The wizard asks for pre-existing writable media/database directories, a web port, a generated database password, and ML choice. Data is outside the SPK target; uninstall leaves it in place. Upgrade requires confirmation of a consistent database and media backup. The SPK's `INFO`, resource worker, wizard, scripts, icons and Compose are in `synology/`. **Install lifecycle qualification is open:** the Docker Project worker reads Compose before `postinst`; confirm on DSM 7.2.1+ that `preinst` can write the persistent config before acquisition. Do not submit this SPK until that behavior and an upgrade are demonstrated on a supported model.

## TrueNAS

Copy the rendered `truenas/ix-dev/community/frameleaf` directory to a current fork of `truenas/apps`. Vendor the current matching library as directed by its contributor guide, run the catalog render and install tests, and submit a PR to the `community` train. The app uses independent media and PostgreSQL datasets, a dedicated internal network, optional ML, and a web portal. Keep the Frameleaf PostgreSQL 14 digest; the current upstream Immich catalog's PostgreSQL 18 image is not a compatible shortcut for this package.

## Unraid

The generated XML files belong on a versioned `nas-catalog` branch of `Frameleaf/frameleaf-app`, with `ca_profile.xml`. Create a user-defined `frameleaf` Docker network. Install compatible PostgreSQL 14 and Valkey containers on that network using the manifest's pinned images, then install Frameleaf Server and optionally Frameleaf Machine Learning. Use separate persistent paths for `/data`, PostgreSQL data, and ML cache; enter the same generated database password in both containers. Only port 2283 needs a host mapping. Validate and scan the repository in the Community Apps submission portal after publishing the XML. Digest pins mean an update requires a new reviewed catalog commit.

## Migration and rollback

Migration is opt-in and only from versions in the release manifest's explicit allowlist. The first intended Immich source is exact v3.1.0 after external production-shaped qualification; later Frameleaf sources require their own recorded compatibility result. Refuse all other source versions, PostgreSQL major versions, schema ledgers, or extension sets until tested; direct PostgreSQL 18 to 14 volume reuse is forbidden.

1. Record the source version, image digest, PostgreSQL version/extensions and migration ledger; verify the source is in the target release allowlist. Record all media roots, external libraries, database paths, users and permissions. Estimate target free space before copying.
2. Enter source maintenance mode and stop API, microservices, ML and background workers. Create mutually consistent, immutable PostgreSQL and media checkpoints; verify the backup file and snapshot IDs and test restore on a disposable clone. Keep the source stopped until the target is accepted.
3. Restore the database into a fresh PostgreSQL 14 target. Copy or snapshot media into the target's `/data` path, preserving bytes and ownership. Never start a second application stack against the same live database directory. Preserve the old stack and both checkpoints.
4. Start the target at the pinned version, with one server instance for migrations. Verify authenticated login, user and asset counts, sample original and derivative checksums, albums/permissions, background jobs and ML. Record exact source/target digests and results. For a large library, compare full media manifests and database table counts before acceptance.
5. If anything fails, stop the target and restore **both** PostgreSQL and media from the same pre-migration checkpoint. Do not downgrade the new database in place or replay only one side of the backup pair. Resume the source only after its original state is verified.

The packager and local fixtures validate structure, not platform behavior or a customer's installation. Release qualification requires real Synology, TrueNAS and Unraid install, restart, update, failed update, retained-data uninstall, restore, and sanitized production-shaped migration/rollback runs. Submit listings only after those receipts are reviewed.
