# Server Commands

The `ghcr.io/frameleaf/frameleaf-server` container image comes preinstalled with an administrative CLI (`frameleaf-admin`) that supports the following commands:

| Command                    | Description                                                   |
| -------------------------- | ------------------------------------------------------------- |
| `help`                     | Display help                                                  |
| `reset-admin-password`     | Reset the password for the admin user                         |
| `disable-password-login`   | Disable password login                                        |
| `enable-password-login`    | Enable password login                                         |
| `disable-maintenance-mode` | Disable maintenance mode                                      |
| `enable-maintenance-mode`  | Enable maintenance mode                                       |
| `enable-oauth-login`       | Enable OAuth login                                            |
| `disable-oauth-login`      | Disable OAuth login                                           |
| `list-users`               | List Frameleaf users                                          |
| `grant-admin`              | Grant admin privileges to a user (by email)                   |
| `revoke-admin`             | Revoke admin privileges from a user (by email)                |
| `version`                  | Print Frameleaf version                                       |
| `change-media-location`    | Change database file paths to align with a new media location |
| `schema-check`             | Verify database migrations and check for schema drift         |
| `import-immich`            | One-time offline import of an existing library (see below)    |
| `cloud-backup restore`     | Restore this server from its Frameleaf Cloud backup bucket    |

## How to run a command

From your Compose directory, run `docker compose exec frameleaf-server frameleaf-admin <command>`. For an interactive shell, use `docker compose exec frameleaf-server bash`, then run `frameleaf-admin <command>`. The Compose service is `frameleaf-server`; the displayed container name is `frameleaf_server`. The old command names `immich-admin`, `immich` and `immich-healthcheck` still work as deprecated aliases of `frameleaf-admin`, `frameleaf` and `frameleaf-healthcheck`. They keep working for the whole of the current major version and stop working in the next major release of Frameleaf; no date is set for that release.

## Examples

### Export a managed backup for offline recovery

Frameleaf 1.1.12 and later can export a managed backup from its linked source server. Use the complete current recovery key file on [private storage](private-backup-storage.md). The command obtains read-only access and renews it during the export:

```bash
frameleaf-admin cloud-backup restore --managed \
  --key-file /private/current-recovery-key.json \
  --export-directory /private/backup-export
```

The destination must be a new directory with an existing parent. The export contains the complete selected snapshot, its encrypted objects and a key file with trusted snapshot history. Add `--manifest <key>` to select a specific trusted snapshot. Keep the complete export privately on another device.

On a replacement server, restore from that copy without storage credentials or a working Cloud account:

```bash
frameleaf-admin cloud-backup restore \
  --offline-directory /private/backup-export \
  --key-file /private/backup-export/key-file.json \
  --scope library --restore-database
```

Stop the replacement server's API and job writers before restoring its database. This replaces that database and restores the snapshot's files; use a matching server/database version. `--managed` is an export option on the linked source server; use `--offline-directory` on the replacement server.

Reset Admin Password

```
frameleaf-admin reset-admin-password
Found Admin:
- ID=e65e6f88-2a30-4dbe-8dd9-1885f4889b53
- OAuth ID=
- Email=admin@example.com
- Name=Frameleaf Admin
? Please choose a new password (optional) frameleaf-is-cool
? Invalidate existing sessions? Yes
The admin password has been updated.
```

Disable Password Login

```
frameleaf-admin disable-password-login
Password login has been disabled.
```

Enable Password Login

```
frameleaf-admin enable-password-login
Password login has been enabled.
```

Disable Maintenance Mode

```
frameleaf-admin disable-maintenance-mode
Maintenance mode has been disabled.
```

Enable Maintenance Mode

```
frameleaf-admin enable-maintenance-mode
Maintenance mode has been enabled.

Log in using the following URL:
https://photos.example.com/maintenance?token=<token>
```

Enable OAuth login

```
frameleaf-admin enable-oauth-login
OAuth login has been enabled.
```

Disable OAuth login

```
frameleaf-admin disable-oauth-login
OAuth login has been disabled.
```

List Users

```
frameleaf-admin list-users
[
  {
    id: 'e65e6f88-2a30-4dbe-8dd9-1885f4889b53',
    email: 'admin@example.com',
    name: 'Frameleaf Admin',
    storageLabel: 'admin',
    externalPath: null,
    profileImagePath: 'upload/profile/e65e6f88-2a30-4dbe-8dd9-1885f4889b53/e65e6f88-2a30-4dbe-8dd9-1885f4889b53.jpg',
    shouldChangePassword: true,
    isAdmin: true,
    createdAt: 2023-07-11T20:12:20.602Z,
    deletedAt: null,
    updatedAt: 2023-09-21T15:42:28.129Z,
    oauthId: '',
  }
]
```

Grant Admin

```
frameleaf-admin grant-admin
? Please enter the user email:  user@example.com
Admin access has been granted to user@example.com
```

Revoke Admin

```
frameleaf-admin revoke-admin
? Please enter the user email:  user@example.com
Admin access has been revoked from user@example.com
```

Print Frameleaf Version

```
frameleaf-admin version
v1.0.0
```

Change media location

```
frameleaf-admin change-media-location
? Enter the previous value of FRAMELEAF_MEDIA_LOCATION: /data
? Enter the new value of FRAMELEAF_MEDIA_LOCATION: /my-data
...
  Previous value: /data
  Current value:  /my-data

  Changing database paths from "/data/*" to "/my-data/*"

? Do you want to proceed? [Y/n] y

Database file paths updated successfully! 🎉
...
```

Schema Check

```
frameleaf-admin schema-check
Migrations are up to date

No schema drift detected
```

## Offline Immich import

`frameleaf-admin import-immich` (also available through the current `immich-admin` alias) supports `preflight`, `run`, `status`, `resume`, `verify` and `abandon` with `--config /path/config.json`. Use a fresh destination, a stopped read-only supported source and distinct media copies. Follow the [offline import runbook](./import-immich.md) before starting; ordinary API-based server migration is a separate feature.
