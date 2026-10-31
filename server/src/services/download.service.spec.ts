import { BadRequestException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { vitest } from 'vitest';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { DownloadResponseDto } from 'src/dtos/download.dto.js';
import { AssetVisibility, UserMetadataKey } from 'src/enum.js';
import { DownloadService } from 'src/services/download.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newDate, newUuid } from 'test/small.factory.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

/** FL-423: an asset as `getByIdsWithAllRelationsButStacks` reads it for the person downloading. */
const described = ({ id, ownerId, originalFileName, visibility }: ReturnType<typeof AssetFactory.create>) => ({
  ...AssetFactory.from({ id, ownerId, originalFileName, visibility, localDateTime: new Date('2024-07-01T10:00:00Z') })
    .exif({
      assetId: id,
      dateTimeOriginal: new Date('2024-07-01T16:00:00Z'),
      timeZone: 'America/Edmonton',
      latitude: 51.1784,
      longitude: -115.5708,
      description: 'Lake Louise at dawn',
      rating: 4,
      orientation: '6',
    })
    .face({}, (face) => face.person({ name: 'Ana' }))
    .face({}, (face) => face.person({ name: 'Hidden person', isHidden: true }))
    .build(),
  tags: [
    {
      id: newUuid(),
      value: 'Travel/Canada/Banff',
      parentId: null,
      color: null,
      createdAt: newDate(),
      updatedAt: newDate(),
    },
  ],
});

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
    it.each([
      { names: ['constructor', 'constructor'], expected: ['constructor', 'constructor+1'] },
      { names: ['__proto__', '__proto__'], expected: ['__proto__', '__proto__+1'] },
      { names: ['photo.jpg', 'photo+1.jpg', 'photo.jpg'], expected: ['photo.jpg', 'photo+1.jpg', 'photo+2.jpg'] },
      { names: ['photo.jpg', 'photo.jpg', 'photo+1.jpg'], expected: ['photo.jpg', 'photo+1.jpg', 'photo+1+1.jpg'] },
      { names: ['', 'unnamed', ''], expected: ['unnamed', 'unnamed+1', 'unnamed+2'] },
    ])('keeps every archive member distinct for $names', async ({ names, expected }) => {
      const archive = { addFile: vitest.fn(), finalize: vitest.fn(), stream: new Readable() };
      const assets = names.map((originalFileName) => AssetFactory.create({ originalFileName }));
      const assetIds = assets.map(({ id }) => id);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(assetIds));
      mocks.asset.getForOriginals.mockResolvedValue(assets);
      mocks.storage.createZipStream.mockReturnValue(archive);
      await sut.downloadArchive(authStub.admin, { assetIds });
      expect(archive.addFile.mock.calls.map(([, name]) => name)).toEqual(expected);
      expect(new Set(archive.addFile.mock.calls.map(([, name]) => name)).size).toBe(names.length);
    });

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

      it("puts each photo's details file beside it and holds the original when `edited` is left out", async () => {
        const { archive, asset } = setup({});

        await sut.downloadArchive(authStub.admin, { assetIds: [asset.id] });

        expect(mocks.asset.getForOriginals).toHaveBeenCalledWith([asset.id], false);
        expect(archive.addFile.mock.calls).toEqual([
          ['/original.HEIC', 'IMG_1.HEIC'],
          ['/original.HEIC.xmp', 'IMG_1.HEIC.xmp'],
        ]);
      });

      it('follows "no details file"; a stored original-or-edited choice no longer decides anything', async () => {
        // An account that saved the retired `download.edited` before it was removed (owner, 2026-10-16).
        const { archive, asset } = setup({ download: { edited: true, includeSidecar: false } });

        await sut.downloadArchive(authStub.admin, { assetIds: [asset.id] });

        expect(mocks.asset.getForOriginals).toHaveBeenCalledWith([asset.id], false);
        expect(mocks.downloadRepository.getSidecars).not.toHaveBeenCalled();
        expect(archive.addFile.mock.calls).toEqual([['/original.HEIC', 'IMG_1.HEIC']]);
      });

      it('lets the request decide over the preferences, and makes a details file when the sidecar is missing on disk', async () => {
        const { archive, asset } = setup({ download: { includeSidecar: false } });
        mocks.storage.checkFileExists.mockResolvedValue(false);
        mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([described(asset)] as never);

        await sut.downloadArchive(authStub.admin, { assetIds: [asset.id], edited: false, includeSidecar: true });

        expect(mocks.user.getMetadata).not.toHaveBeenCalled();
        expect(mocks.downloadRepository.getSidecars).toHaveBeenCalledWith([asset.id]);
        expect(archive.addFile.mock.calls.map(([, name]) => name)).toEqual(['IMG_1.HEIC', 'IMG_1.HEIC.xmp']);
        expect(archive.addFile.mock.calls[1][0]).toBeInstanceOf(Buffer);
      });

      it("never applies the link owner's preferences to a shared-link download", async () => {
        const { archive, asset } = setup({ download: { includeSidecar: true } });
        mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));

        await sut.downloadArchive(authStub.adminSharedLink, { assetIds: [asset.id] });

        expect(mocks.user.getMetadata).not.toHaveBeenCalled();
        expect(mocks.asset.getByIdsWithAllRelationsButStacks).not.toHaveBeenCalled();
        expect(archive.addFile.mock.calls).toEqual([['/original.HEIC', 'IMG_1.HEIC']]);
      });

      describe('a photo without a sidecar (FL-423)', () => {
        const xmpOf = (archive: { addFile: { mock: { calls: unknown[][] } } }, name: string) => {
          const call = archive.addFile.mock.calls.find(([, member]) => member === name);
          return call ? (call[0] as Buffer).toString('utf8') : undefined;
        };

        it('gets a details file made from its asset response, beside the one that has a sidecar', async () => {
          const { archive, asset } = setup({});
          const bare = AssetFactory.create({ originalFileName: 'IMG_2.JPG', originalPath: '/bare.JPG' });
          mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id, bare.id]));
          mocks.asset.getForOriginals.mockResolvedValue([asset, bare]);
          mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([described(bare)] as never);

          await sut.downloadArchive(authStub.admin, { assetIds: [asset.id, bare.id] });

          // only the photo without a sidecar is read, as the person downloading sees it
          expect(mocks.asset.getByIdsWithAllRelationsButStacks).toHaveBeenCalledWith([bare.id], authStub.admin.user.id);
          expect(archive.addFile.mock.calls.map(([input, name]) => [typeof input, name])).toEqual([
            ['string', 'IMG_1.HEIC'],
            ['string', 'IMG_1.HEIC.xmp'],
            ['string', 'IMG_2.JPG'],
            ['object', 'IMG_2.JPG.xmp'],
          ]);
          expect(archive.addFile).toHaveBeenCalledWith('/original.HEIC.xmp', 'IMG_1.HEIC.xmp');
          const xmp = xmpOf(archive, 'IMG_2.JPG.xmp')!;
          expect(xmp).toContain('<exif:DateTimeOriginal>2024-07-01T10:00:00.000-06:00</exif:DateTimeOriginal>');
          expect(xmp).toContain('<exif:GPSLatitude>51,10.704000N</exif:GPSLatitude>');
          expect(xmp).toContain('<rdf:li xml:lang="x-default">Lake Louise at dawn</rdf:li>');
          expect(xmp).toContain('<xmp:Rating>4</xmp:Rating>');
          expect(xmp).toContain('<rdf:li>Travel/Canada/Banff</rdf:li>');
          expect(xmp).toContain('<tiff:Orientation>6</tiff:Orientation>');
          expect(xmp).toContain('<Iptc4xmpExt:PersonInImage><rdf:Bag><rdf:li>Ana</rdf:li></rdf:Bag>');
          expect(xmp).not.toContain('Hidden person');
        });

        it('leaves the orientation out of an edit, which is already upright', async () => {
          const { archive, asset } = setup({});
          mocks.downloadRepository.getSidecars.mockResolvedValue([]);
          mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([described(asset)] as never);

          await sut.downloadArchive(authStub.admin, { assetIds: [asset.id], edited: true });

          expect(archive.addFile.mock.calls.map(([, name]) => name)).toEqual(['IMG_1.jpeg', 'IMG_1.jpeg.xmp']);
          expect(xmpOf(archive, 'IMG_1.jpeg.xmp')).not.toContain('tiff:Orientation');
        });

        it('names no people for a shared link, whose asset response has none', async () => {
          const { archive, asset } = setup({});
          mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
          mocks.downloadRepository.getSidecars.mockResolvedValue([]);
          mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([described(asset)] as never);

          await sut.downloadArchive(authStub.adminSharedLink, { assetIds: [asset.id], includeSidecar: true });

          const xmp = xmpOf(archive, 'IMG_1.HEIC.xmp')!;
          expect(xmp).toContain('<rdf:li xml:lang="x-default">Lake Louise at dawn</rdf:li>');
          expect(xmp).not.toContain('PersonInImage');
          expect(xmp).not.toContain('Ana');
        });

        it('makes none for the motion part of a Live Photo, nor when details files are turned off', async () => {
          const { archive, asset } = setup({ download: { includeSidecar: false } });
          mocks.downloadRepository.getSidecars.mockResolvedValue([]);
          await sut.downloadArchive(authStub.admin, { assetIds: [asset.id] });
          expect(mocks.asset.getByIdsWithAllRelationsButStacks).not.toHaveBeenCalled();
          expect(archive.addFile.mock.calls).toEqual([['/original.HEIC', 'IMG_1.HEIC']]);

          const motion = AssetFactory.create({ visibility: AssetVisibility.Hidden, originalFileName: 'IMG_1.MOV' });
          mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([motion.id]));
          mocks.asset.getForOriginals.mockResolvedValue([motion]);
          mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([described(motion)] as never);
          archive.addFile.mockClear();
          await sut.downloadArchive(authStub.admin, { assetIds: [motion.id], includeSidecar: true });
          expect(archive.addFile.mock.calls.map(([, name]) => name)).toEqual(['IMG_1.MOV']);
        });
      });
    });

    describe('as shown (owner, 2026-10-16)', () => {
      const developed = (assetId: string, ownerId: string, status = AssetDevelopRevisionStatus.Rendered) => ({
        assetId,
        ownerId,
        status,
        previewPath: '/develop/preview.jpeg',
        masterPath: '/develop/master.webp',
      });
      const setup = (ownerId: string) => {
        const archive = { addFile: vitest.fn(), finalize: vitest.fn(), stream: new Readable() };
        const asset = AssetFactory.create({ ownerId, originalFileName: 'IMG_1.HEIC', originalPath: '/original.HEIC' });
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
        mocks.asset.getForOriginals.mockResolvedValue([{ ...asset, editedPath: '/edited.jpeg' }]);
        mocks.storage.createZipStream.mockReturnValue(archive);
        mocks.storage.realpath.mockImplementation((path) => Promise.resolve(path));
        return { archive, asset };
      };

      it("holds the owner's current develop version, the picture their viewer shows", async () => {
        const { archive, asset } = setup(authStub.admin.user.id);
        mocks.asset.getCurrentDevelops.mockResolvedValue([developed(asset.id, authStub.admin.user.id)]);

        await sut.downloadArchive(authStub.admin, { assetIds: [asset.id], edited: true, includeSidecar: false });

        expect(mocks.asset.getCurrentDevelops).toHaveBeenCalledWith([asset.id]);
        expect(archive.addFile.mock.calls).toEqual([['/develop/master.webp', 'IMG_1.webp']]);
      });

      it('keeps the edited file while the current version has not been rendered', async () => {
        const { archive, asset } = setup(authStub.admin.user.id);
        mocks.asset.getCurrentDevelops.mockResolvedValue([
          { ...developed(asset.id, authStub.admin.user.id, AssetDevelopRevisionStatus.Rendering), masterPath: null },
        ]);

        await sut.downloadArchive(authStub.admin, { assetIds: [asset.id], edited: true, includeSidecar: false });

        expect(archive.addFile.mock.calls).toEqual([['/edited.jpeg', 'IMG_1.jpeg']]);
      });

      it("never gives anyone else the owner's working version", async () => {
        const { archive, asset } = setup(authStub.user1.user.id);

        await sut.downloadArchive(authStub.admin, { assetIds: [asset.id], edited: true, includeSidecar: false });

        expect(mocks.asset.getCurrentDevelops).not.toHaveBeenCalled();
        expect(archive.addFile.mock.calls).toEqual([['/edited.jpeg', 'IMG_1.jpeg']]);
      });

      it('holds the originals when the request asks for them', async () => {
        const { archive, asset } = setup(authStub.admin.user.id);
        mocks.asset.getCurrentDevelops.mockResolvedValue([developed(asset.id, authStub.admin.user.id)]);

        await sut.downloadArchive(authStub.admin, { assetIds: [asset.id], edited: false, includeSidecar: false });

        expect(mocks.asset.getCurrentDevelops).not.toHaveBeenCalled();
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
      expect(mocks.downloadRepository.downloadAlbumId).toHaveBeenCalledWith('album-1', {
        othersRulesViewerId: authStub.admin.user.id,
      });
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

      expect(mocks.downloadRepository.downloadAlbumId).toHaveBeenCalledWith('album-1', {
        excludeNsfw: true,
        othersRulesViewerId: auth.user.id,
      });
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
        othersRulesViewerId: auth.user.id,
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

it('reserves the portable manifest name and keeps original media names mapped to the ZIP', async () => {
  const { sut, mocks } = newTestService(DownloadService);
  const asset = AssetFactory.create({ ownerId: authStub.admin.user.id, originalFileName: 'frameleaf-library.json' });
  const archive = { addFile: vitest.fn(), finalize: vitest.fn(), stream: new Readable() };
  mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
  mocks.asset.getForOriginals.mockResolvedValue([asset]);
  mocks.storage.createZipStream.mockReturnValue(archive);
  mocks.storage.realpath.mockResolvedValue(asset.originalPath);
  const manifest = { version: 1 as const, albums: [], tags: [], assets: [], bookmarks: [] };
  mocks.downloadRepository.getLibraryManifest.mockResolvedValue(manifest);
  await sut.downloadArchive(authStub.admin, {
    assetIds: [asset.id],
    includeLibraryMetadata: true,
    includeSidecar: false,
  });
  expect(mocks.downloadRepository.getLibraryManifest).toHaveBeenCalledWith(
    authStub.admin,
    [{ id: asset.id, file: 'frameleaf-library+1.json' }],
    [],
    false,
  );
  expect(archive.addFile).toHaveBeenCalledWith(expect.anything(), 'frameleaf-library+1.json');
  const metadata = archive.addFile.mock.calls.find(([, name]) => name === 'frameleaf-library.json');
  expect(JSON.parse((metadata![0] as Buffer).toString())).toEqual(manifest);
});
it('refuses private metadata exports from shared links before reading or streaming files', async () => {
  const { sut, mocks } = newTestService(DownloadService);
  await expect(
    sut.downloadArchive(authStub.adminSharedLink, { assetIds: [], includeLibraryMetadata: true }),
  ).rejects.toThrow();
  expect(mocks.asset.getForOriginals).not.toHaveBeenCalled();
  expect(mocks.storage.createZipStream).not.toHaveBeenCalled();
});
