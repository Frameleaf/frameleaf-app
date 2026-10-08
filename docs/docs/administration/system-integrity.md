# System Integrity

## Integrity report

Open **Library Care** for missing originals, damaged media and repair queues. **Scan again** checks file availability and integrity as a background operation; it can be paused, resumed or cancelled. See [Library Care](/features/library-care) and [Media recovery](/guides/media-recovery) for review and repair.

A missing path can mean an offline disk or changed mount, not deleted content. Restore storage access before attempting repair. Checksum mismatches need review: never overwrite the recorded checksum merely to silence a finding. Recovery uses verified exact copies and preserves displaced damaged files.

Keep untracked files until you identify their purpose. In particular, edited masters and edit artifacts are not disposable thumbnail caches.

## Folder checks

:::info
The folders considered for these checks include: `upload/`, `library/`, `thumbs/`, `encoded-video/`, `profile/`, `backups/`
:::

When Frameleaf starts, it performs a series of checks in order to validate that it can read and write files to the volume mounts used by the storage system. If it cannot perform all the required operations, it will fail to start. The checks include:

- Creating an initial hidden file (`.immich`) in each folder
- Reading a hidden file (`.immich`) in each folder
- Overwriting a hidden file (`.immich`) in each folder

The checks are designed to catch the following situations:

- Incorrect permissions (cannot read/write files)
- Missing volume mount (`.immich` files should exist, but are missing)

### Common issues

:::note
`.immich` files serve as markers and help keep track of volume mounts being used by Frameleaf. Except for the situations listed below, they should never be manually created or deleted.
:::

#### Missing `.immich` files

```
Verifying system mount folder checks (enabled=true)
...
ENOENT: no such file or directory, open 'upload/encoded-video/.immich'
```

The above error messages show that the server has previously (successfully) written `.immich` files to each folder, but now does not detect them. This could be because any of the following:

- Permission error - unable to read the file, but it exists
- File does not exist - volume mount has changed and should be corrected
- File does not exist - the marker was deleted or omitted from a restore. Verify the mounted storage and recover the expected folder contents from your known recovery point before restoring its marker. Creating a marker in an empty or wrongly mounted folder can conceal the real problem.

### Ignoring the checks

:::danger
The checks are designed to catch common problems that we have seen users have in the past, and often indicate there's something wrong that you should solve. If you know what you're doing and you want to disable them you can set the following environment variable:
:::

```
FRAMELEAF_IGNORE_MOUNT_CHECK_ERRORS=true
```
