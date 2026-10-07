import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ChecksumAlgorithm, JobName } from 'src/enum.js';
import { PhysicalFileTrashService } from 'src/services/physical-file-trash.service.js';
import { ASSET_CHECKSUM_CONSTRAINT } from 'src/utils/database.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const checksum = Buffer.from('c'.repeat(64), 'hex');
const entry = {
  id: 'trash-id',
  physicalFileId: 'physical-file-id',
  path: '/data/file-trash/physical-file-id/IMG_0001.jpg',
  checksum,
  sizeInBytes: 1234,
  lastOwnerId: 'owner-id',
  lastAssetId: 'old-asset-id',
  originalFileName: 'IMG_0001.jpg',
  trashedAt: new Date('2026-10-01T10:00:00.000Z'),
};

describe(PhysicalFileTrashService.name, () => {
  let sut: PhysicalFileTrashService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PhysicalFileTrashService));
  });

  describe('list', () => {
    it('lists entries with the total size held and the last owner’s name', async () => {
      mocks.physicalFileTrash.list.mockResolvedValue({ items: [entry], total: 1, totalBytes: 1234 });
      mocks.user.get.mockResolvedValue({ id: 'owner-id', name: 'Ada' } as never);

      await expect(sut.list({ page: 2, size: 50 })).resolves.toEqual({
        items: [
          {
            id: 'trash-id',
            originalFileName: 'IMG_0001.jpg',
            sizeInBytes: 1234,
            checksum: 'c'.repeat(64),
            lastOwnerId: 'owner-id',
            lastOwnerName: 'Ada',
            lastAssetId: 'old-asset-id',
            trashedAt: '2026-10-01T10:00:00.000Z',
          },
        ],
        total: 1,
        totalBytes: 1234,
      });
      expect(mocks.physicalFileTrash.list).toHaveBeenCalledWith({ skip: 50, take: 50 });
    });
  });

  describe('restore', () => {
    beforeEach(() => {
      mocks.physicalFileTrash.getById.mockResolvedValue(entry);
      mocks.physicalFileTrash.untrash.mockResolvedValue(entry);
      mocks.user.get.mockResolvedValue({ id: 'owner-id', name: 'Ada' } as never);
      mocks.storage.stat.mockResolvedValue({ mtime: new Date('2020-01-01T00:00:00.000Z') } as never);
      mocks.asset.create.mockResolvedValue({ id: 'new-asset-id', ownerId: 'owner-id' } as never);
    });

    it.each([
      [checksum, ChecksumAlgorithm.sha256File],
      [Buffer.from('c'.repeat(40), 'hex'), ChecksumAlgorithm.sha1File],
    ])('re-imports the file with its retained checksum algorithm (%s, %s)', async (checksum, checksumAlgorithm) => {
      mocks.physicalFileTrash.getById.mockResolvedValue({ ...entry, checksum });
      mocks.physicalFileTrash.untrash.mockResolvedValue({ ...entry, checksum });
      mocks.physicalFile.linkUploadedOriginal.mockResolvedValue({
        physicalFile: { id: 'new-physical' },
        linked: false,
      } as never);

      await expect(sut.restore('trash-id')).resolves.toEqual({ assetId: 'new-asset-id' });

      const target = mocks.physicalFileTrash.untrash.mock.calls[0][1];
      expect(target).toMatch(/^\/data\/upload\/owner-id\/.+\.jpg$/);
      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'owner-id',
          checksum,
          checksumAlgorithm,
          originalPath: target,
          originalFileName: 'IMG_0001.jpg',
        }),
      );
      expect(mocks.physicalFile.linkUploadedOriginal).toHaveBeenCalledWith(
        'new-asset-id',
        { checksum, sizeInBytes: 1234 },
        expect.anything(),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: 'new-asset-id', source: 'upload' },
      });
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AssetCreate',
        expect.objectContaining({ file: expect.objectContaining({ size: 1234 }) }),
      );
    });

    it('refuses when the last owner no longer exists', async () => {
      mocks.user.get.mockResolvedValue(void 0);

      await expect(sut.restore('trash-id')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.physicalFileTrash.untrash).not.toHaveBeenCalled();
    });

    it('is not found for an unknown entry', async () => {
      mocks.physicalFileTrash.getById.mockResolvedValue(void 0);

      await expect(sut.restore('trash-id')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('puts the file back in the trash when the library already holds it', async () => {
      const error = new Error('unique key violation');
      (error as any).constraint_name = ASSET_CHECKSUM_CONSTRAINT;
      mocks.asset.create.mockRejectedValue(error);

      await expect(sut.restore('trash-id')).rejects.toBeInstanceOf(ConflictException);

      const target = mocks.physicalFileTrash.untrash.mock.calls[0][1];
      expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledWith(target, expect.any(Function), {
        trash: { move: expect.any(Function), original: expect.objectContaining({ checksum, ownerId: 'owner-id' }) },
      });
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });
  });

  describe('purge', () => {
    it('unlinks the file and removes the entry', async () => {
      mocks.physicalFileTrash.purge.mockImplementation(async (_id, unlink) => {
        await unlink(entry.path);
        return entry;
      });

      await sut.purge('trash-id');

      expect(mocks.storage.unlink).toHaveBeenCalledWith(entry.path);
    });

    it('is not found for an unknown entry', async () => {
      mocks.physicalFileTrash.purge.mockResolvedValue(void 0);

      await expect(sut.purge('trash-id')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
