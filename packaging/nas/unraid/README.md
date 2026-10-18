# Frameleaf for Unraid

[Help center](https://frameleaf.app/help) · [Documentation](https://frameleaf.app/docs)

Install **Frameleaf Manager** for a self-hosted photo and video library. Manager
installs or imports a library and manages the application, PostgreSQL and optional
machine learning as sibling containers. Only Manager receives the Docker socket;
that access lets it create and control containers on this host.

This repository contains generated Docker templates. Packaging source and support
live in [Frameleaf/frameleaf-app](https://github.com/Frameleaf/frameleaf-app).
Templates reference `:latest` images and never pin a release. A published template is not proof
of Community Apps acceptance or physical Unraid qualification.

The initial catalog contains Manager only. Manual Server/ML templates await a
compatible signed application release with its `nas-manifest.json`. Manager's
publication does not make an older application release compatible; installation
and updates still require the application's release-verification gates.

## Screenshots

Manager 0.1.2 interface with demo data. Counts, service states, paths and releases
shown are examples, not evidence of a qualified Unraid installation.

![Manager overview with demo data](https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/manager-overview.jpg)
![Manager storage mappings with demo data](https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/manager-storage.jpg)
![Manager database backups with demo data](https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/manager-backups.jpg)

## Manager installation

1. Create the state, media, database parent and backup folders on the intended
   storage **before** installing. Use Unraid's configured appdata share or your
   chosen pool; do not assume a pool named `cache`. Database storage must be on
   supported local disk storage outside Docker's data root and `docker.img`.
2. Leave **Manager HTTPS origin** blank and open Manager from the WebUI link
   (`https://<NAS IP>:9443` or `https://tower.local:9443`). Only if you reach
   Manager through a custom DNS name, set **Manager HTTPS origin** to that exact
   address, for example `https://nas.example:9443`, and set **Advanced View →
   WebUI** to match; other hostnames are then refused with HTTP 403.
3. Keep each storage mapping's **Host Path and Container Path identical**. When
   changing a folder, also update its corresponding advanced variable:

   | Storage mapping | Matching variable |
   | --- | --- |
   | Manager state | `MANAGER_DATA` |
   | Media | `MANAGER_STORAGE_ROOTS` |
   | Database parent | `MANAGER_DATABASE_ROOTS` and `MANAGER_APPDATA_ROOT` |
   | Database backups | `MANAGER_BACKUP_ROOT` |

   For example, a custom state folder `/mnt/fastpool/appdata/frameleaf-manager`
   must be that same path in all three fields: Host Path, Container Path and
   `MANAGER_DATA`. Multiple approved media/database roots use colon-separated
   variables and an identical host/container mapping for each folder. Never
   expose the whole host filesystem to make additional folders selectable.
4. Apply the container configuration and open the WebUI. Manager initially
   generates a self-signed certificate, so expect a browser warning. For a
   trusted HTTPS connection, provision a certificate and key matching the
   address as `tls.crt` and `tls.key` in the private Manager state folder
   before first startup. Protect the key and retain the state folder on updates.
5. From a device on your home network, choose the administrator name and
   password, then follow the installation wizard. No claim key is needed; this
   only works while Manager has no administrator.

## Importing an existing library

Add each approved source media or database folder as an identical host/container
mapping before import. Retain the original stopped source and its recovery point.
Do not attach Frameleaf PostgreSQL to the source database's physical directory.

For imports, use `docker info --format '{{.DockerRootDir}}'` to identify Docker's
actual data root. Select its existing `unraid-autostart` file in **Unraid autostart
file**, then set **Autostart controller path** to
`/run/frameleaf-host/unraid-autostart`. Do not create a replacement or guess a pool
path. Leave both fields blank for a fresh install without that file mounted.
Manager needs this writable file to fence source autostart while preserving other
entries. Follow the
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

Report problems through [Frameleaf issues](https://github.com/Frameleaf/frameleaf-app/issues).
Include the Unraid version, template/release version and sanitized error details.
Never include credentials, recovery keys or private media.

Community Apps listing requires Validate, Scan and moderator acceptance at
[the submission portal](https://ca.unraid.net/submit/new). Before declaring a
release qualified, retain exact image digests and Unraid versions with fresh
install, restart, upgrade, failed-upgrade recovery, uninstall-with-data-retention,
backup restore and supported import/resume evidence. Catalog publication and
passing package tests do not replace those platform checks.
