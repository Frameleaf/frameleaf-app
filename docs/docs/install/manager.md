---
sidebar_position: 15
---

# Install with Frameleaf Manager

:::warning Release availability

The Manager-based release described in this handbook has not been published yet. The currently published `:latest` application images belong to the preceding release. To install that release, use its supplied Compose file and matching instructions. Do not combine the PostgreSQL 19 storage layout below with an older application image or database.

:::

Frameleaf Manager is the primary setup and recovery interface for a Linux Docker host. It installs one Frameleaf server, keeps the database on your host disk, and manages updates and encrypted database backups. Its own sign-in and HTTPS address remain available when the photo application is stopped. A Frameleaf account is optional.

When the Manager release is published, its launcher starts from `ghcr.io/frameleaf/frameleaf-manager:latest` and installs a signed compatible Frameleaf release. Use the release's published installation assets and instructions. If no eligible release is listed, stop there; do not substitute a development image or another product's installer. The [manual container guide](/install/docker-compose) is available for administrators who manage Compose themselves.

## Prepare the host

Install Docker Engine with Compose v2, Cosign, and the Linux `findmnt` and `realpath` commands. Check the [hardware requirements](/install/requirements).

Create four separate, persistent folders on the intended disks:

| Folder             | What it holds                                                                  |
| ------------------ | ------------------------------------------------------------------------------ |
| Manager state      | Manager account, certificates, operation journal and recovery secrets          |
| Library            | Uploaded photos and videos and generated files                                 |
| Database backups   | Encrypted database and recovery-configuration snapshots                        |
| PostgreSQL appdata | A new database directory allocated by Manager for each installation or restore |

Use absolute paths to existing folders. The launcher requires canonical paths, without symlinks. PostgreSQL appdata must be outside Docker's storage directory, on ext4, XFS, Btrfs, ZFS, or an Unraid host share. Network filesystems, Docker named volumes, virtual disk images and RAM disks are not accepted for Manager's database storage. Keep free space for the library, database, processing files and backups.

On Unraid, `auto` uses **Settings → Docker → Default appdata storage location**. A custom share or pool is honored; Manager does not assume a pool named `cache`.

## Start Manager

Place `launch.sh` and its matching `cosign.pub` together as directed by the Frameleaf installation assets. Use the `latest` Manager image below. The launcher resolves that tag to an immutable digest and verifies its signature automatically before starting it; you do not need to look up or copy a digest.

The launcher accepts these arguments, in order:

```text
sh launch.sh MANAGER_IMAGE STATE_FOLDER LIBRARY_FOLDER BACKUP_FOLDER HTTPS_ORIGIN APPDATA_FOLDER LAN_ADDRESS
```

For example, after creating the folders:

```sh
sh launch.sh ghcr.io/frameleaf/frameleaf-manager:latest \
  /srv/frameleaf/manager /srv/frameleaf/library /srv/frameleaf/backups \
  https://192.168.1.20:9443 /srv/frameleaf/appdata 192.168.1.20
```

Replace the example address and paths with your host's values. On Unraid, you can replace the appdata argument with `auto`. Omitting the last address binds Manager to `127.0.0.1`; supply the host's LAN address to reach it from another computer.

Manager receives access to the Docker socket so it can manage sibling containers. Restrict its HTTPS port to your trusted administration network. The photo application and database do not receive that socket.

## Claim your Manager

1. Open the HTTPS address printed by the launcher, normally port **9443**. Manager creates a local certificate on first start. Verify you are connecting to your own server before trusting it; managed trusted certificates can replace the persisted `tls.crt` and `tls.key` in the private state folder.
2. Read `claim-key` in the private Manager state folder on the host. Keep it private.
3. Enter your name, the claim key and a Manager password of at least 14 characters. This account is separate from the photo application's account.
4. Choose **Set up Frameleaf** for a fresh library, the import option for a supported existing installation, or **Restore a Manager backup** for recovery. A source installation must be running for discovery; Manager stops its writers during import.

[![Manager welcome screen with setup, import and restore choices.](/img/screenshots/manager-welcome.jpg)](/img/screenshots/manager-welcome.jpg)

*Choose the path that matches your library. Select any screenshot to view it at full size.*

## Set up a new library

1. Choose the mounted **Library location** and **PostgreSQL appdata location**.
2. Select a verified Frameleaf release, an available application port (normally **2283**) and whether to enable local CPU machine learning.
3. Confirm that no additional scheduler or service will recreate the installation's containers.
4. Select **Check and review**, inspect the storage location and release, then **Set up Frameleaf**.
5. Keep the progress page available until the operation completes. You can close the page and return; Manager records progress. A failed or interrupted operation offers **Resume safely**.
6. Continue through your profile and choose **Open Frameleaf setup**. Create or sign in to the photo application's administrator account and review its processing settings. Linking a Frameleaf account is optional.
7. Use **Connect your phone** when an app is available for your platform. Manager shows the server address, library verification and phone catalog progress. **Finish setup** becomes available only when those checks are complete. You can use the web application while background processing continues.

## Import an existing library

Manager reviews the detected installation, its accounts, albums, media mounts and recovery plan before importing. It stops source writers, creates a fresh Frameleaf database and preserves the existing media paths. It reuses a verified recent source database backup or creates a recovery checkpoint. It does not make a separate copy of all your photos and videos.

Back up the source media independently before cutover. Once Frameleaf has written to those files, restarting the old application against them is not a rollback. Read the [import guide](/administration/import-library) for supported source versions, what is preserved and what must be configured again.

After import, metadata, previews, search and face results may still be rebuilding. Manager shows regeneration progress and items needing attention. Finishing setup does not mean every processing job has completed.

## Day-to-day management

**Overview** shows library and service health, storage use, the current release and the latest backup. Use **Services** to manage the stack, **Storage** to review locations, **Backups** for database recovery and **Updates** to review a new release.

[![Manager Overview with library counts, storage use, service health, the latest backup and links to backups and updates.](/img/screenshots/manager-overview.jpg)](/img/screenshots/manager-overview.jpg)

*Check library and service health here, then choose **View backups** to open your database recovery points.*

Use **Export recovery configuration** and store that file privately away from the server. It includes deployment configuration and the backup recovery key. Manager's encrypted backups contain the database and configuration, **not original photos, videos or external libraries**. Follow [Backup and restore](/administration/backup-and-restore) before relying on the installation.

Manager-managed Compose and credentials are generated by Manager. Use the Manager workflow for its stack; do not create a second manual stack pointing at the same database or library.
