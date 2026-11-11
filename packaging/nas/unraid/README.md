# Frameleaf for Unraid

[Help center](https://frameleaf.app/help) · [Documentation](https://frameleaf.app/docs) · [Unraid guide](https://frameleaf.app/docs/nas/unraid/)

**Your photos. Your server. Everywhere.** Frameleaf is a self-hosted photo and video
library: bring a lifetime of photos home, find any moment, edit it, and enjoy it on
your phone, in any browser and on the TV. Your originals stay as ordinary files on
your own disks, faces and search are worked out on your own hardware, and there's no
telemetry, subscription or cloud account required.

> Frameleaf is in beta. Keep independent backups of your photos and videos.

## What Frameleaf does

- **Library** — a fast timeline for every photo and video, with albums, folders,
  stacks, tags, RAW, Live and Motion Photos, and your best shots picked out.
- **Search** — describe what you remember. People and pets, places and landmarks,
  text in photos and words spoken in videos, all recognised on your server.
- **Memories** — on this day, trips and years in review, played as shows with music.
- **Create** — a photo editor with masks, looks and RAW development; **Studio**, a
  real video editor that can make a movie from an album in one step; **Boards** for
  references and design files; and **Clients** for photography studios.
- **Share** — a library for each person, partner sharing, shared albums and spaces,
  and links with passwords and expiry.
- **Apps** — iPhone, iPad and Android with camera-roll backup, plus Apple TV and
  Android TV.
- **Keep it safe** — duplicate review, locked content, and database, Cloud and Buddy
  backups. Optional [Frameleaf Cloud](https://frameleaf.app/docs/cloud/overview/) adds
  remote access, off-site backup and cloud GPU processing.

See [every feature](https://frameleaf.app/platform/) or [try the demo](https://frameleaf.app/demo/).

## Switching to Frameleaf

Bring your library across from Immich, PhotoPrism, LibrePhotos, Photoview, Piwigo,
Lychee, PiGallery2, Ente Photos, Nextcloud Photos and Memories, or Synology Photos,
and import a Google Photos Takeout or iCloud Photos. See
[Switching to Frameleaf](https://frameleaf.app/docs/migrate/from-immich/).

## Screenshots

Screens use demonstration data.

![Library timeline](https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/frameleaf-library.jpg)
![Search in plain words](https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/frameleaf-search.jpg)
![People and pets](https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/frameleaf-people.jpg)
![Memories](https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/frameleaf-memories.jpg)
![Photo editor with masks](https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/frameleaf-editor.jpg)
![Studio video editor](https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/frameleaf-studio.jpg)
![Boards filtered by colour](https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/frameleaf-boards.jpg)
![Frameleaf on Apple TV](https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/frameleaf-apple-tv.jpg)
![Frameleaf Manager on Unraid](https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/manager-overview.jpg)

## Installing on Unraid

Install **Frameleaf** from Community Apps. The template runs Frameleaf Manager, the
official installer: it sets up Frameleaf, its PostgreSQL database and optional
machine learning as sibling containers, then handles updates and encrypted database
backups. Only Manager receives the Docker socket; that access lets it create and
control containers on this host.

Manager detects host GPUs through sysfs. It maps `/dev/dri` into the Frameleaf
server for Intel/AMD video acceleration, or reserves an NVIDIA GPU with compute
and video capabilities when the NVIDIA driver and Docker runtime are present.
This also works when ML is disabled. Hosts without a supported GPU keep their CPU
configuration. Accelerated ML services receive their own device mappings from Manager.

Keep **DockerMan templates** mapped to
`/boot/config/plugins/dockerMan/templates-user`. Manager writes private XML
templates for its running database, server and ML containers after starting them.
They retain the same container names, Compose labels, network aliases, storage,
device mappings and credentials, allowing DockerMan to edit and recreate them.
Use Manager for coordinated upgrades, backup and recovery. Manager operations
regenerate the templates from the running configuration; upgrades may replace
settings edited directly in DockerMan. Do not run operations in both interfaces
at the same time. These templates contain credentials: do not share or commit them.

For an existing installation, add the **DockerMan templates** mapping from the
current Manager template and apply it in DockerMan. Start the
library from Manager to generate the service templates.

## Manager setup

1. Click **Apply**. The template maps `/mnt` into Manager, and you choose where
   Frameleaf keeps photos, the database and backups in Manager's setup, with
   folders under `/mnt/user/appdata/` already filled in. Manager creates them.
   Database storage must be on supported local disk storage outside Docker's
   data root and `docker.img`.
2. Leave **Manager origin** blank and open Manager from the WebUI link
   (`https://<NAS IP>:2282` or `https://tower.local:2282`). Only if you reach
   Manager through a custom DNS name, set **Manager origin** to that exact
   address, for example `https://nas.example:2282`, and set **Advanced View →
   WebUI** to match; other hostnames are then refused with HTTP 403.
3. To show photos you already keep somewhere else, add the folder under
   **External folders** in Manager, during setup or later on the Services page.
   It is read-only by default. Manager already controls Docker through its
   socket, so mapping `/mnt` gives it nothing new; the Frameleaf server only sees
   the folders you choose. An install from an earlier template keeps its own
   folder mappings and location variables and works as before. To use
   **External folders** on one, edit the Manager container, add a Path with
   Container Path and Host Path both `/mnt` and Access Mode **Read Only -
   Slave**, and Apply. Manager's Services page shows the same steps. Where
   Frameleaf keeps photos, database and backups does not change.
4. Apply the container configuration and open the WebUI. Manager initially
   generates a self-signed certificate, so expect a browser warning. For a
   trusted HTTPS connection, provision a certificate and key matching the
   address as `tls.crt` and `tls.key` in the private Manager state folder
   before first startup. Protect the key and retain the state folder on updates.
5. From a device on your home network, choose the administrator name and
   password, then follow the installation wizard. No claim key is needed; this
   only works while Manager has no administrator.

## Importing an existing library

Add each approved source media or database folder as a mapping before import. Retain the original stopped source and its recovery point.
Do not attach Frameleaf PostgreSQL to the source database's physical directory.

Manager configures Unraid autostart access automatically, using Docker's actual
data root and the existing host list. Leave **Unraid autostart file** and
**Autostart controller path** blank; existing manual mappings remain supported.
An isolated helper uses the running Manager image and mounts that file,
preserving other entries while preventing Immich from restarting at boot.
If the host file is missing or inaccessible, Manager refuses the import. A fresh
installation can proceed when Manager verifies that no list exists. Follow the
[offline import guide](https://github.com/Frameleaf/frameleaf-app/blob/main/docs/docs/administration/import-immich.md).

## Updates and backups

Manager's encrypted recovery checkpoints contain the **database, configuration
and required recovery secrets**. They do **not** back up photos, videos or external
libraries. Back those up independently, retain the recovery key and Manager state,
and verify a restore before relying on the backups.

Use Manager for application service updates. Update Manager itself with Unraid's
**Check for Updates** (it follows `:latest`) after retaining its state and
recovery points. Do not downgrade an
image against an upgraded database schema or delete storage folders when removing
containers. Restore a matched database, media, configuration and release instead.

## Manual server and ML installation

For compatible releases, the optional `frameleaf-server` and `frameleaf-ml`
templates support manual installation without Manager. Create a user-defined
Docker network named `frameleaf` first. Create `frameleaf-postgres` on that network
using the **exact PostgreSQL image digest in the matching `nas-manifest.json`**;
generic PostgreSQL images are not interchangeable. Mount its new host database
parent at `/var/lib/postgresql`. Do not reuse an older PostgreSQL data directory.

Configure the server's `DB_HOSTNAME`, `DB_DATABASE_NAME`, `DB_USERNAME` and masked
`DB_PASSWORD` to match PostgreSQL. Map the library folder to `/data` and select the
web host port. For local ML, install `frameleaf-ml` on the same network and use
`http://frameleaf-ml:3003`; without ML set
`FRAMELEAF_MACHINE_LEARNING_ENABLED=false`. Both templates map the same
`studio-worker` folder (server read-write, ML read-only): the server writes the
bundled Studio render worker's enrolment there, so web Studio opens and exports.
An ML container on another host cannot share that folder, so Studio stays
unavailable without a local `frameleaf-ml`. Keep application, ML, database and
release evidence from the same supported release. Preserve matched database and
media backups before upgrades. See the
[manual container guide](https://github.com/Frameleaf/frameleaf-app/blob/main/docker/README.md).

## Support and listing status

Get help in the [Help center](https://frameleaf.app/help), or report problems through
[Frameleaf issues](https://github.com/Frameleaf/frameleaf-app/issues).
Include the Unraid version, template/release version and sanitized error details.
Never include credentials, recovery keys or private media.

This repository contains generated Docker templates, published automatically from
signed Manager and Frameleaf releases; packaging source lives in
[Frameleaf/frameleaf-app](https://github.com/Frameleaf/frameleaf-app). Templates
reference `:latest` images and never pin a release. The catalog contains the
Frameleaf (Manager) template and the manual `frameleaf-server` and `frameleaf-ml`
templates.

Community Apps listing requires Validate, Scan and moderator acceptance at
[the submission portal](https://ca.unraid.net/submit/new). Before declaring a
release qualified, retain exact image digests and Unraid versions with fresh
install, restart, upgrade, failed-upgrade recovery, uninstall-with-data-retention,
backup restore and supported import/resume evidence. Catalog publication and
passing package tests do not replace those platform checks.

### Mobile discovery

Manager installations of releases that include `frameleaf-lan-discovery` publish a Bonjour announcement from a separate host-network companion. The Frameleaf server and database stay on their private Docker bridge. The companion follows the published web port and the server's LAN discovery setting; no host Avahi files or manual announcements are needed. A loopback-only installation is not advertised. Older server releases without the companion keep their existing deployment layout.

For HTTP management, set **Manager origin** to the exact `http://` address and
change the Advanced View WebUI to that same address. HTTP sends management
traffic without encryption; use a trusted home network. An unset origin keeps HTTPS.
