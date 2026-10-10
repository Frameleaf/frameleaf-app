import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLOUD_BACKUP_ESCROW_PASSPHRASE_ENV,
  CLOUD_BACKUP_SECRET_ENV,
  CloudBackupCommand,
  CloudBackupRestoreCommand,
  restoreRequest,
} from 'src/commands/cloud-backup.command.js';
import { commandsAndQuestions } from 'src/commands/index.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import { wrapBucketKey } from 'src/utils/cloud-backup-escrow.js';

/** Each escrow open or wrap runs the real scrypt (N = 2^17, 128 MiB); a busy runner needs more than 5 s. */
const SCRYPT_TEST_TIMEOUT_MS = 30_000;

const key = Buffer.alloc(32, 7);
const options = {
  bucket: 'family-backup',
  endpoint: 'https://s3.eu-central-2.storage.example',
  accessKeyId: 'AKIAEXAMPLE',
};

describe('cloud-backup CLI (FL-164)', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cloud-backup-command-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('is registered in the admin CLI', () => {
    expect(commandsAndQuestions).toEqual(expect.arrayContaining([CloudBackupCommand, CloudBackupRestoreCommand]));
  });

  it('reads the key file and the secret from the environment, never from the command line', async () => {
    const keyFile = join(directory, 'key.json');
    await writeFile(keyFile, JSON.stringify({ format: 'frameleaf-backup-key', key: key.toString('base64') }));

    const request = await restoreRequest({ ...options, keyFile }, { [CLOUD_BACKUP_SECRET_ENV]: 'secret' });

    expect(request).toEqual({
      s3: { ...options, region: '', secretAccessKey: 'secret' },
      key: JSON.stringify({ format: 'frameleaf-backup-key', key: key.toString('base64') }),
      manifestKey: undefined,
      scope: 'library',
      restoreDatabase: false,
    });
  });

  it('opens an escrow copy with the passphrase from the environment', { timeout: SCRYPT_TEST_TIMEOUT_MS }, async () => {
    const passphrase = 'correct horse battery staple';
    const escrowFile = join(directory, 'escrow.json');
    await writeFile(
      escrowFile,
      JSON.stringify({ ...(await wrapBucketKey(key, passphrase)), updatedAt: '2026-09-26T00:00:00.000Z' }),
    );

    const request = await restoreRequest(
      { ...options, escrowFile, scope: 'database' },
      { [CLOUD_BACKUP_SECRET_ENV]: 'secret', [CLOUD_BACKUP_ESCROW_PASSPHRASE_ENV]: passphrase },
    );

    expect(request.key).toBe(key.toString('base64'));
    expect(request.scope).toBe('database');
  });

  it('refuses before reading anything when something it needs is missing', async () => {
    const env = { [CLOUD_BACKUP_SECRET_ENV]: 'secret' };

    await expect(restoreRequest({ ...options, bucket: undefined, keyFile: 'k' }, env)).rejects.toThrow('--bucket');
    await expect(restoreRequest({ ...options, keyFile: 'k' }, {})).rejects.toThrow(CLOUD_BACKUP_SECRET_ENV);
    await expect(restoreRequest(options, env)).rejects.toThrow('--key-file or --escrow-file');
    await expect(restoreRequest({ ...options, keyFile: 'k', escrowFile: 'e' }, env)).rejects.toThrow('either');
    await expect(restoreRequest({ ...options, keyFile: 'k', scope: 'everything' }, env)).rejects.toThrow('--scope');
    await expect(restoreRequest({ ...options, escrowFile: 'e' }, env)).rejects.toThrow(
      CLOUD_BACKUP_ESCROW_PASSPHRASE_ENV,
    );
  });

  it('restores through the service and says where the dump is', async () => {
    const keyFile = join(directory, 'key.txt');
    await writeFile(keyFile, key.toString('base64'));
    vi.stubEnv(CLOUD_BACKUP_SECRET_ENV, 'secret');
    const service = {
      restoreFromBucket: vi.fn().mockResolvedValue({
        files: 3,
        manifestKey: 'm/20260926T030000Z.json.gz',
        destination: null,
        databaseFile: 'cloud-restore-immich-db-backup-1.sql.gz',
        databaseRestored: false,
      }),
    } as unknown as CloudBackupService;
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await new CloudBackupRestoreCommand(service).run([], { ...options, keyFile, restoreDatabase: false });

    expect(service.restoreFromBucket).toHaveBeenCalledWith(
      expect.objectContaining({ key: key.toString('base64'), scope: 'library', restoreDatabase: false }),
      expect.any(Function),
    );
    expect(output).toHaveBeenCalledWith(expect.stringContaining('cloud-restore-immich-db-backup-1.sql.gz'));
    vi.unstubAllEnvs();
  });

  it('takes named options only', async () => {
    await expect(new CloudBackupRestoreCommand({} as CloudBackupService).run(['family-backup'])).rejects.toThrow(
      'named options only',
    );
  });
});
