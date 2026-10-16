import { BadRequestException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { vitest } from 'vitest';
import { DownloadResponseDto } from 'src/dtos/download.dto.js';
import { UserMetadataKey } from 'src/enum.js';
import { DownloadService } from 'src/services/download.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

const downloadResponse: DownloadResponseDto = {
  totalSize: 105_000,
  archives: [
    {
      assetIds: ['asset-1', 'asset-2'],
      size: 105_000,
    },
  ],
};

describe(DownloadService.name, () => {
  let sut: DownloadService;
  let mocks: ServiceMocks;

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(DownloadService));
    mocks.partner.getAll.mockResolvedValue([]);
    mocks.downloadRepository.getSidecars.mockResolvedValue([]);
  });

  describe('downloadArchive', () => {
    it.each([true, false])(
      'uses the actual rendition extension for edited HEIC archive downloads: %s',
      async (edited) => {
        const archive = { addFile: vitest.fn(), finalize: vitest.fn(), stream: new Readable() };
        const asset = AssetFactory.create({ originalFileName: 'IMG_1.HEIC', originalPath: '/original.HEIC' });
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
        mocks.asset.getForOriginals.mockResolvedValue([{ ...asset, editedPath: '/edited.jpeg' }]);
        mocks.storage.createZipStream.mockReturnValue(archive);
        await sut.downloadArchive(authStub.admin, { assetIds: [asset.id], edited });
        expect(archive.addFile).toHaveBeenCalledWith(
          edited ? '/edited.jpeg' : '/original.HEIC',
          edited ? 'IMG_1.jpeg' : 'IMG_1.HEIC',
        );
      },
    );

    it('should skip asset ids that could not be found', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const asset = AssetFactory.create();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id, 'unknown-asset']));
      mocks.asset.getForOriginals.mockResolvedValue([asset]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset.id, 'unknown-asset'] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledTimes(1);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, asset.originalPath, asset.originalFileName);
    });

    it('should log a warning if the original path could not be resolved', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };

      const asset1 = AssetFactory.create();
      const asset2 = AssetFactory.create();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id]));
      mocks.storage.realpath.mockRejectedValue(new Error('Could not read file'));
      mocks.asset.getForOriginals.mockResolvedValue([asset1, asset2]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset1.id, asset2.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
      expect(archiveMock.addFile).toHaveBeenCalledTimes(2);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, asset1.originalPath, asset1.originalFileName);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(2, asset2.originalPath, asset2.originalFileName);
    });

    it('should download an archive', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };

      const asset1 = AssetFactory.create();
      const asset2 = AssetFactory.create();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id]));
      mocks.asset.getForOriginals.mockResolvedValue([asset1, asset2]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset1.id, asset2.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledTimes(2);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, asset1.originalPath, asset1.originalFileName);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(2, asset2.originalPath, asset2.originalFileName);
    });

    it('should handle duplicate file names', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const asset1 = AssetFactory.create({ originalFileName: 'IMG_123.jpg' });
      const asset2 = AssetFactory.create({ originalFileName: 'IMG_123.jpg' });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id]));
      mocks.asset.getForOriginals.mockResolvedValue([asset1, asset2]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset1.id, asset2.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledTimes(2);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, '/data/library/IMG_123.jpg', 'IMG_123.jpg');
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(2, '/data/library/IMG_123.jpg', 'IMG_123+1.jpg');
    });

    it('should be deterministic', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const asset1 = AssetFactory.create({ originalFileName: 'IMG_123.jpg' });
      const asset2 = AssetFactory.create({ originalFileName: 'IMG_123.jpg' });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id]));
      mocks.asset.getForOriginals.mockResolvedValue([asset1, asset2]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset1.id, asset2.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledTimes(2);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, '/data/library/IMG_123.jpg', 'IMG_123.jpg');
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(2, '/data/library/IMG_123.jpg', 'IMG_123+1.jpg');
    });

    it.each([
      { input: '../../../../tmp/pwn.jpg', expected: '........tmppwn.jpg' },
      { input: String.raw`C:\temp\abs3.jpg`, expected: 'Ctempabs3.jpg' },
      { input: 'a/../../b.jpg', expected: 'a....b.jpg' },
      { input: String.raw`..\..\win1.jpg`, expected: '....win1.jpg' },
      { input: '/etc/passwd', expected: 'etcpasswd' },
      { input: '..', expected: 'unnamed' },
      { input: '', expected: 'unnamed' },
    ])('should sanitize unsafe originalFileName "$input" to "$expected"', async ({ input, expected }) => {
      const archiveMock = {
        addFile: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const asset = AssetFactory.create({ originalFileName: input, originalPath: '/data/library/safe.jpg' });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginals.mockResolvedValue([asset]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledWith('/data/library/safe.jpg', expected);
    });

    it('should dedupe sanitized duplicate unsafe filenames', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };
      const asset1 = AssetFactory.create({
        originalFileName: '../../../tmp/pwn.jpg',
        originalPath: '/data/library/a.jpg',
      });
      const asset2 = AssetFactory.create({
        originalFileName: '../../../tmp/pwn.jpg',
        originalPath: '/data/library/b.jpg',
      });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id]));
      mocks.asset.getForOriginals.mockResolvedValue([asset1, asset2]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset1.id, asset2.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledTimes(2);
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(1, '/data/library/a.jpg', '......tmppwn.jpg');
      expect(archiveMock.addFile).toHaveBeenNthCalledWith(2, '/data/library/b.jpg', '......tmppwn+1.jpg');
    });

    it('should resolve symlinks', async () => {
      const archiveMock = {
        addFile: vitest.fn(),
        finalize: vitest.fn(),
        stream: new Readable(),
      };

      const asset = AssetFactory.create({ originalPath: '/path/to/symlink.jpg' });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginals.mockResolvedValue([asset]);
      mocks.storage.realpath.mockResolvedValue('/path/to/realpath.jpg');
      mocks.storage.createZipStream.mockReturnValue(archiveMock);

      await expect(sut.downloadArchive(authStub.admin, { assetIds: [asset.id] })).resolves.toEqual({
        stream: archiveMock.stream,
      });

      expect(archiveMock.addFile).toHaveBeenCalledWith('/path/to/realpath.jpg', asset.originalFileName);
    });

    describe('Downloads preferences (ACCOUNT-P5)', () => {
      const setup = (preferences: Record<string, unknown>) => {
        const archive = { addFile: vitest.fn(), finalize: vitest.fn(), stream: new Readable() };
        const asset = AssetFactory.create({ originalFileName: 'IMG_1.HEIC', originalPath: '/original.HEIC' });
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
        mocks.asset.getForOriginals.mockResolvedValue([{ ...asset, editedPath: '/edited.jpeg' }]);
        mocks.storage.createZipStream.mockReturnValue(archive);
        mocks.storage.realpath.mockImplementation((path) => Promise.resolve(path));
        mocks.storage.checkFileExists.mockResolvedValue(true);
        mocks.downloadRepository.getSidecars.mockResolvedValue([{ assetId: asset.id, path: '/original.HEIC.xmp' }]);
        mocks.user.getMetadata.mockResolvedValue([{ key: UserMetadataKey.Preferences, value: preferences }]);
        return { archive, asset };
      };

      it("puts each photo's details file beside it and holds the original, by default", async () => {
        const { archive, asset } = setup({});

        await sut.downloadArchive(authStub.admin, { assetIds: [asset.id] });

        expect(mocks.asset.getForOriginals).toHaveBeenCalledWith([asset.id], false);
        expect(archive.addFile.mock.calls).toEqual([
          ['/original.HEIC', 'IMG_1.HEIC'],
          ['/original.HEIC.xmp', 'IMG_1.HEIC.xmp'],
        ]);
      });

      it('follows "My edited version" and no details file', async () => {
        const { archive, asset } = setup({ download: { edited: true, includeSidecar: false } });

        await sut.downloadArchive(authStub.admin, { assetIds: [asset.id] });

        expect(mocks.asset.getForOriginals).toHaveBeenCalledWith([asset.id], true);
        expect(mocks.downloadRepository.getSidecars).not.toHaveBeenCalled();
        expect(archive.addFile.mock.calls).toEqual([['/edited.jpeg', 'IMG_1.jpeg']]);
      });

      it('lets the request decide over the preferences, and skips a details file missing on disk', async () => {
        const { archive, asset } = setup({ download: { includeSidecar: false } });
        mocks.storage.checkFileExists.mockResolvedValue(false);

        await sut.downloadArchive(authStub.admin, { assetIds: [asset.id], edited: false, includeSidecar: true });

        expect(mocks.user.getMetadata).not.toHaveBeenCalled();
        expect(mocks.downloadRepository.getSidecars).toHaveBeenCalledWith([asset.id]);
        expect(archive.addFile.mock.calls).toEqual([['/original.HEIC', 'IMG_1.HEIC']]);
      });

      it("never applies the link owner's preferences to a shared-link download", async () => {
        const { archive, asset } = setup({ download: { edited: true, includeSidecar: true } });
        mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));

        await sut.downloadArchive(authStub.adminSharedLink, { assetIds: [asset.id] });

        expect(mocks.user.getMetadata).not.toHaveBeenCalled();
        expect(archive.addFile.mock.calls).toEqual([['/original.HEIC', 'IMG_1.HEIC']]);
      });
    });
  });

  describe('getDownloadInfo', () => {
    it.each([
      { sizes: [], totalSize: 0, archives: [] },
      {
        sizes: [5, 5, 1, 0, null],
        totalSize: 11,
        archives: [
          { assetIds: ['asset-0', 'asset-1', 'asset-2'], size: 11 },
          { assetIds: ['asset-3', 'asset-4'], size: 0 },
        ],
      },
      { sizes: [11], totalSize: 11, archives: [{ assetIds: ['asset-0'], size: 11 }] },
    ])(
      'keeps strict archive thresholds and omits empty trailing groups: $sizes',
      async ({ sizes, totalSize, archives }) => {
        mocks.user.getMetadata.mockResolvedValue([]);
        mocks.downloadRepository.downloadUserId.mockReturnValue(
          makeStream(sizes.map((size, index) => ({ id: `asset-${index}`, livePhotoVideoId: null, size }))),
        );
        await expect(
          sut.getDownloadInfo(authStub.admin, { userId: authStub.admin.user.id, archiveSize: 10 }),
        ).resolves.toEqual({
          totalSize,
          archives,
        });
      },
    );

    it('should throw an error for an invalid dto', async () => {
      await expect(sut.getDownloadInfo(authStub.admin, {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should return a list of archives (assetIds)', async () => {
      const assetIds = ['asset-1', 'asset-2'];

      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));
      mocks.downloadRepository.downloadAssetIds.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: null, size: 100_000 },
          { id: 'asset-2', livePhotoVideoId: null, size: 5000 },
        ]),
      );

      await expect(sut.getDownloadInfo(authStub.admin, { assetIds })).resolves.toEqual(downloadResponse);

      expect(mocks.downloadRepository.downloadAssetIds).toHaveBeenCalledWith(['asset-1', 'asset-2']);
    });

    it('should return a list of archives (albumId)', async () => {
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-1']));
      mocks.downloadRepository.downloadAlbumId.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: null, size: 100_000 },
          { id: 'asset-2', livePhotoVideoId: null, size: 5000 },
        ]),
      );

      await expect(sut.getDownloadInfo(authStub.admin, { albumId: 'album-1' })).resolves.toEqual(downloadResponse);

      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set(['album-1']));
      expect(mocks.downloadRepository.downloadAlbumId).toHaveBeenCalledWith('album-1');
    });

    it('should filter album downloads when NSFW hiding is active', async () => {
      const auth = { ...authStub.admin, hideNsfwAssets: true };
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-1']));
      mocks.downloadRepository.downloadAlbumId.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: null, size: 100_000 },
          { id: 'asset-2', livePhotoVideoId: null, size: 5000 },
        ]),
      );

      await expect(sut.getDownloadInfo(auth, { albumId: 'album-1' })).resolves.toEqual(downloadResponse);

      expect(mocks.downloadRepository.downloadAlbumId).toHaveBeenCalledWith('album-1', { excludeNsfw: true });
    });

    it('should include the elevated owner as the Locked owner of an album download (FL-32)', async () => {
      const auth = authStub.adminWithElevatedPermission;
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-1']));
      mocks.downloadRepository.downloadAlbumId.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: null, size: 100_000 },
          { id: 'asset-2', livePhotoVideoId: null, size: 5000 },
        ]),
      );

      await expect(sut.getDownloadInfo(auth, { albumId: 'album-1' })).resolves.toEqual(downloadResponse);

      expect(mocks.downloadRepository.downloadAlbumId).toHaveBeenCalledWith('album-1', {
        lockedOwnerId: auth.user.id,
      });
    });

    it('should return a list of archives (userId)', async () => {
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.downloadRepository.downloadUserId.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: null, size: 100_000 },
          { id: 'asset-2', livePhotoVideoId: null, size: 5000 },
        ]),
      );

      await expect(sut.getDownloadInfo(authStub.admin, { userId: authStub.admin.user.id })).resolves.toEqual(
        downloadResponse,
      );

      expect(mocks.downloadRepository.downloadUserId).toHaveBeenCalledWith(authStub.admin.user.id);
    });

    it('should filter timeline downloads when NSFW hiding is active', async () => {
      const auth = { ...authStub.admin, hideNsfwAssets: true };
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.downloadRepository.downloadUserId.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: null, size: 100_000 },
          { id: 'asset-2', livePhotoVideoId: null, size: 5000 },
        ]),
      );

      await expect(sut.getDownloadInfo(auth, { userId: auth.user.id })).resolves.toEqual(downloadResponse);

      expect(mocks.downloadRepository.downloadUserId).toHaveBeenCalledWith(auth.user.id, { excludeNsfw: true });
    });

    it('should include Locked media in a timeline download only for an elevated session (FL-34)', async () => {
      const auth = authStub.adminWithElevatedPermission;
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.downloadRepository.downloadUserId.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: null, size: 100_000 },
          { id: 'asset-2', livePhotoVideoId: null, size: 5000 },
        ]),
      );

      await expect(sut.getDownloadInfo(auth, { userId: auth.user.id })).resolves.toEqual(downloadResponse);

      expect(mocks.downloadRepository.downloadUserId).toHaveBeenCalledWith(auth.user.id, {
        lockedOwnerId: auth.user.id,
      });
    });

    it('should split archives by size', async () => {
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.downloadRepository.downloadUserId.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: null, size: 5000 },
          { id: 'asset-2', livePhotoVideoId: null, size: 100_000 },
          { id: 'asset-3', livePhotoVideoId: null, size: 23_456 },
          { id: 'asset-4', livePhotoVideoId: null, size: 123_000 },
        ]),
      );

      await expect(
        sut.getDownloadInfo(authStub.admin, {
          userId: authStub.admin.user.id,
          archiveSize: 30_000,
        }),
      ).resolves.toEqual({
        totalSize: 251_456,
        archives: [
          { assetIds: ['asset-1', 'asset-2'], size: 105_000 },
          { assetIds: ['asset-3', 'asset-4'], size: 146_456 },
        ],
      });
    });

    it('should include the video portion of a live photo', async () => {
      const assetIds = ['asset-1', 'asset-2'];

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.downloadRepository.downloadAssetIds.mockReturnValue(
        makeStream([
          { id: 'asset-1', livePhotoVideoId: 'asset-3', size: 5000 },
          { id: 'asset-2', livePhotoVideoId: 'asset-4', size: 100_000 },
        ]),
      );
      mocks.downloadRepository.downloadMotionAssetIds.mockReturnValue(
        makeStream([
          { id: 'asset-3', livePhotoVideoId: null, size: 23_456, originalPath: '/path/to/file.mp4' },
          { id: 'asset-4', livePhotoVideoId: null, size: 123_000, originalPath: '/path/to/file.mp4' },
        ]),
      );

      await expect(sut.getDownloadInfo(authStub.admin, { assetIds, archiveSize: 30_000 })).resolves.toEqual({
        totalSize: 251_456,
        archives: [
          { assetIds: ['asset-1', 'asset-2'], size: 105_000 },
          { assetIds: ['asset-3', 'asset-4'], size: 146_456 },
        ],
      });
    });

    it('should filter live-photo motion assets when NSFW hiding is active', async () => {
      const auth = { ...authStub.admin, hideNsfwAssets: true };
      const assetIds = ['asset-1'];

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.downloadRepository.downloadAssetIds.mockReturnValue(
        makeStream([{ id: 'asset-1', livePhotoVideoId: 'asset-2', size: 5000 }]),
      );
      mocks.downloadRepository.downloadMotionAssetIds.mockReturnValue(
        makeStream([{ id: 'asset-2', livePhotoVideoId: null, size: 23_456, originalPath: '/path/to/file.mp4' }]),
      );

      await expect(sut.getDownloadInfo(auth, { assetIds })).resolves.toEqual({
        totalSize: 28_456,
        archives: [{ assetIds: ['asset-1', 'asset-2'], size: 28_456 }],
      });

      expect(mocks.downloadRepository.downloadAssetIds).toHaveBeenCalledWith(assetIds, { excludeNsfw: true });
      expect(mocks.downloadRepository.downloadMotionAssetIds).toHaveBeenCalledWith(['asset-2'], { excludeNsfw: true });
    });

    it('should include the video portion of an android live photo when the owner prefers embedded videos', async () => {
      const assetIds = ['asset-1'];

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));
      mocks.user.getMetadata.mockResolvedValue([
        { key: UserMetadataKey.Preferences, value: { download: { includeEmbeddedVideos: true } } },
      ]);
      mocks.downloadRepository.downloadAssetIds.mockReturnValue(
        makeStream([{ id: 'asset-1', livePhotoVideoId: 'asset-2', size: 5000 }]),
      );
      mocks.downloadRepository.downloadMotionAssetIds.mockReturnValue(
        makeStream([
          { id: 'asset-2', livePhotoVideoId: null, size: 23_456, originalPath: '/data/encoded-video/uuid-MP.mp4' },
        ]),
      );

      await expect(sut.getDownloadInfo(authStub.admin, { assetIds })).resolves.toEqual({
        totalSize: 28_456,
        archives: [{ assetIds: ['asset-1', 'asset-2'], size: 28_456 }],
      });
    });

    it('should skip the video portion of an android live photo by default', async () => {
      const assetIds = ['asset-1'];

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.downloadRepository.downloadAssetIds.mockReturnValue(
        makeStream([{ id: 'asset-1', livePhotoVideoId: 'asset-3', size: 5000 }]),
      );

      mocks.downloadRepository.downloadMotionAssetIds.mockReturnValue(
        makeStream([
          {
            id: 'asset-2',
            livePhotoVideoId: null,
            size: 23_456,
            originalPath: '/data/encoded-video/uuid-MP.mp4',
          },
        ]),
      );

      await expect(sut.getDownloadInfo(authStub.admin, { assetIds })).resolves.toEqual({
        totalSize: 5000,
        archives: [
          {
            assetIds: ['asset-1'],
            size: 5000,
          },
        ],
      });
    });
  });
});
