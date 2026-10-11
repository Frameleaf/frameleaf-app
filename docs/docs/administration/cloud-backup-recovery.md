# Cloud Backup recovery and local export

Keep a recovery kit on another device. A replacement server needs the legacy bucket key, all client root-key versions used by retained backups, and a trusted snapshot history/anchor. Cloud Backup's default writes still use SSE-C; client-encrypted writes are an opt-in qualification feature. See [the format specification](../developer/cloud-backup-format.md).

## Prepare or rotate client keys

Start with the standard downloadable backup key file, containing its bucket and instance ID:

```bash
frameleaf-admin cloud-backup prepare-client-key \
  --key-file /private/backup-key.json \
  --output-file /private/client-backup-key.json
```

This creates an owner-only file with a fresh independent client root and the existing legacy key. Save a second copy before loading it through Cloud Backup setup, or through unlock in own-memory mode. Only then enable `FRAMELEAF_BACKUP_CLIENT_ENCRYPTION=1` on workers for qualification. Managed storage must also advertise compatible encrypted-object support; unsupported grants pause the operation.

For rotation, add `--rotate`, use the current complete key file as input, and choose a new output file. Every old root is retained; existing files are never overwritten. Load the complete new file through setup/unlock. New runs use its current root; interrupted runs keep their original version. Own-stored and own-memory keys are never escrowed. Own-memory roots must be loaded after every restart and are never saved by the service.

Legacy backups remain readable with the original key and need no bulk rewrite. Retain both keys and signed history across rotation; a root key alone does not establish which valid manifest is current.

## Export a complete restore point

Set `FRAMELEAF_BACKUP_SECRET_ACCESS_KEY` through your environment's secret configuration, then export with a read credential for the source bucket. Do not put secret values in command arguments. For your own S3 bucket:

```bash
frameleaf-admin cloud-backup restore \
  --bucket family-backup \
  --endpoint https://storage.example \
  --region us-east-1 \
  --access-key-id SYNTHETIC_ACCESS_KEY \
  --key-file /private/client-backup-key.json \
  --export-directory /private/frameleaf-export
```

The destination must be new. The export contains `key-file.json` with complete recovery authority and an `objects` directory. It includes the selected encrypted manifest, its media/generated-file references and database dump. Object filenames in the export are SHA-256 of the exact stored object key; the exported manifest maps them for recovery. Keep the entire directory privately; the key file can open its backup contents.

Client history selects the locally anchored head. Use `--manifest <exact-key>` only for an explicitly selected historical snapshot. A legacy export requires that option because legacy histories have no signed latest-snapshot authority. Export decrypts SSE-C transport locally; the legacy local export therefore contains plaintext file contents. Client-format objects remain ciphertext in the export. A missing or invalid reference stops a successful export.

If the key file does not already include `.recovery`, add `--history-file /private/cloud-backup-history.json` with the trusted history copied from the original server's private instance identity directory. Its filename is `cloud-backup-history-<SHA256 of bucketRef>.json`; managed buckets use the stable managed storage reference for this hash. Keep that file with the complete keyring. The command verifies signatures and the vault, and refuses a conflicting anchor. A file obtained only from an untrusted remote listing cannot establish the current snapshot.

An export requires source storage access while it is being created. After completion it needs neither storage credentials nor a working cloud account. Managed-storage reads require a compatible recovery capability and exact object-version access.

## Recover without networking

Copy the complete export to the replacement server. With its normal media and backup paths configured:

```bash
frameleaf-admin cloud-backup restore \
  --offline-directory /private/frameleaf-export \
  --key-file /private/frameleaf-export/key-file.json \
  --scope library
```

`library` restores files at safe paths and downloads the database dump into the backup folder. Existing different files are moved aside by the normal restore procedure. `files` restores into a separate restore folder; `database` restores the dump only. Every restored object is checked before publication. Offline exports are read-only, and missing/corrupt data fails the restore.

Inspect the dump and your replacement-server configuration before applying it. `--restore-database` invokes the existing database restore and replaces the current database. Follow [Backup and restore](./backup-and-restore.md) for database/media consistency, credentials, encryption keys and the disposable restore rehearsal. A restored dump file alone does not prove the running database is recoverable.

A passphrase-wrapped v1 or v2 account export can be supplied with `--escrow-file`; its passphrase is read from `FRAMELEAF_BACKUP_ESCROW_PASSPHRASE`. Only server-key mode creates escrow. The managed escrow size limit may require a local export for larger histories. Keep kits current: an older kit cannot prove that a later snapshot is the latest, even when its ciphertext is valid.
