import { CloudBackupKeyMode } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  backupKeyFile,
  bucketSettingsErrors,
  createBackupKey,
  endpointHost,
  isOwnMemoryAcknowledged,
  keyFingerprint,
  readBackupKeyFile,
} from '$lib/frameleaf/cloud-backup';

const fixed = {
  getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
    if (array) {
      new Uint8Array(array.buffer).fill(7);
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
        endpoint: 'https://s3.eu-central-2.wasabisys.com',
        bucket: 'family-backup',
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
      }),
    ).toEqual({});
    expect(
      bucketSettingsErrors({
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
    expect(endpointHost('https://s3.eu-central-2.wasabisys.com/')).toBe('s3.eu-central-2.wasabisys.com');
  });
});
