---
sidebar_position: 10
---

# Requirements

Frameleaf needs a Docker host, persistent storage and enough memory for the processing features you enable. Check the requirements attached to your chosen release before installing.

## Hardware

| Resource      | Starting point                                                       |
| ------------- | -------------------------------------------------------------------- |
| Host          | 64-bit Linux, on `amd64` or `arm64` supported by the release         |
| CPU           | At least 2 cores; 4 or more for background processing                |
| Memory        | At least 6 GB; 8 GB or more recommended, with more for larger models |
| Media storage | Enough for originals, previews, edited versions and working files    |
| Database      | Local disk, preferably SSD, with Unix ownership and permissions      |
| Backups       | Separate storage for both media and database recovery copies         |

Large models, video jobs and several concurrent workers can require substantially more memory. Start with low concurrency and increase it after observing your system. GPU acceleration is optional; check the specific [video](/features/hardware-transcoding) or [machine-learning](/features/ml-hardware-acceleration) backend before choosing hardware.

## Docker and database

Use Docker Engine with **Compose v2** (`docker compose`). Use the server, PostgreSQL and optional worker images from the same verified Frameleaf release.

Frameleaf uses PostgreSQL 19 with pgvector. The release database image mounts `/var/lib/postgresql`; older PostgreSQL directories cannot be reused by changing the image tag. Manual deployments can use a [dedicated external database](/administration/postgres-standalone) meeting the same requirements.

[Manager](/install/manager) requires a Linux host with Cosign, `findmnt` and `realpath`. It allocates a fresh PostgreSQL directory on ext4, XFS, Btrfs, ZFS or supported Unraid host storage. Database folders on network filesystems, loopback images, RAM disks or Docker named volumes are rejected by Manager. It also requires host mount information and the Docker socket.

## Virtual machines and desktop hosts

A Linux virtual machine can provide the supported host environment. Make its disks persistent and expose the CPU features required by the chosen images. Docker Desktop or other custom environments require the [manual container path](/install/docker-compose); Manager's host-storage checks are designed for Linux server deployments.

Keep database storage off SMB/NFS shares and Windows-mounted folders without Unix ownership semantics. Do not use the container writable layer for your library or database.

## Network access

Installation pulls images and optional models. Some features use additional services only when configured, including remote processing, OAuth, email and casting. See [Privacy and connections](/features/privacy) before choosing those features. Use a trusted HTTPS address for remote access and shared-browser use.
