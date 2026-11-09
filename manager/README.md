# Frameleaf Manager

Manager installs one Frameleaf stack using the host Docker engine. Its own administrator account and management endpoint remain available when the photo application is stopped. Only Manager receives the Docker socket. The application, PostgreSQL and optional machine learning run as sibling containers.

## PostgreSQL storage

PostgreSQL uses a **bind mount to a new directory on the host disk**. It never uses a Docker named volume or the container writable layer. Each installation or logical restoration gets a separate `frameleaf-<installation>-postgres-<unique suffix>` directory. Manager retains earlier directories for recovery and never attaches Frameleaf PostgreSQL to Immich's original data directory.

On Unraid, the launcher detects `DOCKER_APP_CONFIG_PATH` from the environment or `/boot/config/docker.cfg`. This is Unraid's **Settings → Docker → Default appdata storage location**, commonly `/mnt/user/appdata/`. A custom share or pool is honored. An exclusive share is resolved to its actual host location; Manager does not assume a pool named `cache`. The setup and restore screens show the detected default and let the administrator choose another mounted folder.

The folder must be outside Docker's data root and backed by a supported disk filesystem (ext4, XFS, Btrfs, ZFS, or Unraid's host share filesystem). Loop-mounted image files, the container overlay, RAM disks, Docker volumes and network filesystems are refused. Manager checks the actual Docker bind mapping, kernel mount table, permissions and available space before allocating PostgreSQL storage. A missing folder is an error; Compose cannot silently create it in the wrong place.

## Launcher

Use `launch.sh`, `cosign.pub` and `ghcr.io/frameleaf/frameleaf-manager:latest`; the launcher verifies the pulled image's signature before starting it. The launcher requires Docker, Compose v2, Cosign, `findmnt` and `realpath` on a Linux host.

The shortest launch needs no folders made first. Give the address you will open Manager at, and optionally a parent folder (default `/srv/frameleaf`, at least two levels deep). Manager keeps its settings in `manager` inside it, and you choose and create the other folders during setup. If you mount a drive inside that folder later, restart Manager so it can see the drive:

```sh
sh launch.sh ghcr.io/frameleaf/frameleaf-manager:latest "https://server.example:2282" "$FOLDER_ROOT" "$LAN_ADDRESS"
```

To let Manager use more drives, for example the database or thumbnails on an SSD, list a folder on each one in `MANAGER_EXTRA_FOLDERS`, separated by colons. Each folder must already exist, be at least two levels deep, and not sit inside the parent folder or another extra folder. The launcher maps each one at its own path and never creates it, so a drive that isn't mounted stops the launch. In setup, the folder picker then starts with a list of these folders, and you choose and create folders inside any of them:

```sh
MANAGER_EXTRA_FOLDERS=/media/ssd/frameleaf:/media/disk2/frameleaf \
  sh launch.sh ghcr.io/frameleaf/frameleaf-manager:latest "https://server.example:2282" "$FOLDER_ROOT" "$LAN_ADDRESS"
```

Without `MANAGER_EXTRA_FOLDERS`, the launch maps only the parent folder, as before. Extra drives work only with this short form; the long form below names every folder itself.

Without `$LAN_ADDRESS`, Manager listens only on this machine (`127.0.0.1`). Give the server's LAN address to open it from another device, unless a reverse proxy on this machine serves it.

To name every folder yourself, use the long form, and create the state, library, backup and appdata folders on the intended storage first. It is also what an existing launch keeps using:

```sh
sh launch.sh ghcr.io/frameleaf/frameleaf-manager:latest "$STATE_FOLDER" "$LIBRARY_FOLDER" \
  "$DATABASE_BACKUP_FOLDER" "https://server.example:2282" auto "$LAN_ADDRESS"
```

`auto` detects Unraid's configured appdata location. On other Linux hosts, pass the desired appdata folder instead of `auto`. An explicit folder overrides the detected default. The launcher binds that folder into Manager at the same absolute host path and passes it as `MANAGER_DATABASE_ROOTS`. To offer more disks in the wizard, map each approved folder into the container and add its container path to this colon-separated environment variable. Host and container paths may differ; Manager translates them when it talks to Docker. Do not mount the whole host filesystem to make a path picker work.

The launcher mounts `/proc/1/mountinfo` read only so Manager can compare the host filesystem identities of appdata and Docker storage, including bind aliases. It also mounts Unraid's Docker configuration read only and, when present, its exact autostart file for source cutover. Without an explicit autostart mount, Manager automatically discovers Docker's data root and accesses the existing list through an isolated helper using its exact running image; no manual container edit is needed. It never sources the configuration as shell code. The first administrator is created from the home network while Manager has no administrator; no claim key is needed.

When machine learning is on, Manager picks the hardware variant on amd64 hosts: CUDA when Docker has the `nvidia` runtime, ROCm for an AMD render node with `/sys/class/kfd`, OpenVINO for an Intel render node, otherwise CPU. It reads the host's read-only sysfs, so Manager itself needs no `/dev` mappings; the device passthrough from `docker/hwaccel.ml.yml` goes on the machine learning container only. Set `MANAGER_ML_ACCELERATION` to `cpu`, `cuda`, `rocm` or `openvino` to override detection. The setup screen names the detected GPU and turns machine learning on by default when one is found.

### Several installations on one host

Each Frameleaf installation has its own Manager. To add another, run the launcher again with a different container name and Manager port, and with its own state, media and backup folders. The appdata folder can be shared, because each installation gets its own PostgreSQL directory inside it.

```sh
MANAGER_NAME=frameleaf-manager-family MANAGER_PORT=2284 sh launch.sh ghcr.io/frameleaf/frameleaf-manager:latest \
  "$STATE_FOLDER_2" "$LIBRARY_FOLDER_2" "$DATABASE_BACKUP_FOLDER_2" "https://server.example:2284" auto "$LAN_ADDRESS"
```

The launcher refuses a state or backup folder that another container already uses. Manager refuses media folders that another installation writes to, and photo app ports that are already published. On Unraid, add the Manager template again with a new name, port and folders. On TrueNAS, install the YAML again as a separate app with its own port and folders.

## Advanced container settings

Setup's **Advanced container settings** let a home-lab administrator add, per container (`frameleaf-server`, `frameleaf-machine-learning`, `database`), environment variables, extra bind-mounted folders (`/host:/container[:ro]`) and a memory or CPU limit. They are checked when the configuration is reviewed, written into the generated Compose stack, and stored with the application configuration so updates, restores and library moves keep them. Manager's own wiring stays out of reach: `DB_*`, `POSTGRES_*`, `FRAMELEAF_MANAGER_*`, `IMMICH_CONFIG_FILE` and `IMMICH_MEDIA_LOCATION` are refused, as is any folder under `/run/frameleaf`, `/var/lib/postgresql`, `/cache` or an existing media target. Host paths that would hand the network-exposed server the host are refused as sources whatever the request says: `/`, `/etc`, `/proc`, `/sys`, `/dev`, `/root`, `/boot`, `/run`, `/var/run` (the Docker socket), `/var/lib/docker` and Manager's own state folder. Every other source must lie under one of Manager's media roots, database roots or `MANAGER_MOUNT_ROOTS`, a colon-separated allow-list of further host folders the administrator has mapped into Manager at identical paths. Extra folders are mounted with `create_host_path: false`; a missing host folder fails the install rather than being created somewhere unexpected. Settings for machine learning wait until it is turned on.

On an installed server the same card sits on the **Services** screen, pre-filled from the stored configuration (`GET manager-api/container-settings`). Saving (`POST manager-api/container-settings`) runs the same checks against the installation's real media mounts, then starts a journaled `reconfigure` operation: the previous settings are recorded first, the stack is re-rendered and stored, and `compose up` recreates only the containers whose definition changed. A failed apply can be resumed, or cancelled back to the recorded previous settings; like every operation it is refused while another one is running.

## Import authority

Manager owns media mappings and service lifecycle. It preserves the reviewed bind paths or named volumes, destinations and access modes. The offline import container mounts those same locations read-only; ordinary Frameleaf access begins only after canonical import verification and source fencing succeed. It neither copies nor relocates media.

Manager creates a dedicated read-only database role on the stopped source, with only connection/schema/read/control-identity grants, and disables its login before application cutover. Source tables and their contents remain intact. The frozen reader pins Manager operation/deployment identity, mount mappings and media hashes to its durable journal. Interrupted imports resume that journal; an abandoned destination requires a fresh installation. A surviving import container blocks a duplicate runner until it stops.

Verified offline import prepares a durable regeneration run for metadata, thumbnails, search and face data, including person thumbnails. The first Manager setup releases it once the photo application has an administrator and its processing settings are ready. Manager shows progress and work that needs attention while processing continues in the background. Finishing setup does not mark regeneration complete. Restarts reuse the same run and saved progress rather than creating another run; failed or cancelled work is not automatically retried. Standalone CLI imports do not wait for Manager setup.

## Moving media to another drive

Before stopping anything, Manager pauses the server (FL-360): new uploads and
other changes are refused with 503, every job queue is paused, and Manager waits
until no write request or job is still running (up to 30 minutes; otherwise it
resumes the server and stops nothing). The pause is stored by the server, so it
survives the move's own restart and a crash; Manager resumes it after the move,
after a failed check and after recovery. If Manager never comes back, the pause
lifts itself 30 minutes after the server starts (2 hours while it runs without a
renewal); an administrator can also lift it with `POST /api/admin/library-move/resume`.
A server without this pause keeps the Move button unavailable. Real-NAS, ACL and
power-loss qualification is still outstanding.

Under **Storage**, choose **Move photos to a bigger drive**, select an explicitly
mounted destination and check it before starting. Manager supports one writable
bind-mounted media folder; named volumes, external/read-only mappings, symlinks,
hard links, special files and nested filesystems require a separate move plan.
PostgreSQL, Manager state and database backups remain in their original locations.

### Thumbnails on a separate drive

A library can keep its thumbnails in a folder of their own, usually on a faster
drive. That folder is a second bind mount at `/data/thumbs`, listed straight
after the photos mount at `/data` in the installation's mounts, so the server's
paths and database records stay the same. Moving the library moves only the
photos folder; the thumbnail mount and its drive are kept as they are. Before
every start, update, rollback, restore and move, Manager checks that each
mounted folder is there and names a missing one (`thumbnail_folder_missing`,
`media_folder_missing`) instead of letting Docker refuse the whole stack. The
server still refuses to start when a folder it has checked before loses its
`.frameleaf` marker, which protects against a drive that is not mounted.

A restore keeps thumbnails where they are now, so a backup taken before they
moved still belongs to the same library. If their folder is gone, the restore
review offers to keep them in the photos folder's own `thumbs` folder instead;
Manager then seeds the marker there before starting, and missing thumbnails can
be made again.

**Moving thumbnails** (FL-1323) reuses Library Move below for the thumbnails
folder (the photos folder's own `thumbs`, or the thumbnail mount):
`POST /manager-api/review-thumbnail-move` with `{ root }` measures the real file
count and size with the copy helper, and `POST /manager-api/move-thumbnails`
with `{ id, key }` starts a `move-thumbnails` operation. It pauses the server,
keeps the stack's `compose.json` to return to (no database recovery point: the
database is not touched), copies into a new `frameleaf-<id>-thumbnails-<op>`
folder, verifies it, and then switches only the thumbnail mount (`withThumbnails`).
The photos mount is never changed. Stop safely and Cancel safely work as for a
library move: until Frameleaf starts on the new folder, an interrupted move goes
back to the original folder. The original thumbnails are kept, and
`retained-thumbnails:<op>` records them.

**A missing thumbnail drive** is reported by `GET /manager-api/storage-usage`
(`thumbnails.missing`). Plug the drive back in and check again, or put the
thumbnails back with the photos: `POST /manager-api/review-thumbnails-home`,
then `POST /manager-api/thumbnails-home` with `{ id, key }`. The
`thumbnails-home` operation removes the thumbnail mount, creates the photos
folder's own `thumbs` folder with the server's marker (nothing else in the
photos folder is touched), starts Frameleaf, and asks the server to queue every
thumbnail to be made again (`POST /api/server/library-move/manager/thumbnails`).
It only goes forward: Resume finishes it, and cancelling is refused. A thumbnail
folder Manager can't see (one only Docker reaches) is never treated as missing
(`thumbnail_folder_not_visible`), and a drive that comes back before the switch
ends the operation with nothing changed (`thumbnail_folder_present`).

`GET /manager-api/storage-usage` also gives the Storage page each place's size
(photos from the accounts' storage use, the database from PostgreSQL, thumbnails
from a background walk of their folder) and the fast drive Manager suggests for
the database (while it is on a slow drive) and for thumbnails (while they are
with the photos). The database has first claim on a fast drive both would use.

Manager stops and fences managed writers, saves a verified database recovery point,
copies into a new folder and independently compares the complete file inventory,
SHA-256 checksums, POSIX metadata, ACLs and extended attributes. Its isolated copy helper uses the exact local
Manager image with no network access. The reviewed host mount identities and actual
application bind mapping must still match before the library is made available.
Failures retain the operation lock, original files and any partial destination.

**Stop safely** requests cancellation before the new stack is started. When the
helper has exited, **Cancel safely** returns to the original mapping. Interrupted
operations can resume their durable steps. A folder created without a completed
ownership receipt is retained and refused; cancel and start a fresh move instead
of adopting or deleting it.

The original copy is retained after a successful move and shown under Storage.
Once the new stack may have accepted writes, returning to the old copy is refused:
use another verified move or a complete restore. Manager never deletes the old
copy automatically. Keep an independent media backup: Manager's database recovery
point contains no photos or videos. Moving to a different server remains a complete
backup/restore operation, not a database-only restore described as a library move.

The app's Storage page opens the deployment-configured HTTP or HTTPS Manager origin and
requires a separate Manager sign-in. A standalone server keeps the advanced
migration checklist. Existing installations acquire the link when their Compose
configuration is regenerated with the updated Manager. Configuration alone does
not prove Manager is reachable. Real NAS disk/ACL and installed-release qualification
is required before treating this source feature as an accepted deployment.

For home-lab HTTP access, set the container’s `MANAGER_ORIGIN` to the exact browser
address, such as `http://tower.local:2282`, and map that host port to container port
9443. With `manager/launch.sh`, pass that address as the fifth argument; the launcher
does not use `MANAGER_ORIGIN` from its environment. This serves HTTP directly.
Changing `MANAGER_ORIGIN` later (a new hostname, port or scheme) is safe: Manager starts,
logs the change and revokes every paired desktop device, because their signed requests
were bound to the old origin. Pair the desktop app again; browser sessions are unaffected.
HTTP uses an explicit session header instead of a cookie, so other services on
the same host do not receive Manager credentials. The browser holds this session
only in memory; reloading the page requires sign-in. HTTP sends
passwords and management traffic without encryption; use a trusted network.
HTTPS origins retain certificate validation and Secure cookies. Leaving the origin
unset retains the existing local HTTPS listener and HTTP-to-HTTPS redirect.
The desktop-owned native Manager continues to use its private loopback TLS identity.

### Network placement and proxies

The first administrator can only be created from a home-network address while Manager is
unclaimed. A connection that arrives from the container's own gateway (for example
`172.17.0.1`) came through Docker's userland proxy, NAT or a reverse proxy, so its real
origin is unknown; Manager refuses such a claim (`claim_proxied_address_unverified`) and
logs why, unless one of these says who the client is:

- `MANAGER_TRUSTED_PROXIES`: comma-separated addresses or CIDR prefixes of proxies whose
  `X-Forwarded-For` header Manager trusts (for example `172.17.0.1` or `10.0.0.0/8`). The
  rightmost address in the header that no trusted proxy added is the client; it is used for
  the home-network check and for per-client rate limits. Without this setting the header is
  ignored.
- Publishing Manager's port on `127.0.0.1` only (the launcher's default `LAN_ADDRESS`, so
  `MANAGER_BIND_ADDRESS` is loopback): then the gateway can only carry this host's own
  browser, and it counts as home. A reverse proxy running on the host is also "this host":
  a loopback-only publish does not stop remote access through a proxy that is not declared
  in `MANAGER_TRUSTED_PROXIES`, so declare the proxy (then the client address is validated)
  or complete the initial claim before exposing Manager through it.

Publish Manager directly on a LAN address whenever possible; rootless Docker and NAS portal
proxies make every client look like the gateway.

## State retention

Manager's state folder (`MANAGER_DATA`) holds, per operation, the plaintext database dump and
the recovery record that it snapshots into the encrypted Restic repository, the copy of a
stopped Immich database taken for an import, a restored snapshot for every restore review and
the verified release bundle of every review. Once an operation has settled (completed, or
cancelled after a failure) Manager deletes its `checkpoints/<operation>/database.dump` and
`recovery.json` (the `compose.json` beside them stays), its `imports/<operation>.dump`, the
`restore-<review>` and `media-moves/<review>` folders of spent or expired reviews, and all but
the three most recent release bundles that no open review points at. The sweep runs when
Manager starts and after every operation; an operation that failed keeps everything it may
need to resume. The database password lives in `manager.sqlite` and in the 0600
`stack/database-password` file the containers read; it is no longer placed in container
environment variables, so DockerMan templates, `docker inspect` and the compose text carry only
the file path. The recovery export (`POST manager-api/export`) includes it explicitly.

## Backup scope

Manager backs up the database and recovery configuration, including required secrets, in an encrypted Restic repository. It does **not** back up photos, videos or external libraries. Import reuses a verified Immich database recovery backup no more than 24 hours old and skips creating another recovery backup. Import still takes a current logical dump after Immich's writers stop. The frozen reader then imports the stopped source into the fresh canonical database; an older recovery backup is never used as the live import database.

Reuse requires a native timestamped backup from the selected source's backup folder, a complete gzip/SQL stream, and the source library's original administrator identity in that SQL. File modification time alone is insufficient. Unrecognized, incomplete, stale or mismatched backups cause Manager to create a recovery checkpoint. This format and identity check is separate from the frozen one-time importer preflight.

Keep original library locations available when restoring. A database backup cannot undo media changes made after Frameleaf starts. Manager must not automatically restart Immich against media Frameleaf has modified.

## Database image changes

A release that ships a different `frameleaf-postgres` image moves the database during the update
(FL-1265), unless the release's signed NAS manifest declares the change in place. After
`stop-application` and `database-checkpoint`, the `database-move` step records the stopped
database's row count for every table, its extensions and the source image (`database-move-intent`),
allocates a new folder beside the current one (`frameleaf-<id>-postgres-*`, sized at four times the
checkpoint dump; the review checks the current database size first), stops the stack, renders the
release's stack on the new folder, starts only the new database, restores the checkpoint dump into
it and compares: same tables and row counts, same extensions, and the server version the image tag
names (`19rc1` for `19rc1-pgvector0.8.7`). `apply-release` then starts the release on the new
folder. The previous folder is never written again: if the move fails, or the release does not
start before it served, the rollback puts back the previous release's `compose.json` from the
checkpoint (old image, old folder) without a restore (`database_move_failed_rolled_back` or
`update_failed_rolled_back`); a cancel does the same. A rerun after an interruption restores
into another new folder. Folders a move leaves behind are listed in
`retained-database-directories` and are only deleted when the administrator removes them (below).
A move never goes to an older PostgreSQL major or to an image Manager cannot identify
(`database_image_change_unsupported`).

**Moving the database to another drive** (FL-1322) uses the same `database-move` step on the
installed release and image. `POST /manager-api/review-database-move` with `{ databaseRoot }` checks
the folder like a new install's database folder (host bind on a local disk, outside Docker's
storage, no other container writing there, not inside the media, backup, Manager or any database
folder) and requires room for twice the measured database size: the moved copy, and the second copy
a later engine upgrade restores beside it. `POST /manager-api/move-database` with `{ id, key }`
starts a `move-database` operation: `stop-application`, `database-checkpoint`, `database-move` (new
folder allocated in the chosen root, checked by row counts, extensions and version) and `start`,
which saves the new `databaseRoot` and `databasePath`. The `start-state` receipt is the rollback
boundary: `start` journals it right before the server is first started on the new folder. Any failure
before that receipt puts the checkpoint's `compose.json` back on the original folder and starts it
(`database_relocation_rolled_back`); cancelling an interrupted move without it does the same
(`database_relocation_cancelled`), and resuming such a move restores into another new folder. Once the
receipt is saved, even if Manager stops before the server actually starts, the new folder may hold
writes: it is kept, a failure leaves the operation failed on it rather than rolling back, cancelling is
refused (`database_move_reverse_required`), and resuming starts Frameleaf on the new folder again. The removal check compares Unraid share views (`/mnt/user` and
`/mnt/diskN`) as the same files. The original folder is retained. `GET
/manager-api/retained-databases` lists retained folders; `POST /manager-api/remove-retained-database`
with `{ path }` deletes one, only while no operation is open, the current database answers, and no
container maps the folder, a folder inside it or a folder above it (Manager's own containers, and this
library's stack mapping a folder above it, excepted).

An in-place change needs the same PostgreSQL major and the same on-disk catalog, the installed
image listed in `databaseImageChange.from`, and a checkpoint backup taken first (Manager always
snapshots one before `apply-release`). Release engineering declares it by adding
`docker/postgres/database-image-change.json` for the release that makes the move; the bundle
verifier checks it, and Manager retargets a withdrawn update only to a release whose image it can
take (in place or by a move). Use it only for a rebuild whose data directory the new image opens:
a PostgreSQL beta, RC or GA step usually changes the catalog version (19 beta 4 to 19 RC 1 did),
and those move by dump and restore.

## Recovery of PostgreSQL and Manager

Stop application writers before manual recovery. Preserve the current database directory, the source Immich database and the Manager state folder. Never restore by changing a PostgreSQL image version against an existing physical data directory.

Manager lists only snapshots tagged `frameleaf-canonical` for ordinary restore. Source Immich checkpoints are tagged `immich-source` and cannot be restored into a canonical Frameleaf database. Snapshots with unknown or missing format metadata are refused.

For manual source recovery, an administrator can use standard Restic with the exported recovery key: save the key in a private password file, list snapshots using `restic --repo <repository> --password-file <key-file> snapshots --tag frameleaf-manager-database,immich-source`, then restore the selected snapshot to an empty directory using `restic --repo <repository> --password-file <key-file> restore <snapshot-id> --target <empty-directory> --verify`. The recovered dump is for source Immich recovery using its matching database software; it is not a canonical Frameleaf restore. Keep the recovered configuration and key private.

For a logical restore, unlock the backup repository with the exported recovery key, select the snapshot and review its preserved library mappings. Select the PostgreSQL appdata folder for this host. Manager allocates a new empty subdirectory there and restores the logical database dump. Paths saved in backup metadata do not authorize reusing an old PostgreSQL directory.

An installed library can restore a snapshot from its own recorded library lineage with identical media mappings. The review pins the current installation. Manager disables its containers' automatic restart, removes their exact Unraid autostart entries, stops them, and archives their stack configuration and credentials before allocating the replacement database. The old database directory remains intact. A resumed restore verifies that the predecessor is still fenced before starting workers. Cancelling before replacement workers may have written media restores the previous configuration and leaves its services stopped for an explicit start. Once replacement workers may have written media, automatic cancellation is refused. Older backups without provable lineage cannot replace an unrelated installation.

Canonical recovery retains the imported regeneration run and its recorded original lineage, including a run still waiting for first setup. Once the restored application has an administrator and valid processing settings, setup can release that same prepared run. Missing or mismatched import lineage requires attention; recovery does not invent a replacement run or automatically replay unsafe external work.

For Manager replacement, retain its state folder, exact bind mappings, Manager origin and recovery key. Stop the old Manager container, then launch the verified replacement image with those same mappings. The persisted operation journal marks unfinished work as interrupted. Resume only after reviewing the recorded step. An ambiguous database restore keeps its prior target directory and allocates another empty target before retrying.

Import, restore, update, backup and lifecycle operations all have a retry action. A failed database backup can be cancelled without stopping Frameleaf. If an update fails before applying its release, cancellation restarts the prior release. Once release application may have changed the database or media, retry moves forward on that release; Manager does not attempt an image-only downgrade. Restore refuses media paths used by another running or automatically restarting application. Recovery retains the imported media-location environment and file settings while generating fresh target database credentials.

If Manager cannot start, its private `stack/compose.json` can be used with the host's Compose v2 command and its recorded project name. The protected configuration export includes that project identity and the database host path. Store exports privately: they contain recovery secrets. A database-only export is not a media recovery checkpoint.

## Recover an interrupted Unraid autostart update

Use this procedure only when Manager reports `autostart_changed` after an
interrupted write and refuses to resume or cancel. It exports the two recorded
versions without editing Manager's database. Keep the source and Frameleaf
services in the state Manager left them; do not start them or change their
restart policies while resolving this conflict. Keep other container-management
tools and autostart editing idle until recovery finishes.

Run these commands in Unraid's root terminal. Replace `frameleaf-manager` if the
container has a different name. First stop Manager and its autostart helpers,
then preserve the current host list in a private recovery folder:

```bash
set -euo pipefail
manager_name=frameleaf-manager
manager_state=$(docker exec "$manager_name" node -p 'process.env.MANAGER_DATA')
manager_image=$(docker inspect --format '{{.Image}}' "$manager_name")
docker_root=$(docker info --format '{{.DockerRootDir}}')
test -n "$manager_state" && test -f "$docker_root/unraid-autostart" || exit 1
recovery=$(mktemp -d /root/frameleaf-autostart-recovery.XXXXXX)
chmod 700 "$recovery"
docker stop "$manager_name"
helper_ids_text=$(docker ps -aq --filter "label=app.frameleaf.manager.autostart=$manager_state")
if [[ -n "$helper_ids_text" ]]; then
  mapfile -t helper_ids <<< "$helper_ids_text"
  docker rm --force "${helper_ids[@]}"
fi
cp -p -- "$docker_root/unraid-autostart" "$recovery/current.txt"
```

Export only the pending journal through the Node/SQLite runtime already in the
Manager image. The database connection is read-only; its state mapping permits
SQLite's WAL bookkeeping. Do not modify `manager.sqlite` or delete journal rows.
If there is no pending record, stop here and investigate the operation's error
rather than changing the host list.

```bash
docker run --rm --pull never --network none --read-only \
  --mount "type=bind,source=$manager_state,target=/state" \
  --entrypoint node "$manager_image" --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/state/manager.sqlite", { readOnly: true });
const row = db.prepare("SELECT value FROM settings WHERE key=?").get("autostart-write");
const pending = row && JSON.parse(row.value);
if (!pending || typeof pending.text !== "string" || typeof pending.modified !== "string")
  throw new Error("No pending autostart write; leave the host list unchanged");
process.stdout.write(JSON.stringify(pending));
db.close();
' > "$recovery/journal.json" || exit 1
for version in text modified; do
  docker run --rm -i --pull never --network none --read-only \
    --entrypoint node "$manager_image" -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => process.stdout.write(JSON.parse(input)[process.argv[1]]));
' "$version" < "$recovery/journal.json" > "$recovery/$version.txt" || exit 1
done
```

`text.txt` is the original list immediately before the interrupted write;
`modified.txt` is Manager's intended result. Compare both with `current.txt` and
record any unrelated changes made since then. Retain all three files. Restore
the intended version **in place**, then start Manager and use **Resume** or
**Cancel safely** for the interrupted operation:

```bash
if ! cmp -s -- "$docker_root/unraid-autostart" "$recovery/current.txt"; then
  printf '%s\n' 'The host autostart list changed during recovery; keep the recovery files and stop.' >&2
  exit 1
fi
cat "$recovery/modified.txt" > "$docker_root/unraid-autostart"
sync "$docker_root/unraid-autostart"
docker start "$manager_name"
```

The comparison detects edits since the saved copy; it does not make the
in-place write atomic. If it refuses the restore, retain the recovery files and
review the new host edits before repeating the procedure.

Manager verifies the restored content and advances or clears its pending journal
through the normal recovery flow. If it refuses recovery, leave the saved files
and journal intact. Once the operation has safely completed or been cancelled,
reapply only the unrelated changes you recorded, using Unraid's Docker page.
Do not copy the old list back wholesale or re-enable services that Manager kept
fenced; source-service restoration belongs to Manager's recovery action.

## Validation and distribution status

The live Svelte interface follows `design/frameleaf-manager/`: setup and import review, overview, service controls and sanitized logs, troubleshooting (connection checks across the stack and a downloadable report for the community's Bug reports, with secrets, folder paths, media file names and e-mail addresses removed on a best-effort basis, so the owner reviews it before posting), mounted storage, encrypted database checkpoints and restore, eligible updates, operation history, and Manager settings. The local administrator can change name/password, revoke previous sessions, export the existing recovery key, and download a protected recovery configuration. Each credential change or secret export requires fresh password proof. Capacity and library counts come from the mounted filesystem and the managed database; unavailable data is shown explicitly.

Post-install setup saves the administrator's optional profile locally, opens the existing secure Frameleaf account flow when requested, and presents official app QR links. Library and phone readiness come from the authenticated server setup projection. Finish remains unavailable until the server reports the final catalog and browsing previews acknowledged. Prototype verification codes and simulated phone progress are not used by the live application.

Run `npm run build --prefix manager` followed by `node manager/test/ui-browser.mjs` after installing its Chromium browser with `npx --prefix manager playwright install chromium`. Browser checks use explicit API fixtures for navigation and interaction coverage; `manager/test/container.mjs` separately exercises real HTTPS, claim/session persistence, CSRF, storage, protected key export and credential rotation. Neither substitutes for actual library or physical-platform qualification.

This workspace is under development. Pull-request Manager jobs build and test both Linux architectures without publishing. Manual publication uses the exact current head of `main`. The `production` environment retains its reviewer and signing requirements. Dispatch `.github/workflows/manager.yml` with `publish=true` and the `manager-vX.Y.Z` tag matching `manager/package.json`. Both native architecture jobs, real PostgreSQL/Restic recovery, OCI byte binding, signatures and provenance must pass before the versioned component manifest and GitHub/image `latest` aliases are published. NAS packages consume the authenticated manifest and immutable digest.

A green container authentication or storage test is not evidence of a qualified Immich migration, physical Unraid acceptance, or native mobile setup. Production import requires a signed v3 release bundle and a source accepted by the frozen one-time importer preflight. Release build provenance does not claim migration qualification. Manager uses a fresh PostgreSQL 19 host directory mounted at `/var/lib/postgresql`; SQL-backed queues do not require Redis or Valkey. No floating application image fallback is provided.

Sources: [Unraid Docker settings](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/DockerSettings.page), [Unraid template appdata defaults](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/CreateDocker.php), [Unraid Docker recovery](https://docs.unraid.net/unraid-os/troubleshooting/common-issues/docker-troubleshooting/).
