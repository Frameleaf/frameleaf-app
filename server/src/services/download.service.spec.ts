import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { vitest } from 'vitest';
import { DownloadResponseDto } from 'src/dtos/download.dto.js';
import {
  DownloadService,
  LOCATION_OMITTED_NOTE_NAME,
  MAX_LOCATION_FREE_ARCHIVE_ENTRIES,
} from 'src/services/download.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { PartnerFactory } from 'test/factories/partner.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForPartner } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';
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
  });

  describe('downloadArchive location policy (FL-54)', () => {
    /** a paced zip whose `whenIdle` the test releases by hand, closing with the stream like archiver does */
    const newPacedArchive = () => {
      const stream = new Readable({ read() {} });
      let idle: Array<() => void> = [];
      let manual = false;
      stream.on('close', () => {
        for (const resolve of idle) {
          resolve();
        }
        idle = [];
      });
      const archive = {
        stream,
        addFile: vitest.fn(),
        addBuffer: vitest.fn(),
        finalize: vitest.fn().mockResolvedValue(undefined),
        isClosed: vitest.fn(() => stream.destroyed),
        whenIdle: vitest.fn(() =>
          manual && !stream.destroyed
            ? new Promise<void>((resolve) => {
                idle.push(resolve);
              })
            : Promise.resolve(),
        ),
        /** make `whenIdle` wait until `drain` is called */
        hold: () => (manual = true),
        drain: () => {
          const waiting = idle;
          idle = [];
          for (const resolve of waiting) {
            resolve();
          }
        },
      };
      mocks.storage.createPacedZipStream.mockReturnValue(archive);
      return archive;
    };

    const hidingPartner = () => {
      const me = UserFactory.create();
      const hiding = UserFactory.create();
      mocks.partner.getAll.mockResolvedValue([
        getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(hiding).sharedWith(me).build()),
      ]);
      return { me, hiding };
    };

    it("zips a location-free copy of a hiding partner's files and releases each once written", async () => {
      const { me, hiding } = hidingPartner();
      const archive = newPacedArchive();
      const own = AssetFactory.create({ ownerId: me.id, originalPath: '/library/mine.jpg', originalFileName: 'a.jpg' });
      const theirs = AssetFactory.create({
        ownerId: hiding.id,
        originalPath: '/library/theirs.jpg',
        originalFileName: 'b.jpg',
      });
      const release = vitest.fn();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([own.id]));
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([theirs.id]));
      mocks.asset.getForOriginals.mockResolvedValue([own, theirs]);
      mocks.metadata.acquireLocationFreeOriginal.mockResolvedValue({ path: '/tmp/copy.jpg', release });

      await expect(sut.downloadArchive(AuthFactory.create(me), { assetIds: [own.id, theirs.id] })).resolves.toEqual({
        stream: archive.stream,
      });
      await vitest.waitFor(() => expect(archive.finalize).toHaveBeenCalled());

      expect(mocks.storage.createZipStream).not.toHaveBeenCalled();
      expect(mocks.metadata.acquireLocationFreeOriginal).toHaveBeenCalledExactlyOnceWith('/library/theirs.jpg');
      expect(archive.addFile).toHaveBeenNthCalledWith(1, '/library/mine.jpg', 'a.jpg');
      expect(archive.addFile).toHaveBeenNthCalledWith(2, '/tmp/copy.jpg', 'b.jpg');
      expect(release).toHaveBeenCalledTimes(1);
      expect(archive.addBuffer).not.toHaveBeenCalled();
    });

    it('prepares each copy only once the reader has taken the entries before it (review R1)', async () => {
      const { me, hiding } = hidingPartner();
      const archive = newPacedArchive();
      archive.hold();
      const first = AssetFactory.create({ ownerId: hiding.id, originalPath: '/library/1.jpg' });
      const second = AssetFactory.create({ ownerId: hiding.id, originalPath: '/library/2.jpg' });

      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([first.id, second.id]));
      mocks.asset.getForOriginals.mockResolvedValue([first, second]);
      mocks.metadata.acquireLocationFreeOriginal.mockImplementation((path) =>
        Promise.resolve({ path: `${path}.copy`, release: vitest.fn() }),
      );

      await sut.downloadArchive(AuthFactory.create(me), { assetIds: [first.id, second.id] });

      // nothing has been stripped before the first byte is requested
      await vitest.waitFor(() => expect(archive.whenIdle).toHaveBeenCalledTimes(1));
      expect(mocks.metadata.acquireLocationFreeOriginal).not.toHaveBeenCalled();

      archive.drain();
      await vitest.waitFor(() =>
        expect(archive.addFile).toHaveBeenCalledWith('/library/1.jpg.copy', expect.any(String)),
      );
      expect(mocks.metadata.acquireLocationFreeOriginal).toHaveBeenCalledTimes(1);

      await vitest.waitFor(() => expect(archive.whenIdle).toHaveBeenCalledTimes(2));
      archive.drain(); // the first copy has been written
      await vitest.waitFor(() => expect(archive.whenIdle).toHaveBeenCalledTimes(3));
      expect(mocks.metadata.acquireLocationFreeOriginal).toHaveBeenCalledTimes(1);
      archive.drain(); // and the reader caught up again
      await vitest.waitFor(() => expect(mocks.metadata.acquireLocationFreeOriginal).toHaveBeenCalledTimes(2));
    });

    it('stops and lets the copy go when the client goes away (review B2)', async () => {
      const { me, hiding } = hidingPartner();
      const archive = newPacedArchive();
      const first = AssetFactory.create({ ownerId: hiding.id });
      const second = AssetFactory.create({ ownerId: hiding.id });
      const release = vitest.fn();

      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([first.id, second.id]));
      mocks.asset.getForOriginals.mockResolvedValue([first, second]);
      mocks.metadata.acquireLocationFreeOriginal.mockImplementation(() => {
        archive.hold(); // the copy is added, then the reader stalls
        return Promise.resolve({ path: '/tmp/copy.jpg', release });
      });

      await sut.downloadArchive(AuthFactory.create(me), { assetIds: [first.id, second.id] });
      await vitest.waitFor(() => expect(archive.addFile).toHaveBeenCalledTimes(1));
      expect(release).not.toHaveBeenCalled();

      archive.stream.destroy(); // what the controller does on response 'close'

      await vitest.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      expect(mocks.metadata.acquireLocationFreeOriginal).toHaveBeenCalledTimes(1);
      expect(archive.finalize).not.toHaveBeenCalled();
    });

    it('leaves a file out rather than zip its location, and says so in the archive', async () => {
      const { me, hiding } = hidingPartner();
      const archive = newPacedArchive();
      const theirs = AssetFactory.create({ ownerId: hiding.id, originalFileName: 'secret-beach.jpg' });

      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([theirs.id]));
      mocks.asset.getForOriginals.mockResolvedValue([theirs]);
      mocks.metadata.acquireLocationFreeOriginal.mockRejectedValue(new Error('exiftool failed'));

      await sut.downloadArchive(AuthFactory.create(me), { assetIds: [theirs.id] });
      await vitest.waitFor(() => expect(archive.finalize).toHaveBeenCalled());

      expect(archive.addFile).not.toHaveBeenCalled();
      expect(archive.addBuffer).toHaveBeenCalledWith(expect.any(Buffer), LOCATION_OMITTED_NOTE_NAME);
      const note = String(archive.addBuffer.mock.calls[0][0]);
      expect(note).toContain('1 file(s) were left out');
      expect(note).toContain('secret-beach.jpg');
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining(theirs.id));
    });

    it("strips a hiding owner's files in an album link their hidden partner created (review B1)", async () => {
      const { me: creator, hiding } = hidingPartner();
      const archive = newPacedArchive();
      const theirs = AssetFactory.create({ ownerId: hiding.id, originalPath: '/library/theirs.jpg' });
      const auth = AuthFactory.from(creator)
        .sharedLink({ userId: creator.id, albumId: newUuid(), showExif: true, allowDownload: true })
        .build();

      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([theirs.id]));
      mocks.asset.getForOriginals.mockResolvedValue([theirs]);
      mocks.metadata.acquireLocationFreeOriginal.mockResolvedValue({ path: '/tmp/copy.jpg', release: vitest.fn() });

      await sut.downloadArchive(auth, { assetIds: [theirs.id] });
      await vitest.waitFor(() => expect(archive.finalize).toHaveBeenCalled());

      expect(mocks.partner.getAll).toHaveBeenCalledWith(creator.id);
      expect(archive.addFile).toHaveBeenCalledWith('/tmp/copy.jpg', theirs.originalFileName);
    });

    it('zips a partner who may see locations the original bytes', async () => {
      const me = UserFactory.create();
      const sharing = UserFactory.create();
      const archiveMock = { addFile: vitest.fn(), finalize: vitest.fn(), stream: new Readable({ read() {} }) };
      const theirs = AssetFactory.create({ ownerId: sharing.id });

      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([theirs.id]));
      mocks.asset.getForOriginals.mockResolvedValue([theirs]);
      mocks.storage.createZipStream.mockReturnValue(archiveMock);
      mocks.partner.getAll.mockResolvedValue([
        getForPartner(PartnerFactory.from({ shareLocation: true }).sharedBy(sharing).sharedWith(me).build()),
      ]);

      await sut.downloadArchive(AuthFactory.create(me), { assetIds: [theirs.id] });

      expect(archiveMock.addFile).toHaveBeenCalledWith(theirs.originalPath, theirs.originalFileName);
      expect(mocks.metadata.acquireLocationFreeOriginal).not.toHaveBeenCalled();
      expect(mocks.storage.createPacedZipStream).not.toHaveBeenCalled();
    });

    it('caps how many files one request may have stripped (review R1)', async () => {
      const { me, hiding } = hidingPartner();
      const assets = Array.from({ length: MAX_LOCATION_FREE_ARCHIVE_ENTRIES + 1 }, (_, index) => ({
        id: `asset-${index}`,
        ownerId: hiding.id,
        originalPath: `/library/${index}.jpg`,
        originalFileName: `${index}.jpg`,
        editedPath: null,
      }));
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set(assets.map(({ id }) => id)));
      mocks.asset.getForOriginals.mockResolvedValue(assets);

      await expect(
        sut.downloadArchive(AuthFactory.create(me), { assetIds: assets.map(({ id }) => id) }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.storage.createPacedZipStream).not.toHaveBeenCalled();
    });

    it('refuses an archive through a shared link that hides metadata', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginals.mockResolvedValue([asset]);
      const auth = AuthFactory.from().sharedLink({ showExif: false, allowDownload: true }).build();

      await expect(sut.downloadArchive(auth, { assetIds: [asset.id] })).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.storage.createZipStream).not.toHaveBeenCalled();
    });
  });

  describe('downloadArchive', () => {
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
  });

  describe('getDownloadInfo', () => {
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
