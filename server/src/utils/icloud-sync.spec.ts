import { randomBytes } from 'node:crypto';
import { ChecksumAlgorithm } from 'src/enum.js';
import {
  decryptICloudSession,
  encryptICloudSession,
  isWithinDirectory,
  matchesContentHash,
} from 'src/utils/icloud-sync.js';

describe('iCloud trust boundaries', () => {
  it('binds encrypted sessions to their connection and rejects tampering', () => {
    const key = randomBytes(32);
    const stored = encryptICloudSession(key, 'connection-a', { cookie: 'private' });
    expect(stored).not.toContain('private');
    expect(decryptICloudSession(key, 'connection-a', stored)).toEqual({ cookie: 'private' });
    expect(() => decryptICloudSession(key, 'connection-b', stored)).toThrow('icloud_session_invalid');
    const changed = Buffer.from(stored, 'base64');
    changed[30] ^= 1;
    expect(() => decryptICloudSession(key, 'connection-a', changed.toString('base64'))).toThrow(
      'icloud_session_invalid',
    );
    expect(() => encryptICloudSession(Buffer.alloc(0), 'connection-a', {})).toThrow('icloud_key_invalid');
  });
  it('does not confuse sibling directories or path hashes with content identity', () => {
    expect(isWithinDirectory('/data/staging-other/a', '/data/staging')).toBe(false);
    expect(isWithinDirectory('/data/staging/../secret', '/data/staging')).toBe(false);
    expect(isWithinDirectory('/data/staging/a', '/data/staging')).toBe(true);
    const sha1 = Buffer.alloc(20, 1),
      sha256 = Buffer.alloc(32, 2);
    expect(
      matchesContentHash({ checksum: sha1, checksumAlgorithm: ChecksumAlgorithm.sha1Path }, { sha1, sha256 }),
    ).toBe(false);
    expect(
      matchesContentHash({ checksum: sha1, checksumAlgorithm: ChecksumAlgorithm.sha1File }, { sha1, sha256 }),
    ).toBe(true);
    expect(
      matchesContentHash({ checksum: sha256, checksumAlgorithm: ChecksumAlgorithm.sha256File }, { sha1, sha256 }),
    ).toBe(true);
  });
});
