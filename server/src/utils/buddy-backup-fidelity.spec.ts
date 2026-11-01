import { createHash } from 'node:crypto';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import { readBuddyAssetFidelity } from 'src/utils/buddy-backup-fidelity.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const PLAIN = sha256('plaintext');
const CIPHER = sha256('ciphertext');
const ASSET = '00000000-0000-4000-8000-000000000001';
const OWNER = '00000000-0000-4000-8000-000000000002';

const manifestOf = (record: Record<string, unknown>) =>
  ({
    library: {
      assets: {
        [ASSET]: {
          owner: OWNER,
          files: [{ role: 'original', path: '/data/a.jpg', sha256: CIPHER, size: 10, mtime: null }],
          ...record,
        },
      },
    },
    contents: {},
    assetFidelity: {
      [ASSET]: {
        version: 1,
        assetId: ASSET,
        ownerId: OWNER,
        source: { checksum: PLAIN, checksumAlgorithm: 'sha256', sha256: CIPHER, type: 'IMAGE' },
        videoVersions: [],
        videoSelection: null,
        edits: [],
        developRevisions: [],
        artifacts: [],
        developExports: [],
        restorations: [],
        projection: [],
        files: [],
      },
    },
  }) as unknown as BuddyManifest;

describe('Buddy fidelity of an encrypted Locked original (FL-738)', () => {
  it('accepts a plaintext checksum that differs from the ciphertext when the snapshot records it as the item’s', () => {
    expect(readBuddyAssetFidelity(manifestOf({ checksum: PLAIN, checksumAlgorithm: 'sha256' }), ASSET)).toMatchObject({
      source: { checksum: PLAIN },
    });
  });

  it('still refuses a checksum that matches neither the file nor the item', () => {
    expect(() => readBuddyAssetFidelity(manifestOf({}), ASSET)).toThrow('Buddy version checksum binding changed');
    expect(() =>
      readBuddyAssetFidelity(manifestOf({ checksum: sha256('other'), checksumAlgorithm: 'sha256' }), ASSET),
    ).toThrow('Buddy version checksum binding changed');
  });
});
