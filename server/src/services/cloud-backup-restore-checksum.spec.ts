import { createHash } from 'node:crypto';
import { ChecksumAlgorithm } from 'src/enum.js';
import { CloudBackupDetailsService } from 'src/services/cloud-backup-details.service.js';
import { readBackupAssetRecord } from 'src/utils/cloud-backup-owner-restore.js';
import { type CloudBackupManifestAsset, backupRecordFor, readManifestAsset } from 'src/utils/cloud-backup.js';
import { type ServiceMocks, newTestService } from 'test/utils.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
const PLAIN = sha256('plaintext');
const CIPHER = sha256('ciphertext');

const backedUp = (extra: Record<string, unknown> = {}): CloudBackupManifestAsset =>
  ({
    owner: 'owner-1',
    files: [{ role: 'original', path: '/data/library/owner-1/a.jpg', sha256: CIPHER, size: 10, mtime: null }],
    type: 'IMAGE',
    originalFileName: 'a.jpg',
    fileCreatedAt: '2026-09-01T00:00:00.000Z',
    fileModifiedAt: '2026-09-01T00:00:00.000Z',
    localDateTime: '2026-09-01T00:00:00.000Z',
    duration: null,
    ...extra,
  }) as CloudBackupManifestAsset;

const recordOf = (asset: CloudBackupManifestAsset) => readBackupAssetRecord(readManifestAsset(asset) as never)!;

describe('a restored original keeps its item’s checksum (FL-738)', () => {
  let sut: CloudBackupDetailsService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(CloudBackupDetailsService));
    mocks.user.get.mockResolvedValue({ id: 'owner-1' } as never);
    mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(undefined);
  });

  const recreate = (asset: CloudBackupManifestAsset) =>
    sut.recreate({
      assetId: 'asset-1',
      ownerId: 'owner-1',
      record: recordOf(asset),
      details: undefined,
      sha256: CIPHER,
      size: 10,
      originalPath: '/data/library/owner-1/a.jpg',
      sidecarPath: null,
      people: {},
    });

  it('reads the recorded checksum back, and a backup without one or with a malformed one as before', () => {
    expect(recordOf(backedUp({ checksum: PLAIN, checksumAlgorithm: 'sha256' }))).toMatchObject({
      checksum: PLAIN,
      checksumAlgorithm: 'sha256',
    });
    for (const old of [
      backedUp(),
      backedUp({ checksum: 'not-hex', checksumAlgorithm: 'sha1-path' }),
      backedUp({ checksum: PLAIN, checksumAlgorithm: 'sha1' }),
    ]) {
      expect(readBackupAssetRecord(old)?.checksum).toBeUndefined();
      const record = recordOf(old);
      expect(record).toMatchObject({ originalFileName: 'a.jpg' });
      expect(record.checksum).toBeUndefined();
    }
  });

  it('keeps the checksum in a backup only for an encrypted original, so a changed plain file restores as itself', () => {
    const record = recordOf(backedUp({ checksum: PLAIN, checksumAlgorithm: 'sha256' }));
    expect(backupRecordFor(record, true)).toBe(record);
    const plain = backupRecordFor(record, false);
    expect(plain).toEqual({ ...record, checksum: undefined, checksumAlgorithm: undefined });
    expect(Object.keys(plain)).not.toContain('checksum');
  });

  it('gives an encrypted original the plaintext checksum the backup recorded, and finds a duplicate by it', async () => {
    await expect(recreate(backedUp({ checksum: PLAIN, checksumAlgorithm: 'sha256' }))).resolves.toEqual({
      status: 'created',
      assetId: 'asset-1',
    });
    expect(mocks.asset.getUploadAssetIdByChecksum).toHaveBeenCalledWith('owner-1', Buffer.from(PLAIN, 'hex'), {
      lockedOwnerId: 'owner-1',
    });
    expect(mocks.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({ checksum: Buffer.from(PLAIN, 'hex'), checksumAlgorithm: ChecksumAlgorithm.sha256File }),
      undefined,
    );
  });

  it('keeps a legacy SHA-1 item’s checksum', async () => {
    await recreate(backedUp({ checksum: sha1('plaintext'), checksumAlgorithm: 'sha1' }));
    expect(mocks.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        checksum: Buffer.from(sha1('plaintext'), 'hex'),
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
      }),
      undefined,
    );
  });

  it('falls back to the file’s SHA-256 for a backup made before checksums were recorded', async () => {
    await recreate(backedUp());
    expect(mocks.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        checksum: Buffer.from(CIPHER, 'hex'),
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
      }),
      undefined,
    );
  });
});
