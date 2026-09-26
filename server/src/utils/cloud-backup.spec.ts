import { randomBytes } from 'node:crypto';
import {
  backupKeyFile,
  compactIso,
  keyFingerprint,
  manifestKey,
  parseBackupKey,
  parseRunResult,
  recoveryCode,
  s3SettingsProblem,
  signingRegion,
} from 'src/utils/cloud-backup.js';

describe('cloud backup helpers (FL-160)', () => {
  it('reads a key from its key file, its base64 or its recovery code, and nothing else', () => {
    for (let i = 0; i < 50; i++) {
      const key = randomBytes(32);
      const file = JSON.stringify(
        backupKeyFile({ key, instanceId: 'instance-1', bucket: 'b', mode: 'server', createdAt: new Date() }),
      );
      expect(parseBackupKey(recoveryCode(key))).toEqual(key);
      expect(parseBackupKey(key.toString('base64'))).toEqual(key);
      expect(parseBackupKey(file)).toEqual(key);
    }
    expect(() => parseBackupKey('not a key')).toThrow();
    expect(() => parseBackupKey('FLRK-0000')).toThrow('not complete');
    expect(() => parseBackupKey(JSON.stringify({ format: 'other', key: 'x' }))).toThrow(
      'not a Frameleaf backup key file',
    );
  });

  it('fingerprints a key the way the prototype and the browser do', () => {
    expect(keyFingerprint(Buffer.alloc(32))).toBe('0B2A-E445');
  });

  it('names manifests by time in ISO 8601 basic format', () => {
    expect(compactIso(new Date('2026-09-26T03:00:00.123Z'))).toBe('20260926T030000Z');
    expect(manifestKey(new Date('2026-09-26T03:00:00Z'))).toBe('m/20260926T030000Z.json.gz');
  });

  it('reads the signing region from regional, dual-stack and virtual-hosted addresses', () => {
    expect(signingRegion('https://s3.eu-central-2.wasabisys.com', '')).toBe('eu-central-2');
    expect(signingRegion('https://s3-eu-west-1.amazonaws.com', '')).toBe('eu-west-1');
    expect(signingRegion('https://s3.dualstack.us-west-2.amazonaws.com', '')).toBe('us-west-2');
    expect(signingRegion('https://bucket.s3.dualstack.eu-west-1.amazonaws.com', '')).toBe('eu-west-1');
    expect(signingRegion('https://s3.amazonaws.com', '')).toBe('us-east-1');
    expect(signingRegion('https://minio.local:9000', '')).toBe('us-east-1');
    expect(signingRegion('https://s3.eu-central-2.wasabisys.com', 'eu-west-9')).toBe('eu-west-9');
  });

  it('asks for HTTPS, a valid bucket name and both keys', () => {
    const valid = {
      endpoint: 'https://s3.example.test',
      bucket: 'family-backup',
      accessKeyId: 'a',
      secretAccessKey: 'b',
    };
    expect(s3SettingsProblem(valid)).toBeNull();
    expect(s3SettingsProblem({ ...valid, endpoint: 'http://s3.example.test' })).toContain('HTTPS');
    expect(s3SettingsProblem({ ...valid, bucket: 'Family' })).toContain('Bucket names');
    expect(s3SettingsProblem({ ...valid, secretAccessKey: '' })).toContain('secret access key');
  });

  it('reads a run result back, starting over from anything malformed', () => {
    expect(parseRunResult(null)).toMatchObject({ phase: 'database', manifestId: null, cursor: null });
    expect(parseRunResult({ phase: 'nonsense', uploaded: -3 })).toMatchObject({ phase: 'database', uploaded: 0 });
    expect(parseRunResult({ phase: 'assets', cursor: 'asset-1', total: 10 })).toMatchObject({
      phase: 'assets',
      cursor: 'asset-1',
      total: 10,
    });
  });
});
