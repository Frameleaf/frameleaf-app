import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import { readFile } from 'node:fs/promises';
import { CloudBackupBareMetalRestore, CloudBackupService } from 'src/services/cloud-backup.service.js';
import { unwrapBucketKey } from 'src/utils/cloud-backup-escrow.js';
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
  constructor(private readonly service: CloudBackupService) {
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

  async run(passedParams: string[], options: RestoreOptions = {}): Promise<void> {
    if (passedParams.length > 0) {
      throw new Error('cloud-backup restore takes named options only');
    }
    const restore = await restoreRequest(options, process.env);
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
  if (!options.bucket || !options.endpoint || !options.accessKeyId) {
    throw new Error(
      'Give the bucket, its storage address and its access key ID (--bucket, --endpoint, --access-key-id).',
    );
  }
  const secretAccessKey = env[CLOUD_BACKUP_SECRET_ENV];
  if (!secretAccessKey) {
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
    key = (await unwrapBucketKey(keyEscrowBlobSchema.parse(blob), passphrase)).toString('base64');
  }

  return {
    s3: {
      endpoint: options.endpoint,
      region: options.region ?? '',
      bucket: options.bucket,
      accessKeyId: options.accessKeyId,
      secretAccessKey,
    },
    key,
    manifestKey: options.manifest,
    scope,
    restoreDatabase: options.restoreDatabase === true,
  };
};

@Command({
  name: 'cloud-backup',
  description: 'Frameleaf Cloud backup: restore a server from its bucket',
  subCommands: [CloudBackupRestoreCommand],
})
export class CloudBackupCommand extends CommandRunner {
  run(): Promise<void> {
    this.command.outputHelp();
    return Promise.resolve();
  }
}

export const cloudBackupCommands = CloudBackupCommand.registerWithSubCommands();
