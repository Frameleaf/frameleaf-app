# Frameleaf Manager

Manager installs one Frameleaf stack using the host Docker engine. Its own administrator account and HTTPS endpoint remain available when the photo application is stopped. Only Manager receives the Docker socket. The application, PostgreSQL and optional machine learning run as sibling containers.

## PostgreSQL storage

PostgreSQL uses a **bind mount to a new directory on the host disk**. It never uses a Docker named volume or the container writable layer. Each installation or logical restoration gets a separate `frameleaf-<installation>-postgres-<unique suffix>` directory. Manager retains earlier directories for recovery and never attaches Frameleaf PostgreSQL to Immich's original data directory.

On Unraid, the launcher detects `DOCKER_APP_CONFIG_PATH` from the environment or `/boot/config/docker.cfg`. This is Unraid's **Settings → Docker → Default appdata storage location**, commonly `/mnt/user/appdata/`. A custom share or pool is honored. An exclusive share is resolved to its actual host location; Manager does not assume a pool named `cache`. The setup and restore screens show the detected default and let the administrator choose another mounted folder.

The folder must be outside Docker's data root and backed by a supported disk filesystem (ext4, XFS, Btrfs, ZFS, or Unraid's host share filesystem). Loop-mounted image files, the container overlay, RAM disks, Docker volumes and network filesystems are refused. Manager checks the actual Docker bind mapping, kernel mount table, permissions and available space before allocating PostgreSQL storage. A missing folder is an error; Compose cannot silently create it in the wrong place.

## Launcher

Use `launch.sh`, `cosign.pub` and a Manager image digest from a verified release. The launcher requires Docker, Compose v2, Cosign, `findmnt` and `realpath` on a Linux host. Create the state, library, backup and appdata folders on the intended storage first.

```sh
sh launch.sh "$VERIFIED_MANAGER_IMAGE" "$STATE_FOLDER" "$LIBRARY_FOLDER" \
  "$DATABASE_BACKUP_FOLDER" "https://server.example:9443" auto "$LAN_ADDRESS"
```

`auto` detects Unraid's configured appdata location. On other Linux hosts, pass the desired appdata folder instead of `auto`. An explicit folder overrides the detected default. The launcher binds that folder into Manager at the same absolute host path and passes it as `MANAGER_DATABASE_ROOTS`. To offer more disks in the wizard, bind each approved folder at its identical host path and add it to this colon-separated environment variable. Do not mount the whole host filesystem to make a path picker work.

The launcher mounts `/proc/1/mountinfo` read only so Manager can compare the host filesystem identities of appdata and Docker storage, including bind aliases. It also mounts Unraid's Docker configuration read only and, when present, its exact autostart file for source cutover. It never sources the configuration as shell code. The first administrator must enter the private claim key from the Manager state folder.

## Import authority

Manager owns media mappings and service lifecycle. It preserves the reviewed bind paths or named volumes, destinations and access modes. The offline import container mounts those same locations read-only; ordinary Frameleaf access begins only after canonical import verification and source fencing succeed. It neither copies nor relocates media.

Manager creates a dedicated read-only database role on the stopped source, with only connection/schema/read/control-identity grants, and disables its login before application cutover. Source tables and their contents remain intact. The frozen reader pins Manager operation/deployment identity, mount mappings and media hashes to its durable journal. Interrupted imports resume that journal; an abandoned destination requires a fresh installation. A surviving import container blocks a duplicate runner until it stops.

Verified offline import prepares a durable regeneration run for metadata, thumbnails, search and face data, including person thumbnails. The first Manager setup releases it once the photo application has an administrator and its processing settings are ready. Manager shows progress and work that needs attention while processing continues in the background. Finishing setup does not mark regeneration complete. Restarts reuse the same run and saved progress rather than creating another run; failed or cancelled work is not automatically retried. Standalone CLI imports do not wait for Manager setup.

## Backup scope

Manager backs up the database and recovery configuration, including required secrets, in an encrypted Restic repository. It does **not** back up photos, videos or external libraries. Import reuses a verified Immich database recovery backup no more than 24 hours old and skips creating another recovery backup. Import still takes a current logical dump after Immich's writers stop. The frozen reader then imports the stopped source into the fresh canonical database; an older recovery backup is never used as the live import database.

Reuse requires a native timestamped backup from the selected source's backup folder, a complete gzip/SQL stream, and the source library's original administrator identity in that SQL. File modification time alone is insufficient. Unrecognized, incomplete, stale or mismatched backups cause Manager to create a recovery checkpoint. This format and identity check is separate from the frozen one-time importer preflight.

Keep original library locations available when restoring. A database backup cannot undo media changes made after Frameleaf starts. Manager must not automatically restart Immich against media Frameleaf has modified.

## Recovery of PostgreSQL and Manager

Stop application writers before manual recovery. Preserve the current database directory, the source Immich database and the Manager state folder. Never restore by changing a PostgreSQL image version against an existing physical data directory.

Manager lists only snapshots tagged `frameleaf-canonical` for ordinary restore. Source Immich checkpoints are tagged `immich-source` and cannot be restored into a canonical Frameleaf database. Snapshots with unknown or missing format metadata are refused.

For manual source recovery, an administrator can use standard Restic with the exported recovery key: save the key in a private password file, list snapshots using `restic --repo <repository> --password-file <key-file> snapshots --tag frameleaf-manager-database,immich-source`, then restore the selected snapshot to an empty directory using `restic --repo <repository> --password-file <key-file> restore <snapshot-id> --target <empty-directory> --verify`. The recovered dump is for source Immich recovery using its matching database software; it is not a canonical Frameleaf restore. Keep the recovered configuration and key private.

For a logical restore, unlock the backup repository with the exported recovery key, select the snapshot and review its preserved library mappings. Select the PostgreSQL appdata folder for this host. Manager allocates a new empty subdirectory there and restores the logical database dump. Paths saved in backup metadata do not authorize reusing an old PostgreSQL directory.

An installed library can restore a snapshot from its own recorded library lineage with identical media mappings. The review pins the current installation. Manager disables its containers' automatic restart, removes their exact Unraid autostart entries, stops them, and archives their stack configuration and credentials before allocating the replacement database. The old database directory remains intact. A resumed restore verifies that the predecessor is still fenced before starting workers. Cancelling before replacement workers may have written media restores the previous configuration and leaves its services stopped for an explicit start. Once replacement workers may have written media, automatic cancellation is refused. Older backups without provable lineage cannot replace an unrelated installation.

Canonical recovery retains the imported regeneration run and its recorded original lineage, including a run still waiting for first setup. Once the restored application has an administrator and valid processing settings, setup can release that same prepared run. Missing or mismatched import lineage requires attention; recovery does not invent a replacement run or automatically replay unsafe external work.

For Manager replacement, retain its state folder, exact bind mappings, HTTPS origin and recovery key. Stop the old Manager container, then launch the verified replacement image with those same mappings. The persisted operation journal marks unfinished work as interrupted. Resume only after reviewing the recorded step. An ambiguous database restore keeps its prior target directory and allocates another empty target before retrying.

Import, restore, update, backup and lifecycle operations all have a retry action. A failed database backup can be cancelled without stopping Frameleaf. If an update fails before applying its release, cancellation restarts the prior release. Once release application may have changed the database or media, retry moves forward on that release; Manager does not attempt an image-only downgrade. Restore refuses media paths used by another running or automatically restarting application. Recovery retains the imported media-location environment and file settings while generating fresh target database credentials.

If Manager cannot start, its private `stack/compose.json` can be used with the host's Compose v2 command and its recorded project name. The protected configuration export includes that project identity and the database host path. Store exports privately: they contain recovery secrets. A database-only export is not a media recovery checkpoint.

## Validation and distribution status

The live Svelte interface follows `design/frameleaf-manager/`: setup and import review, overview, service controls and sanitized logs, mounted storage, encrypted database checkpoints and restore, eligible updates, operation history, and Manager settings. The local administrator can change name/password, revoke previous sessions, export the existing recovery key, and download a protected recovery configuration. Each credential change or secret export requires fresh password proof. Capacity and library counts come from the mounted filesystem and the managed database; unavailable data is shown explicitly.

Post-install setup saves the administrator's optional profile locally, opens the existing secure Frameleaf account flow when requested, and presents official app QR links. Library and phone readiness come from the authenticated server setup projection. Finish remains unavailable until the server reports the final catalog and browsing previews acknowledged. Prototype verification codes and simulated phone progress are not used by the live application.

Run `npm run build --prefix manager` followed by `node manager/test/ui-browser.mjs` after installing its Chromium browser with `npx --prefix manager playwright install chromium`. Browser checks use explicit API fixtures for navigation and interaction coverage; `manager/test/container.mjs` separately exercises real HTTPS, claim/session persistence, CSRF, storage, protected key export and credential rotation. Neither substitutes for actual library or physical-platform qualification.

This workspace is under development. Pull-request Manager jobs build and test both Linux architectures without publishing. Manual publication uses the exact current head of an allowed delivery branch, including the dedicated `aj/frameleaf-manager-release` branch for independently reviewed Manager releases. That branch does not trigger application image publication or merge PR #140. The `production` environment retains its reviewer and signing requirements and must explicitly allow the selected branch. Dispatch `.github/workflows/manager.yml` with `publish=true` and the `manager-vX.Y.Z` tag matching `manager/package.json`. Both native architecture jobs, real PostgreSQL/Restic recovery, OCI byte binding, signatures and provenance must pass before the versioned component manifest and GitHub/image `latest` aliases are published. NAS packages consume the authenticated manifest and immutable digest.

A green container authentication or storage test is not evidence of a qualified Immich migration, physical Unraid acceptance, or native mobile setup. Production import requires a signed v3 release bundle and a source accepted by the frozen one-time importer preflight. Release build provenance does not claim migration qualification. Manager uses a fresh PostgreSQL 19 host directory mounted at `/var/lib/postgresql`; SQL-backed queues do not require Redis or Valkey. No floating application image fallback is provided.

Sources: [Unraid Docker settings](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/DockerSettings.page), [Unraid template appdata defaults](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/CreateDocker.php), [Unraid Docker recovery](https://docs.unraid.net/unraid-os/troubleshooting/common-issues/docker-troubleshooting/).
