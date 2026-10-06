import {
  CloudBackupKeyMode,
  CloudBackupRestoreScope,
  CloudBackupRunPhase,
  CloudBackupRunState,
  CloudBackupTask,
  type CloudBackupStatusResponseDto,
} from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  backupKeyFile,
  bucketSettingsErrors,
  cloudWorkActions,
  cloudWorkRows,
  createBackupKey,
  endpointHost,
  isEscrowPassphraseValid,
  isOwnMemoryAcknowledged,
  keyFingerprint,
  managedBucketName,
  readBackupKeyFile,
  retentionValue,
} from '$lib/frameleaf/cloud-backup';

const fixed = {
  getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
    if (array) {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
    }
    return array;
  },
} as Pick<Crypto, 'getRandomValues'>;

describe('cloud backup keys in the browser (FL-160)', () => {
  it('makes a 256-bit key with the fingerprint the server computes', () => {
    const key = createBackupKey(fixed);

    expect(atob(key.key)).toHaveLength(32);
    // the same FNV-1a fingerprint as server/src/utils/cloud-backup.ts for 32 bytes of 7
    expect(key.fingerprint).toBe(keyFingerprint(new Uint8Array(32).fill(7)));
    expect(key.fingerprint).toMatch(/^[\dA-F]{4}-[\dA-F]{4}$/);
    expect(createBackupKey().key).not.toBe(createBackupKey().key);
  });

  it('writes a key file that reads back, and refuses one for another bucket or not a key file', () => {
    const key = createBackupKey();
    const file = backupKeyFile({
      ...key,
      instanceId: 'instance-1',
      bucket: 'family-backup',
      mode: CloudBackupKeyMode.OwnMemory,
    });

    expect(JSON.parse(file)).toMatchObject({
      format: 'frameleaf-backup-key',
      mode: 'own-memory',
      fingerprint: key.fingerprint,
    });
    expect(readBackupKeyFile(file, key.fingerprint)).toEqual({ key: key.key });
    expect(readBackupKeyFile(file, 'AAAA-0000')).toEqual({ error: 'frameleaf_cloud_backup_key_file_other_bucket' });
    expect(readBackupKeyFile('not json')).toEqual({ error: 'frameleaf_cloud_backup_key_file_invalid' });
    expect(readBackupKeyFile(JSON.stringify({ format: 'something-else', key: key.key }))).toEqual({
      error: 'frameleaf_cloud_backup_key_file_invalid',
    });
  });

  it('asks for the typed acknowledgement without case or surrounding spaces', () => {
    expect(isOwnMemoryAcknowledged('  I Understand ')).toBe(true);
    expect(isOwnMemoryAcknowledged('I understood')).toBe(false);
  });

  it('checks your own bucket: HTTPS only, a valid bucket name and both keys', () => {
    expect(
      bucketSettingsErrors({
        endpoint: 'https://s3.eu-central-2.storage.example',
        bucket: 'family-backup',
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
      }),
    ).toEqual({});
    expect(
      bucketSettingsErrors({
        // eslint-disable-next-line unicorn/prefer-https -- an HTTP storage address is what is being refused
        endpoint: 'http://s3.example.test',
        bucket: 'Family',
        accessKeyId: ' ',
        secretAccessKey: '',
      }),
    ).toEqual({
      endpoint: 'frameleaf_cloud_backup_endpoint_https',
      bucket: 'frameleaf_cloud_backup_bucket_invalid',
      accessKeyId: 'frameleaf_cloud_backup_access_key_missing',
      secretAccessKey: 'frameleaf_cloud_backup_secret_missing',
    });
    expect(endpointHost('https://s3.eu-central-2.storage.example/')).toBe('s3.eu-central-2.storage.example');
  });
});

describe('cloud backup schedule, retention, escrow and activity (FL-164)', () => {
  const run = (overrides: Partial<NonNullable<CloudBackupStatusResponseDto['activeRun']>>) => ({
    operationId: 'run-1',
    task: CloudBackupTask.Backup,
    state: CloudBackupRunState.Running,
    phase: CloudBackupRunPhase.Assets,
    progress: 42,
    uploaded: 12,
    skipped: 300,
    bytesUploaded: 4_000_000,
    checked: 0,
    ...overrides,
  });
  const status = (overrides: Partial<CloudBackupStatusResponseDto>) =>
    ({ activeRun: null, activeRestore: null, ...overrides }) as CloudBackupStatusResponseDto;

  it('accepts retention values only as whole numbers within the server’s bounds', () => {
    expect(retentionValue('keepDaily', '7')).toBe(7);
    expect(retentionValue('keepDaily', '0')).toBeNull();
    expect(retentionValue('keepWeekly', '0')).toBe(0);
    expect(retentionValue('keepMonthly', '121')).toBeNull();
    expect(retentionValue('keepMonthly', '2.5')).toBeNull();
    expect(retentionValue('keepMonthly', '')).toBeNull();
  });

  it('names the managed bucket after the region and the instance', () => {
    expect(managedBucketName('na', 'id-1')).toBe('fl-na-id-1');
    expect(managedBucketName(null, 'id-1')).toBe('fl-eu-id-1');
  });

  it('needs an escrow passphrase of at least 12 characters, typed the same twice', () => {
    expect(isEscrowPassphraseValid('correct horse', 'correct horse')).toBe(true);
    expect(isEscrowPassphraseValid('short', 'short')).toBe(false);
    expect(isEscrowPassphraseValid('correct horse', 'correct house')).toBe(false);
  });

  it('shows a backup run in Activity as queued, starting, running or paused, with files and bytes', () => {
    expect(cloudWorkRows(status({ activeRun: run({ state: CloudBackupRunState.Queued, progress: 0 }) }))).toEqual([
      expect.objectContaining({ stage: 'queued', progress: null, titleKey: 'frameleaf_cloud_work_backup' }),
    ]);
    expect(cloudWorkRows(status({ activeRun: run({ progress: 0 }) }))[0].stage).toBe('starting');
    expect(cloudWorkRows(status({ activeRun: run({}) }))).toEqual([
      expect.objectContaining({ stage: 'running', progress: 42, files: { done: 12, total: null }, bytes: 4_000_000 }),
    ]);
    expect(cloudWorkRows(status({ activeRun: run({ state: CloudBackupRunState.Paused }) }))[0].stage).toBe('paused');
  });

  it('shows a check by the files it checked, and a restore by its files and bytes', () => {
    const rows = cloudWorkRows(
      status({
        activeRun: run({ task: CloudBackupTask.Verify, checked: 40 }),
        activeRestore: {
          operationId: 'restore-1',
          state: CloudBackupRunState.Running,
          scope: CloudBackupRestoreScope.Library,
          progress: 10,
          files: 5,
          filesTotal: 50,
          bytes: 1000,
          bytesTotal: 10_000,
        },
      }),
    );

    expect(rows).toEqual([
      expect.objectContaining({
        titleKey: 'frameleaf_cloud_work_verify',
        files: { done: 40, total: null },
        bytes: null,
      }),
      expect.objectContaining({
        titleKey: 'frameleaf_cloud_work_restore_library',
        files: { done: 5, total: 50 },
        bytes: 1000,
      }),
    ]);
    expect(cloudWorkRows(null)).toEqual([]);
  });
});

describe('cloudWorkActions (FL-164)', () => {
  it('offers what the server allows in each state', () => {
    expect(cloudWorkActions(CloudBackupRunState.Queued)).toEqual({ pause: true, resume: false, cancel: true });
    expect(cloudWorkActions(CloudBackupRunState.Running)).toEqual({ pause: true, resume: false, cancel: true });
    // resuming a run that is still pausing withdraws the pause
    expect(cloudWorkActions(CloudBackupRunState.Pausing)).toEqual({ pause: false, resume: true, cancel: true });
    expect(cloudWorkActions(CloudBackupRunState.Paused)).toEqual({ pause: false, resume: true, cancel: true });
    expect(cloudWorkActions(CloudBackupRunState.Cancelling)).toEqual({ pause: false, resume: false, cancel: false });
  });
});
