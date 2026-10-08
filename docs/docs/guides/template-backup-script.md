# Backup Script

[Borg](https://www.borgbackup.org/) is a feature-rich deduplicating archiving software with built-in versioning. We provide a template bash script that can be run daily/weekly as a [cron](https://wiki.archlinux.org/title/cron) job to back up your files and database. We encourage you to read the quick-start guide for Borg before running this script.

This script assumes you have a second hard drive connected to your server for on-site backup and ssh access to a remote machine for your third off-site copy. [BorgBase](https://www.borgbase.com/) is an alternative option for off-site backups with a competitive pricing structure. You may choose to skip off-site backups entirely by removing the relevant lines from the template script.

The database is saved to your Frameleaf upload folder in the `database-backup` subdirectory, then archived with your assets by Borg. Stop all API, job and upload writers before the database dump and keep them stopped until both archives finish, or use a tested consistent snapshot procedure. Taking the dump and filesystem backup at similar times does not make them consistent while writers are active. Include every external-library media root, deployment configuration and encryption key in both `borg create` commands below. Keep the complete media tree: edit artifacts stored beside thumbnails cannot be regenerated.

:::info
Frameleaf's [scheduled database backups](/administration/backup-and-restore#database-backups) cover the database. This template also archives media and versions the resulting recovery points with Borg.

- This script uses storage more efficiently by versioning your backups instead of making multiple copies.
- Database and media can be archived as one recovery point when writers remain stopped throughout the backup.

Keep scheduled backups enabled until this alternative has passed a restore rehearsal. The template does not stop or restart writers for you; a cron deployment needs its own tested coordination.
:::

### Prerequisites

- Borg needs to be installed on your server as well as the remote machine. You can find instructions to install Borg [here](https://borgbackup.readthedocs.io/en/latest/installation.html).
- (Optional) To run this script as a non-root user, you should [add your username to the docker group](https://docs.docker.com/engine/install/linux-postinstall/).
- To run this script non-interactively, set up [passwordless ssh](https://www.redhat.com/sysadmin/passwordless-ssh) to your remote machine from your server. If you skipped the previous step, make sure this step is done from your root account.

To initialize the borg repository, run the following commands once.

```bash title='Borg set-up'
UPLOAD_LOCATION="/path/to/frameleaf/directory"       # Frameleaf media location, as set in your .env file
BACKUP_PATH="/path/to/local/backup/directory"

mkdir "$UPLOAD_LOCATION/database-backup"
borg init --encryption=none "$BACKUP_PATH/frameleaf-borg"

## Remote set up
REMOTE_HOST="remote_host@IP"
REMOTE_BACKUP_PATH="/path/to/remote/backup/directory"

borg init --encryption=none "$REMOTE_HOST:$REMOTE_BACKUP_PATH/frameleaf-borg"
```

Edit the following script as necessary and add it to your crontab. Note that this script assumes there are no `:`, `@`, or `"` characters in your paths. If these characters exist, you will need to escape and/or rename the paths.

```bash title='Borg backup template'
#!/bin/bash
set -euo pipefail
umask 077

# Paths
UPLOAD_LOCATION="/path/to/frameleaf/directory"
BACKUP_PATH="/path/to/local/backup/directory"
REMOTE_HOST="remote_host@IP"
REMOTE_BACKUP_PATH="/path/to/remote/backup/directory"
DB_DATABASE_NAME="frameleaf" # Match the canonical database in your release .env
DB_USERNAME="postgres"     # Match the configured database user


### Local

# Run from the release Compose directory with all writers stopped.
# The owned database container supplies PostgreSQL 19 pg_dump.
backup_tmp=$(mktemp "$UPLOAD_LOCATION/database-backup/.frameleaf-database.sql.XXXXXX")
trap 'rm -f "$backup_tmp"' EXIT
docker compose exec -T database pg_dump --clean --if-exists --no-owner --no-acl --dbname="$DB_DATABASE_NAME" --username="$DB_USERNAME" > "$backup_tmp"
mv "$backup_tmp" "$UPLOAD_LOCATION/database-backup/frameleaf-database.sql"
# Borg and Restic can deduplicate the uncompressed SQL. For a compressed dump,
# adapt the same temporary-file/rename sequence and retain pipeline failure handling.

### Append to local Borg repository
borg create "$BACKUP_PATH/frameleaf-borg::{now}" "$UPLOAD_LOCATION"
borg prune --keep-weekly=4 --keep-monthly=3 "$BACKUP_PATH"/frameleaf-borg
borg compact "$BACKUP_PATH"/frameleaf-borg


### Append to remote Borg repository
borg create "$REMOTE_HOST:$REMOTE_BACKUP_PATH/frameleaf-borg::{now}" "$UPLOAD_LOCATION"
borg prune --keep-weekly=4 --keep-monthly=3 "$REMOTE_HOST:$REMOTE_BACKUP_PATH"/frameleaf-borg
borg compact "$REMOTE_HOST:$REMOTE_BACKUP_PATH"/frameleaf-borg
```

### Restoring

To restore from a backup, use the `borg mount` command.

```bash title='Restore from local backup'
BACKUP_PATH="/path/to/local/backup/directory"
mkdir /tmp/frameleaf-mountpoint
borg mount "$BACKUP_PATH"/frameleaf-borg /tmp/frameleaf-mountpoint
cd /tmp/frameleaf-mountpoint
```

```bash title='Restore from remote backup'
REMOTE_HOST="remote_host@IP"
REMOTE_BACKUP_PATH="/path/to/remote/backup/directory"
mkdir /tmp/frameleaf-mountpoint
borg mount "$REMOTE_HOST:$REMOTE_BACKUP_PATH"/frameleaf-borg /tmp/frameleaf-mountpoint
cd /tmp/frameleaf-mountpoint
```

You can find available snapshots in separate sub-directories at `/tmp/frameleaf-mountpoint`. Use the matching database and media recovery point with the [Frameleaf restore procedure](/administration/backup-and-restore#restore), including transient-state reset before writers resume. Unmount the Borg repository using `borg umount /tmp/frameleaf-mountpoint`.
