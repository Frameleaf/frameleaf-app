import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLOUD_BACKUP_ESCROW_PASSPHRASE_ENV,
  CLOUD_BACKUP_SECRET_ENV,
  CloudBackupCommand,
  CloudBackupPrepareKeyCommand,
  CloudBackupRestoreCommand,
  restoreRequest,
} from 'src/commands/cloud-backup.command.js';
import { commandsAndQuestions } from 'src/commands/index.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import { addClientBackupKeys } from 'src/utils/cloud-backup-crypto.js';
import { wrapBucketKey } from 'src/utils/cloud-backup-escrow.js';
import { appendBackupSnapshot, signBackupSnapshot } from 'src/utils/cloud-backup-recovery.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

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
    expect(commandsAndQuestions).toEqual(
      expect.arrayContaining([CloudBackupCommand, CloudBackupRestoreCommand, CloudBackupPrepareKeyCommand]),
    );
  });

  it('prepares and rotates an independent recovery key file without overwriting a file or requiring cloud access', async () => {
    const original = {
      format: 'frameleaf-backup-key',
      key: key.toString('base64'),
      bucket: 'family-backup',
      instanceId: 'f0000000-0000-4000-8000-000000000001',
    };
    const keyFile = join(directory, 'original.json');
    const outputFile = join(directory, 'client.json');
    const rotated = join(directory, 'rotated.json');
    await writeFile(keyFile, JSON.stringify(original));
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const command = new CloudBackupPrepareKeyCommand();
    await command.run([], { keyFile, outputFile });
    const first = JSON.parse(await readFile(outputFile, 'utf8'));
    expect(first.key).toBe(original.key);
    expect(first.client.keys[1]).not.toBe(original.key);
    expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
    await expect(command.run([], { keyFile, outputFile })).rejects.toThrow();
    await command.run([], { keyFile: outputFile, outputFile: rotated, rotate: true });
    const second = JSON.parse(await readFile(rotated, 'utf8'));
    expect(second.client.keys[1]).toBe(first.client.keys[1]);
    expect(second.client.current).toBe(2);
    const request = await restoreRequest({ keyFile: rotated, offlineDirectory: directory }, {});
    expect(request.s3).toMatchObject({ bucket: 'family-backup', accessKeyId: '', secretAccessKey: '' });
    expect(request.offlineDirectory).toBe(directory);
  });

  it('imports a separately pinned history for independent export and rejects a corrupted anchor', async () => {
    const vaultId = 'f0000000-0000-4000-8000-000000000001';
    const pair = generateKeyPairSync('ed25519');
    const jwk = pair.publicKey.export({ format: 'jwk' });
    const publicJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: jwk.x! };
    const kid = ed25519Thumbprint(publicJwk);
    const record = signBackupSnapshot(
      {
        version: 2,
        instanceId: vaultId,
        vaultId,
        snapshotId: 'f0000000-0000-4000-8000-000000000002',
        sequence: 1,
        previousDigest: null,
        createdAt: '2026-10-11T00:00:00.000Z',
        signerKid: kid,
        manifest: {
          format: 'frameleaf-client-backup',
          formatVersion: 1,
          keyVersion: 1,
          objectKey: `m/v1/${vaultId}/1/20261011T000001Z.json.gz`,
          versionId: 'provider-version',
          ciphertextSha256: 'a'.repeat(64),
        },
      },
      { kid, publicJwk, sign: () => '', signBytes: (bytes) => sign(null, bytes, pair.privateKey) },
    );
    const history = appendBackupSnapshot(null, record);
    const file = addClientBackupKeys({
      format: 'frameleaf-backup-key',
      key: key.toString('base64'),
      bucket: 'family-backup',
      instanceId: vaultId,
    });
    const keyFile = join(directory, 'client.json');
    const historyFile = join(directory, 'history.json');
    await writeFile(keyFile, JSON.stringify(file));
    await writeFile(historyFile, JSON.stringify(history));
    const request = await restoreRequest({ keyFile, historyFile, offlineDirectory: directory }, {});
    expect(JSON.parse(request.key).recovery.anchor).toEqual(history.anchor);
    await writeFile(historyFile, JSON.stringify({ ...history, anchor: { ...history.anchor, digest: 'f'.repeat(64) } }));
    await expect(restoreRequest({ keyFile, historyFile, offlineDirectory: directory }, {})).rejects.toThrow(
      'substitution',
    );
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
