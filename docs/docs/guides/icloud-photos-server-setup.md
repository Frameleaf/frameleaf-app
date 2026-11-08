# iCloud Photos Sync: server setup

This guide is for the administrator who installs and maintains iCloud Photos Sync. After setup, each user connects their own Apple account through the [iCloud Photos Sync user guide](icloud-photos-sync.md).

There is nothing to install or configure. The iCloud bridge ships inside the Frameleaf server and starts by itself the first time someone uses iCloud Photos, listening only on the server's loopback interface. Each user connects their Apple account from the web app. An administrator can turn iCloud Photos on or off in **Settings**, under **Server & updates**; it is on by default, and turning it off stops the bridge without removing photos or saved sign-ins. The Frameleaf web application must be served over HTTPS for account authentication.

Frameleaf keeps the bridge's generated secrets and its temporary downloads in `.frameleaf-icloud` inside your data folder. Include this folder in backups and do not delete it: saved Apple sessions need its encryption key. If the encryption key is lost, users sign in to Apple again. The folder also holds verified recovery copies, which can't be recreated from it.

The bridge imports Rclone **v1.75.2**, commit `be8d6044eacb843b74d335db0c5fbe09222031fe`. The Rclone MIT copyright and permission notice is at `/licenses/icloud-bridge/rclone/COPYING` in the server image. The [protocol reference](https://github.com/Frameleaf/frameleaf-app/blob/main/icloud-bridge/api.md) records the transport contract and limitations.

Installations that already set up the earlier Compose overlay keep working unchanged, because `FRAMELEAF_ICLOUD_BRIDGE_URL` still takes precedence.

The first time the server starts with iCloud sync, it builds an index over the sync's inventory. On a very large iCloud library that start takes longer.

`FRAMELEAF_ICLOUD_IDENTITY_MATCHING=false` switches off iCloud source identity matching between the sync and the Frameleaf app. Then only photos with the same SHA-256 are treated as the same. See [iCloud Photos Sync and the Frameleaf app](icloud-photos-sync.md#with-the-app).

Two further options, `FRAMELEAF_ICLOUD_IDENTITY_ADOPTION` and `FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION`, are off by default. Leave them unset: with them off, the sync downloads each photo from iCloud and checks its contents before reusing a matching photo already on the server.

## Capacity and long-video validation

Per-connection controls are limited to 1–4 concurrent downloads. The worker also applies server-wide limits:

| Environment variable                 | Default                  | Purpose                                                    |
| ------------------------------------ | ------------------------ | ---------------------------------------------------------- |
| `FRAMELEAF_ICLOUD_MAX_CONCURRENCY`   | `4`                      | Maximum active resource leases across connections          |
| `FRAMELEAF_ICLOUD_MAX_STAGING_BYTES` | `107374182400` (100 GiB) | Total reserved staging budget                              |
| `FRAMELEAF_ICLOUD_FREE_SPACE_BYTES`  | `1073741824` (1 GiB)     | Free disk space to retain in addition to the next download |

Set these on the workers that run sync. Increasing a reservation limit does not create disk space. Retained copies outside a user's current selection still consume their reservation; `staging_retained_capacity` requires reselection/recovery or additional capacity. Do not clear database reservations or empty staging to bypass it. Committed cleanup remains eligible when the budget is full.

### Media validation timeout

The server environment variable `FRAMELEAF_MEDIA_VALIDATION_TIMEOUT_MS` controls the integrity validator's timeout, including full video decoding. Its default is **120000 ms (two minutes)**; finite values are clamped to **10000–86400000 ms** and invalid values use the default. Set it on each server/worker that performs validation, for example in an additional Compose override:

```yaml
services:
  frameleaf-server:
    environment:
      FRAMELEAF_MEDIA_VALIDATION_TIMEOUT_MS: '600000'
```

A timeout is unresolved validation, not proof of corruption or successful repair. Raising the timeout can permit long videos to finish; it does not add decoder support. Native operations keep their concurrency slot until they actually finish after a timeout, preventing timed-out work from creating unbounded parallel decoding.

## Disconnect, backup, and restore

**Disconnect account** removes its saved Apple session and stops new work. Existing imported Frameleaf assets remain. It does not delete the Apple account's photos or turn the connector into a mirror. Do not manually empty staging while a run is active or while it contains the only verified recovery copy.

Back up the Frameleaf database, managed media, retained source resources, and the `.frameleaf-icloud` folder as one consistent checkpoint. Restrict backup access as tightly as production secrets. Stop/pause workers before taking an application-consistent snapshot. Restoring a database without its matching encryption key requires Apple reauthentication. Never attach session values, tokens, signed URLs, passwords, or keys to support reports.

All connector state is in the canonical `public` schema. Back up the database together with the original connector encryption key and matching media files. A one-time offline Immich import uses a separate read-only source and never shares this database with another server implementation. See [Backup and restore](../administration/backup-and-restore.md).
