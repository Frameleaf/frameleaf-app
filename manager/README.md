# Frameleaf Manager

Manager installs one Frameleaf stack using the host Docker engine. Its own administrator account and HTTPS endpoint remain available when the photo application is stopped. Only Manager receives the Docker socket. The application, PostgreSQL, Valkey and optional machine learning run as sibling containers.

## PostgreSQL storage

PostgreSQL uses a **bind mount to a new directory on the host disk**. It never uses a Docker named volume or the container writable layer. Each installation, restoration or interrupted database import attempt gets a separate `frameleaf-<installation>-postgres-<unique suffix>` directory. Manager retains earlier directories for recovery and never attaches Frameleaf PostgreSQL to Immich's original data directory.

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

## Backup scope

Manager backs up the database and recovery configuration, including required secrets, in an encrypted Restic repository. It does **not** back up photos, videos or external libraries. Import reuses a verified Immich database recovery backup no more than 24 hours old and skips creating another recovery backup. Import still takes a current logical copy after Immich's writers stop; an older recovery backup is not used as the live import database.

Reuse requires a native timestamped backup from the selected source's backup folder, a complete gzip/SQL stream, and the source library's original administrator identity in that SQL. File modification time alone is insufficient. Unrecognized, incomplete, stale or mismatched backups cause Manager to create a recovery checkpoint. This format and identity check is separate from the real restore qualification required for a release.

Keep original library locations available when restoring. A database backup cannot undo media changes made after Frameleaf starts. Manager must not automatically restart Immich against media Frameleaf has modified.

## Recovery of PostgreSQL and Manager

Stop application writers before manual recovery. Preserve the current database directory, the source Immich database and the Manager state folder. Never restore by changing a PostgreSQL image version against an existing physical data directory.

For a logical restore, choose an empty Manager installation, unlock the backup repository with the exported recovery key, select the snapshot and review its preserved library mappings. Select the PostgreSQL appdata folder for this host. Manager allocates a new empty subdirectory there and restores the logical database dump. Paths saved in backup metadata do not authorize reusing an old PostgreSQL directory.

For Manager replacement, retain its state folder, exact bind mappings, HTTPS origin and recovery key. Stop the old Manager container, then launch the verified replacement image with those same mappings. The persisted operation journal marks unfinished work as interrupted. Resume only after reviewing the recorded step. An ambiguous database restore keeps its prior target directory and allocates another empty target before retrying.

Import, restore, update, backup and lifecycle operations all have a retry action. A failed database backup can be cancelled without stopping Frameleaf. If an update fails before applying its release, cancellation restarts the prior release. Once release application may have changed the database or media, retry moves forward on that release; Manager does not attempt an image-only downgrade. Restore refuses media paths used by another running or automatically restarting application. Recovery retains the imported media-location environment and file settings while generating fresh target database credentials.

If Manager cannot start, its private `stack/compose.json` can be used with the host's Compose v2 command and its recorded project name. The protected configuration export includes that project identity and the database host path. Store exports privately: they contain recovery secrets. A database-only export is not a media recovery checkpoint.

## Validation and distribution status

This workspace is under development. The Manager workflow builds and tests both Linux architectures without publishing. A green container authentication or storage test is not evidence of a qualified Immich migration, physical Unraid acceptance, or native mobile setup. Production import requires a signed release bundle and migration qualification receipts for the exact source version and PostgreSQL extensions. No floating application image fallback is provided.

Sources: [Unraid Docker settings](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/DockerSettings.page), [Unraid template appdata defaults](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/CreateDocker.php), [Unraid Docker recovery](https://docs.unraid.net/unraid-os/troubleshooting/common-issues/docker-troubleshooting/).
