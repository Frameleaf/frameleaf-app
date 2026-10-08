---
sidebar_position: 50
---

# Synology

:::warning Match the published release

This guide describes the upcoming release. Before installing, read the [release availability notice](/install/docker-compose). Use the published release's matching deployment files; its current `:latest` images must not be combined with the PostgreSQL 19 layout described here.

:::

Use a compatible 64-bit Synology NAS with Docker support through DSM **Container Manager**. This guide installs the [manual Compose stack](/install/docker-compose). A native package should be used only when a Frameleaf release explicitly supplies and supports it for your platform.

## Prepare folders and release files

1. Create a folder for the installation, for example `/volume1/docker/frameleaf`.
2. Create separate `library` and fresh `postgres19` folders on persistent local storage. The database needs Unix ownership and permissions and must not be an existing PostgreSQL cluster.
3. Download `docker-compose.yml` and `example.env` from one verified Frameleaf release. Put them in the installation folder and rename `example.env` to `.env`.
4. Follow [Configure storage and credentials](/install/docker-compose#2-configure-storage-and-credentials). Use absolute host paths, a private random database password and `FRAMELEAF_VERSION=latest` for current application images. Keep the database image and `/var/lib/postgresql` mount from the release.

## Create the project

In **Container Manager → Project → Create**, choose a memorable project name and the installation folder. Use the existing Compose file, review it, then start the project.

Check the database and server container health and logs. Open `http://YOUR-NAS:2283` when the server is healthy, then complete [After installation](/install/post-install). A Web Station portal is not required for this direct application address.

## Network access

If the DSM firewall is enabled, allow the application port from the networks you intend to use and allow the required private Docker-network traffic. Review the actual project network in Container Manager before adding rules; container addresses can change after recreation. Do not expose PostgreSQL or machine-learning ports publicly.

For a fixed Docker subnet, choose an unused range that does not overlap your LAN, VPN or another Docker network. Configure it on the project network and attach every related service to that same network. Check DSM firewall rules after any network change.

For access away from home, follow [Remote access](/guides/remote-access) and [Reverse proxy](/administration/reverse-proxy).

## Update or recover

Read the [upgrade guide](/install/upgrading), make a matched database and media backup, and update the project using the new release's compatible files. Preserve the project name, `.env`, host folders and volume mappings. Recreating containers does not require deleting library or database folders.

Check health, sign-in and representative originals after updating. If startup fails, keep the old recovery point and logs; use [Backup and restore](/administration/backup-and-restore) rather than changing PostgreSQL's image against an old data directory.
