# Separate media storage locations

Most installations should keep the complete media tree together. For a manual Compose deployment, you can place generated media or backups on separate disks by mounting the corresponding container subdirectories. Manager installations should retain their reviewed mappings and recovery configuration.

## Prepare a consistent move

1. Make a verified database and media backup.
2. Stop all application and job writers. Keep them stopped while copying files and changing mounts.
3. Create the destination folders with the required ownership and permissions.
4. Copy the **complete** existing folder contents, including hidden mount markers and edit artifacts. Verify the copy before changing the live mapping; preserve the old copy until the installation is checked.
5. Add the chosen mounts to the server's existing `volumes` list, and to every worker that needs the same files.

For example, these entries place thumbnails and database backup files on separate host folders:

```yaml
- /srv/frameleaf/thumbs:/data/thumbs
- /srv/frameleaf/backups:/data/backups
```

Keep the parent library mount at `/data`. The paths above are examples to add to your existing service, not a complete Compose file. Container paths must match the release's media layout.

## Restart and verify

Recreate the affected containers with `docker compose up -d`, check startup mount checks, and open representative originals and edited versions. Run [Library Care](/features/library-care) if anything is missing.

Do not reset or delete the database to resolve a path error. Restore the correct mount or use the supported [media-location command](/administration/server-commands) when the container's actual media root must change.

The thumbnails folder contains previews and some non-regenerable edit artifacts. Back it up completely. A capacity reading for the parent library does not establish that a separately mounted disk has free space; monitor each disk.
