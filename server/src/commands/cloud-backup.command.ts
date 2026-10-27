import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import { readFile } from 'node:fs/promises';
import { CloudBackupBareMetalRestore, CloudBackupService } from 'src/services/cloud-backup.service.js';
import { DatabaseService } from 'src/services/database.service.js';
import { writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { addClientBackupKeys, parseClientBackupKeys, rotateClientBackupKeys } from 'src/utils/cloud-backup-crypto.js';
import { unwrapBucketKey } from 'src/utils/cloud-backup-escrow.js';
import {
  backupRecoveryHistorySchema,
  mergeBackupHistory,
  unwrapBackupRecoveryKit,
} from 'src/utils/cloud-backup-recovery.js';
import { parseBackupKey } from 'src/utils/cloud-backup.js';
import { keyEscrowBlobSchema } from 'src/utils/frameleaf-cloud-backup.js';

/** Secrets come from the environment, never from the command line, so they stay out of shell history. */
export const CLOUD_BACKUP_SECRET_ENV = 'FRAMELEAF_BACKUP_SECRET_ACCESS_KEY';
export const CLOUD_BACKUP_ESCROW_PASSPHRASE_ENV = 'FRAMELEAF_BACKUP_ESCROW_PASSPHRASE';

type RestoreOptions = {
  bucket?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  keyFile?: string;
  escrowFile?: string;
  manifest?: string;
  scope?: string;
  restoreDatabase?: boolean;
  offlineDirectory?: string;
  exportDirectory?: string;
  historyFile?: string;
  managed?: boolean;
};

const SCOPES = new Set<CloudBackupBareMetalRestore['scope']>(['library', 'files', 'database']);

/**
 * `frameleaf-admin cloud-backup restore` (FL-164): bring a server back from its cloud backup bucket on bare
 * metal, without the web app. The bucket key comes from the key file (or a file holding the recovery
 * code), or from an escrow copy downloaded from the Frameleaf account and its passphrase.
 */
@SubCommand({
  name: 'restore',
  description: 'Restore this server’s files and database from its cloud backup bucket, without the web app',
})
export class CloudBackupRestoreCommand extends CommandRunner {
  constructor(
    private readonly service: CloudBackupService,
    private readonly databaseService: DatabaseService,
  ) {
    super();
  }

  @Option({ flags: '--bucket <name>', description: 'The backup bucket (required)' })
  parseBucket(value: string): string {
    return value;
  }

  @Option({
    flags: '--endpoint <url>',
    description: 'The storage address, for example https://s3.eu-central-2.storage.example',
  })
  parseEndpoint(value: string): string {
    return value;
  }

  @Option({ flags: '--region <region>', description: 'The region; read from the storage address when left out' })
  parseRegion(value: string): string {
    return value;
  }

  @Option({
    flags: '--access-key-id <id>',
    description: `The access key ID; its secret is read from ${CLOUD_BACKUP_SECRET_ENV}`,
  })
  parseAccessKeyId(value: string): string {
    return value;
  }

  @Option({ flags: '--key-file <path>', description: 'The backup key file, or a file holding the recovery code' })
  parseKeyFile(value: string): string {
    return value;
  }

  @Option({
    flags: '--escrow-file <path>',
    description:
      'A key copy from your Frameleaf account; its passphrase is read from FRAMELEAF_BACKUP_ESCROW_PASSPHRASE',
  })
  parseEscrowFile(value: string): string {
    return value;
  }

  @Option({
    flags: '--manifest <key>',
    description: 'The backup to restore, m/<time>.json.gz; the newest when left out',
  })
  parseManifest(value: string): string {
    return value;
  }

  @Option({
    flags: '--scope <scope>',
    description: 'library: files in place and the database dump; files: into a restore folder; database: the dump only',
    defaultValue: 'library',
  })
  parseScope(value: string): string {
    return value;
  }

  @Option({
    flags: '--restore-database',
    description: 'Also restore the database from the dump, as the maintenance restore does (replaces the current one)',
  })
  parseRestoreDatabase(): boolean {
    return true;
  }

  @Option({
    flags: '--offline-directory <path>',
    description: 'Restore from a complete local export without storage credentials or a cloud account',
  })
  parseOfflineDirectory(value: string) {
    return value;
  }

  @Option({
    flags: '--export-directory <path>',
    description: 'Export the selected backup and recovery kit to a new local directory instead of restoring',
  })
  parseExportDirectory(value: string) {
    return value;
  }

  @Option({ flags: '--managed', description: 'Export this linked server’s managed backup using renewable read access' })
  parseManaged() {
    return true;
  }

  @Option({
    flags: '--history-file <path>',
    description: 'Locally trusted signed snapshot history to include in the recovery kit',
  })
  parseHistoryFile(value: string) {
    return value;
  }

  async run(passedParams: string[], options: RestoreOptions = {}): Promise<void> {
    if (passedParams.length > 0) {
      throw new Error('cloud-backup restore takes named options only');
    }
    const restore = await restoreRequest(options, process.env);
    if (options.exportDirectory) {
      const exported = await this.service.exportFromBucket(restore, options.exportDirectory);
      process.stdout.write(
        `Exported ${exported.objects} objects from ${exported.manifestKey}. Keep the key file and export privately on another device.\n`,
      );
      return;
    }
    parseBackupKey(restore.key);
    await this.databaseService.initialize();
    const result = await this.service.restoreFromBucket(restore, (line) => process.stdout.write(`${line}\n`));
    const dump = result.databaseFile
      ? `The database dump is ${result.databaseFile} in the backups folder: restore it from the maintenance restore, or run this again with --restore-database.`
      : null;
    const lines = [
      `Restored ${result.files} files from ${result.manifestKey}.`,
      result.destination ? `Files are in ${result.destination}.` : null,
      result.databaseRestored ? 'The database was restored. Start the server, then set cloud backup up again.' : dump,
    ];
    process.stdout.write(`${lines.filter(Boolean).join('\n')}\n`);
  }
}

/** The restore the options and environment ask for; refused, with what is missing, before anything is read. */
export const restoreRequest = async (
  options: RestoreOptions,
  env: Record<string, string | undefined>,
): Promise<CloudBackupBareMetalRestore> => {
  if (
    options.managed &&
    (!options.exportDirectory ||
      options.restoreDatabase ||
      options.offlineDirectory ||
      options.bucket ||
      options.endpoint ||
      options.accessKeyId ||
      options.region)
  ) {
    throw new Error(
      'Managed mode only exports this server’s configured backup; do not combine it with storage or restore options.',
    );
  }
  if (!options.managed && !options.offlineDirectory && (!options.bucket || !options.endpoint || !options.accessKeyId)) {
    throw new Error(
      'Give the bucket, its storage address and its access key ID (--bucket, --endpoint, --access-key-id).',
    );
  }
  const secretAccessKey = env[CLOUD_BACKUP_SECRET_ENV];
  if (!options.managed && !options.offlineDirectory && !secretAccessKey) {
    throw new Error(`Set ${CLOUD_BACKUP_SECRET_ENV} to the bucket’s secret access key.`);
  }
  if (!!options.keyFile === !!options.escrowFile) {
    throw new Error('Give the key with either --key-file or --escrow-file.');
  }
  const scope = (options.scope ?? 'library') as CloudBackupBareMetalRestore['scope'];
  if (!SCOPES.has(scope)) {
    throw new Error('--scope is library, files or database.');
  }

  let key: string;
  if (options.keyFile) {
    key = await readFile(options.keyFile, 'utf8');
  } else {
    const passphrase = env[CLOUD_BACKUP_ESCROW_PASSPHRASE_ENV];
    if (!passphrase) {
      throw new Error(`Set ${CLOUD_BACKUP_ESCROW_PASSPHRASE_ENV} to the escrow passphrase.`);
    }
    // a stored record carries its time as well; only the blob is read
    const stored = JSON.parse(await readFile(options.escrowFile!, 'utf8')) as Record<string, unknown>;
    const { updatedAt: _updatedAt, ...blob } = stored;
    key =
      blob.version === 2
        ? await unwrapBackupRecoveryKit(blob, passphrase)
        : (await unwrapBucketKey(keyEscrowBlobSchema.parse(blob), passphrase)).toString('base64');
  }

  const file = key.trimStart().startsWith('{')
    ? (JSON.parse(key) as { bucket?: string; instanceId?: string; client?: { vaultId?: string }; recovery?: unknown })
    : {};
  if (options.historyFile) {
    const history = backupRecoveryHistorySchema.parse(JSON.parse(await readFile(options.historyFile, 'utf8')));
    if (file.instanceId !== history.anchor.instanceId || file.client?.vaultId !== history.anchor.vaultId)
      throw new Error('The trusted history does not belong to this client key file');
    const recovery = mergeBackupHistory(
      file.recovery ? backupRecoveryHistorySchema.parse(file.recovery) : null,
      history,
    );
    key = JSON.stringify({ ...file, recovery });
  }
  if (options.offlineDirectory && !options.bucket && !file.bucket)
    throw new Error('The offline key file must name its bucket, or give --bucket');
  if (options.managed) {
    return { managed: true, key, manifestKey: options.manifest, scope, restoreDatabase: false };
  }
  return {
    s3: {
      endpoint: options.endpoint ?? 'https://offline.invalid',
      region: options.region ?? '',
      bucket: options.bucket ?? file.bucket!,
      accessKeyId: options.accessKeyId ?? '',
      secretAccessKey: secretAccessKey ?? '',
    },
    key,
    manifestKey: options.manifest,
    scope,
    restoreDatabase: options.restoreDatabase === true,
    ...(options.offlineDirectory && { offlineDirectory: options.offlineDirectory }),
  };
};

/** Prepare/rotate only a local recovery file; no storage or cloud call is made. */
@SubCommand({
  name: 'prepare-client-key',
  description: 'Add independent client roots to a backup key file; keep the legacy key for old snapshots',
})
export class CloudBackupPrepareKeyCommand extends CommandRunner {
  @Option({ flags: '--key-file <path>', description: 'The existing backup key file' })
  parseKeyFile(value: string) {
    return value;
  }
  @Option({ flags: '--output-file <path>', description: 'A new recovery key file (never overwrites an existing file)' })
  parseOutputFile(value: string) {
    return value;
  }
  @Option({ flags: '--rotate', description: 'Retain historical roots and generate a new independent write root' })
  parseRotate() {
    return true;
  }
  async run(parameters: string[], options: { keyFile?: string; outputFile?: string; rotate?: boolean } = {}) {
    if (parameters.length > 0 || !options.keyFile || !options.outputFile)
      throw new Error('Give --key-file and a new --output-file');
    const content = await readFile(options.keyFile, 'utf8');
    const legacy = parseBackupKey(content);
    const file = JSON.parse(content) as { key: string; instanceId: string; client?: unknown };
    const ring = parseClientBackupKeys(file.client, legacy, file.instanceId);
    if (ring && !options.rotate) throw new Error('This key file already has client roots; use --rotate for a new root');
    if (!ring && options.rotate) throw new Error('Prepare a client key file before rotating it');
    const prepared = ring ? { ...file, client: rotateClientBackupKeys(ring, legacy) } : addClientBackupKeys(file);
    parseClientBackupKeys(prepared.client, legacy, file.instanceId);
    await writeBuddyFile(options.outputFile, JSON.stringify(prepared, null, 2), true);
    process.stdout.write(
      'Prepared an independent client recovery key file. Keep a copy away from this server before using it.\n',
    );
  }
}

@Command({
  name: 'cloud-backup',
  description: 'Frameleaf Cloud backup: restore a server from its bucket',
  subCommands: [CloudBackupRestoreCommand, CloudBackupPrepareKeyCommand],
})
export class CloudBackupCommand extends CommandRunner {
  run(): Promise<void> {
    this.command.outputHelp();
    return Promise.resolve();
  }
}

export const cloudBackupCommands = CloudBackupCommand.registerWithSubCommands();
