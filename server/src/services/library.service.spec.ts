import { BadRequestException, ConflictException } from '@nestjs/common';
import { Stats } from 'node:fs';
import { vitest } from 'vitest';
import type { LibraryRemovalCounts } from 'src/repositories/library.repository.js';
import type { ILibraryFileJob } from 'src/types.js';
import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { mapLibrary } from 'src/dtos/library.dto.js';
import {
  AdminAuditAction,
  AssetType,
  CronJob,
  ImmichWorker,
  JobName,
  JobStatus,
  LibraryImportPathReason,
  UserStatus,
} from 'src/enum.js';
import { LibraryService } from 'src/services/library.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { systemConfigStub } from 'test/fixtures/system-config.stub.js';
import { makeMockWatcher } from 'test/repositories/storage.repository.mock.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

const removalCounts = (counts: Partial<LibraryRemovalCounts> = {}): LibraryRemovalCounts => ({
  photos: 0,
  videos: 0,
  usage: 0,
  offline: 0,
  albums: 0,
  sharedLinks: 0,
  faces: 0,
  all: 0,
  ...counts,
});

describe(LibraryService.name, () => {
  let sut: LibraryService;

  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(LibraryService));

    mocks.database.tryLock.mockResolvedValue(true);
    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
    // FL-78: libraries belong to a live account unless a test says otherwise
    mocks.user.get.mockResolvedValue(UserFactory.create());
    mocks.library.getAll.mockResolvedValue([]);
    mocks.library.getRemovalCounts.mockResolvedValue(removalCounts());
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onConfigInit', () => {
    it('should init cron job and handle config changes', async () => {
      mocks.cron.create.mockResolvedValue();
      mocks.cron.update.mockResolvedValue();

      await sut.onConfigInit({ newConfig: defaults });

      expect(mocks.cron.create).toHaveBeenCalled();

      await sut.onConfigUpdate({
        oldConfig: defaults,
        newConfig: {
          library: {
            scan: {
              enabled: true,
              cronExpression: '0 1 * * *',
            },
            watch: { enabled: false },
          },
        } as SystemConfig,
      });

      expect(mocks.cron.update).toHaveBeenCalledWith({
        name: CronJob.LibraryScan,
        expression: '0 1 * * *',
        start: true,
      });
    });

    it('should initialize watcher for all external libraries', async () => {
      const library1 = factory.library({ importPaths: ['/foo', '/bar'] });
      const library2 = factory.library({ importPaths: ['/xyz', '/asdf'] });

      mocks.library.getAll.mockResolvedValue([library1, library2]);

      mocks.library.get.mockImplementation((id) =>
        Promise.resolve([library1, library2].find((library) => library.id === id)),
      );
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });

      expect(mocks.storage.watch.mock.calls).toEqual(
        expect.arrayContaining([(library1.importPaths, expect.anything()), (library2.importPaths, expect.anything())]),
      );
    });

    it('should not initialize watcher when watching is disabled', async () => {
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchDisabled as SystemConfig });

      expect(mocks.storage.watch).not.toHaveBeenCalled();
    });

    it('should not initialize watcher when lock is taken', async () => {
      mocks.database.tryLock.mockResolvedValue(false);

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });

      expect(mocks.storage.watch).not.toHaveBeenCalled();
    });

    it('should not initialize library scan cron job when lock is taken', async () => {
      mocks.database.tryLock.mockResolvedValue(false);

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });

      expect(mocks.cron.create).not.toHaveBeenCalled();
    });
  });

  describe('onConfigUpdateEvent', () => {
    beforeEach(async () => {
      mocks.database.tryLock.mockResolvedValue(true);
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: defaults });
    });

    it('should do nothing if instance does not have the watch lock', async () => {
      mocks.database.tryLock.mockResolvedValue(false);
      await sut.onConfigInit({ newConfig: defaults });
      await sut.onConfigUpdate({ newConfig: systemConfigStub.libraryScan as SystemConfig, oldConfig: defaults });
      expect(mocks.cron.update).not.toHaveBeenCalled();
    });

    it('should update cron job and enable watching', async () => {
      mocks.library.getAll.mockResolvedValue([]);
      mocks.cron.create.mockResolvedValue();
      mocks.cron.update.mockResolvedValue();

      await sut.onConfigUpdate({
        newConfig: systemConfigStub.libraryScanAndWatch as SystemConfig,
        oldConfig: defaults,
      });

      expect(mocks.cron.update).toHaveBeenCalledWith({
        name: CronJob.LibraryScan,
        expression: systemConfigStub.libraryScan.library.scan.cronExpression,
        start: systemConfigStub.libraryScan.library.scan.enabled,
      });
    });

    it('should update cron job and disable watching', async () => {
      mocks.library.getAll.mockResolvedValue([]);
      mocks.cron.create.mockResolvedValue();
      mocks.cron.update.mockResolvedValue();

      await sut.onConfigUpdate({
        newConfig: systemConfigStub.libraryScanAndWatch as SystemConfig,
        oldConfig: defaults,
      });
      await sut.onConfigUpdate({
        newConfig: systemConfigStub.libraryScan as SystemConfig,
        oldConfig: defaults,
      });

      expect(mocks.cron.update).toHaveBeenCalledWith({
        name: CronJob.LibraryScan,
        expression: systemConfigStub.libraryScan.library.scan.cronExpression,
        start: systemConfigStub.libraryScan.library.scan.enabled,
      });
    });
  });

  describe('handleSyncFiles', () => {
    beforeEach(() => {
      mocks.storage.stat.mockResolvedValue({
        size: 100,
        mtime: new Date('2023-01-01'),
        ctime: new Date('2023-01-01'),
      } as Stats);
    });

    it('should import a new asset', async () => {
      const library = factory.library();
      const asset = AssetFactory.create();

      const mockLibraryJob: ILibraryFileJob = {
        libraryId: library.id,
        paths: ['/data/user1/photo.jpg'],
      };

      mocks.asset.createAll.mockResolvedValue([asset.id]);
      mocks.library.get.mockResolvedValue(library);

      await expect(sut.handleSyncFiles(mockLibraryJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.createAll).toHaveBeenCalledWith([
        expect.objectContaining({
          ownerId: library.ownerId,
          libraryId: library.id,
          originalPath: '/data/user1/photo.jpg',
          type: AssetType.Image,
          originalFileName: 'photo.jpg',
          isExternal: true,
        }),
      ]);

      expect(mocks.event.emit).toHaveBeenCalledWith('AssetCreate', {
        asset: { id: asset.id, ownerId: library.ownerId },
      });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.SidecarCheck,
          data: {
            id: asset.id,
            source: 'upload',
          },
        },
      ]);
    });

    it("should not import into a deleted account's library (FL-78)", async () => {
      const library = factory.library();
      mocks.library.get.mockResolvedValue(library);
      mocks.user.get.mockResolvedValue(UserFactory.create({ deletedAt: new Date(), status: UserStatus.Deleted }));

      await expect(sut.handleSyncFiles({ libraryId: library.id, paths: ['/mnt/user1/photo.jpg'] })).resolves.toBe(
        JobStatus.Skipped,
      );
      expect(mocks.asset.createAll).not.toHaveBeenCalled();
    });

    it('should not import an asset to a soft deleted library', async () => {
      const library = factory.library({ deletedAt: new Date() });

      const mockLibraryJob: ILibraryFileJob = {
        libraryId: library.id,
        paths: ['/data/user1/photo.jpg'],
      };

      mocks.library.get.mockResolvedValue(library);

      await expect(sut.handleSyncFiles(mockLibraryJob)).resolves.toBe(JobStatus.Failed);

      expect(mocks.asset.createAll.mock.calls).toEqual([]);
    });
  });

  describe('delete', () => {
    it('should delete a library', async () => {
      const library = factory.library();

      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
      mocks.library.get.mockResolvedValue(library);

      mocks.library.getRemovalCounts.mockResolvedValue(removalCounts({ all: 3 }));
      await sut.delete(library.id);

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LibraryDelete, data: { id: library.id } });
      expect(mocks.library.softDelete).toHaveBeenCalledWith(library.id);
      expect(mocks.event.emit).toHaveBeenCalledWith('LibraryScanStop', {
        libraryId: library.id,
        reason: 'library_removed',
      });
    });

    it('should allow an external library to be deleted', async () => {
      const library = factory.library();

      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
      mocks.library.get.mockResolvedValue(library);

      await sut.delete(library.id);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibraryDelete,
        data: { id: library.id },
      });

      expect(mocks.library.softDelete).toHaveBeenCalledWith(library.id);
    });

    it('should unwatch an external library when deleted', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
      mocks.library.get.mockResolvedValue(library);
      mocks.library.getAll.mockResolvedValue([library]);

      const mockClose = vitest.fn();
      mocks.storage.watch.mockImplementation(makeMockWatcher({ close: mockClose }));
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
      // once soft deleted, the library no longer reads back
      mocks.library.softDelete.mockImplementation(() => {
        mocks.library.get.mockResolvedValue(undefined);
        return Promise.resolve();
      });
      await sut.delete(library.id);

      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('should return a library', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);

      await expect(sut.get(library.id)).resolves.toEqual(
        expect.objectContaining({
          id: library.id,
          name: library.name,
          ownerId: library.ownerId,
        }),
      );

      expect(mocks.library.get).toHaveBeenCalledWith(library.id);
    });

    it('should throw an error when a library is not found', async () => {
      const library = factory.library();

      await expect(sut.get(library.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.library.get).toHaveBeenCalledWith(library.id);
    });
  });

  describe('getStatistics', () => {
    it('should return library statistics', async () => {
      const library = factory.library();

      mocks.library.getStatistics.mockResolvedValue({
        photos: 10,
        videos: 0,
        total: 10,
        usage: 1337,
        usagePhysical: 1337,
      });
      await expect(sut.getStatistics(library.id)).resolves.toEqual({
        photos: 10,
        videos: 0,
        total: 10,
        usage: 1337,
        usagePhysical: 1337,
      });

      expect(mocks.library.getStatistics).toHaveBeenCalledWith(library.id);
    });
  });

  describe('create', () => {
    describe('external library', () => {
      it('should create with default settings', async () => {
        const library = factory.library();

        mocks.library.create.mockResolvedValue(library);
        await expect(sut.create({ ownerId: authStub.admin.user.id })).resolves.toEqual(
          expect.objectContaining({
            id: library.id,
            name: library.name,
            ownerId: library.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: library.createdAt,
            updatedAt: library.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(mocks.library.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expect.any(String),
            importPaths: [],
            exclusionPatterns: expect.any(Array),
          }),
        );
      });

      it('should create with name', async () => {
        const library = factory.library();

        mocks.library.create.mockResolvedValue(library);

        await expect(sut.create({ ownerId: authStub.admin.user.id, name: 'My Awesome Library' })).resolves.toEqual(
          expect.objectContaining({
            id: library.id,
            name: library.name,
            ownerId: library.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: library.createdAt,
            updatedAt: library.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(mocks.library.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'My Awesome Library',
            importPaths: [],
            exclusionPatterns: expect.any(Array),
          }),
        );
      });

      it('should create with import paths', async () => {
        const library = factory.library();

        mocks.library.create.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([]);
        mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
        mocks.storage.checkFileExists.mockResolvedValue(true);
        await expect(
          sut.create({
            ownerId: authStub.admin.user.id,
            importPaths: ['/mnt/images/', '/mnt/videos'],
          }),
        ).resolves.toEqual(
          expect.objectContaining({
            id: library.id,
            name: library.name,
            ownerId: library.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: library.createdAt,
            updatedAt: library.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(mocks.library.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expect.any(String),
            importPaths: ['/mnt/images', '/mnt/videos'],
            exclusionPatterns: expect.any(Array),
          }),
        );
      });

      it('should create watched with import paths', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.create.mockResolvedValue(library);
        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([]);
        mocks.cron.create.mockResolvedValue();

        mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
        mocks.storage.checkFileExists.mockResolvedValue(true);

        await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
        await sut.create({ ownerId: authStub.admin.user.id, importPaths: library.importPaths });

        expect(mocks.storage.watch).toHaveBeenCalledWith(library.importPaths, expect.anything(), expect.anything());
      });

      it('should refuse an owner account that is deleted (FL-78)', async () => {
        mocks.user.get.mockResolvedValue(UserFactory.create({ deletedAt: new Date(), status: UserStatus.Deleted }));

        await expect(sut.create({ ownerId: authStub.admin.user.id })).rejects.toThrow(
          'Choose an active account to own the library',
        );
        expect(mocks.library.create).not.toHaveBeenCalled();
      });

      it('should refuse an owner account that does not exist (FL-78)', async () => {
        mocks.user.get.mockResolvedValue(undefined);

        await expect(sut.create({ ownerId: newUuid() })).rejects.toBeInstanceOf(BadRequestException);
        expect(mocks.library.create).not.toHaveBeenCalled();
      });

      it('should refuse a folder that does not exist (FL-78)', async () => {
        mocks.library.getAll.mockResolvedValue([]);
        mocks.storage.stat.mockRejectedValue({ code: 'ENOENT' });

        await expect(sut.create({ ownerId: authStub.admin.user.id, importPaths: ['/mnt/missing'] })).rejects.toThrow(
          'Invalid import path: Path does not exist (ENOENT)',
        );
        expect(mocks.library.create).not.toHaveBeenCalled();
      });

      it('should refuse a folder this server cannot read (FL-78)', async () => {
        mocks.library.getAll.mockResolvedValue([]);
        mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
        mocks.storage.checkFileExists.mockResolvedValue(false);

        await expect(sut.create({ ownerId: authStub.admin.user.id, importPaths: ['/mnt/forbidden'] })).rejects.toThrow(
          'Invalid import path: Lacking read permission for folder',
        );
      });

      it('should refuse a folder another library already imports (FL-78)', async () => {
        mocks.library.getAll.mockResolvedValue([factory.library({ name: 'Family', importPaths: ['/mnt/photos'] })]);
        mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
        mocks.storage.checkFileExists.mockResolvedValue(true);

        await expect(
          sut.create({ ownerId: authStub.admin.user.id, importPaths: ['/mnt/photos/2024'] }),
        ).rejects.toThrow('Invalid import path: Import path overlaps an import path of library Family');
      });

      it('should refuse the same folder listed twice (FL-78)', async () => {
        mocks.library.getAll.mockResolvedValue([]);
        mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
        mocks.storage.checkFileExists.mockResolvedValue(true);

        await expect(
          sut.create({ ownerId: authStub.admin.user.id, importPaths: ['/mnt/photos', '/mnt/photos/'] }),
        ).rejects.toThrow('Invalid import path: Import path is listed more than once');
      });

      it('should create with exclusion patterns', async () => {
        const library = factory.library();

        mocks.library.create.mockResolvedValue(library);
        await expect(
          sut.create({
            ownerId: authStub.admin.user.id,
            exclusionPatterns: ['*.tmp', '*.bak'],
          }),
        ).resolves.toEqual(
          expect.objectContaining({
            id: library.id,
            name: library.name,
            ownerId: library.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: library.createdAt,
            updatedAt: library.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(mocks.library.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expect.any(String),
            importPaths: [],
            exclusionPatterns: ['*.tmp', '*.bak'],
          }),
        );
      });
    });
  });

  describe('getAll', () => {
    it('should get all libraries', async () => {
      const library = factory.library();

      mocks.library.getAll.mockResolvedValue([library]);

      await expect(sut.getAll()).resolves.toEqual([expect.objectContaining({ id: library.id })]);
    });
  });

  describe('handleQueueCleanup', () => {
    it('should queue cleanup jobs', async () => {
      const library1 = factory.library({ deletedAt: new Date() });
      const library2 = factory.library({ deletedAt: new Date() });

      mocks.library.getAllDeleted.mockResolvedValue([library1, library2]);
      await expect(sut.handleQueueCleanup()).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.LibraryDelete, data: { id: library1.id } },
        { name: JobName.LibraryDelete, data: { id: library2.id } },
      ]);
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      mocks.library.getAll.mockResolvedValue([]);
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
    });

    it('should throw an error if an import path is invalid', async () => {
      const library = factory.library();

      mocks.library.update.mockResolvedValue(library);
      mocks.library.get.mockResolvedValue(library);

      await expect(sut.update('library-id', { importPaths: ['foo/bar'] })).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.library.update).not.toHaveBeenCalled();
    });

    it('should update library', async () => {
      const library = factory.library();

      mocks.library.update.mockResolvedValue(library);
      mocks.library.get.mockResolvedValue(library);
      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
      mocks.storage.checkFileExists.mockResolvedValue(true);

      const cwd = process.cwd();

      await expect(sut.update('library-id', { importPaths: [`${cwd}/foo/bar`] })).resolves.toEqual(mapLibrary(library));
      expect(mocks.library.update).toHaveBeenCalledWith(
        'library-id',
        expect.objectContaining({ importPaths: [`${cwd}/foo/bar`] }),
      );
    });
  });

  describe('update (FL-78)', () => {
    beforeEach(() => {
      mocks.library.getAll.mockResolvedValue([]);
      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
      mocks.storage.checkFileExists.mockResolvedValue(true);
    });

    it('never changes the owner', async () => {
      const library = factory.library();
      mocks.library.get.mockResolvedValue(library);
      mocks.library.update.mockResolvedValue(library);

      await sut.update(library.id, { name: 'Renamed', ownerId: newUuid() } as never);

      expect(mocks.library.update).toHaveBeenCalledWith(library.id, {
        name: 'Renamed',
        importPaths: undefined,
        exclusionPatterns: undefined,
      });
    });

    it('stops a running scan when the folders change', async () => {
      const library = factory.library({ importPaths: ['/mnt/a'] });
      mocks.library.get.mockResolvedValue(library);
      mocks.library.update.mockResolvedValue({ ...library, importPaths: ['/mnt/b'] });

      await sut.update(library.id, { importPaths: ['/mnt/b'] });

      expect(mocks.event.emit).toHaveBeenCalledWith('LibraryScanStop', {
        libraryId: library.id,
        reason: 'paths_changed',
      });
    });

    it('leaves a running scan alone when only the name changes', async () => {
      const library = factory.library({ importPaths: ['/mnt/a'] });
      mocks.library.get.mockResolvedValue(library);
      mocks.library.update.mockResolvedValue({ ...library, name: 'Renamed' });

      await sut.update(library.id, { name: 'Renamed' });

      expect(mocks.event.emit).not.toHaveBeenCalledWith('LibraryScanStop', expect.anything());
    });

    it('refuses an unusable exclusion pattern', async () => {
      const library = factory.library();
      mocks.library.get.mockResolvedValue(library);

      await expect(sut.update(library.id, { exclusionPatterns: ['bad\u{0}'] })).rejects.toThrow(
        'Invalid exclusion pattern',
      );
      expect(mocks.library.update).not.toHaveBeenCalled();
    });

    it('re-watches the new folders when watching', async () => {
      const library = factory.library({ importPaths: ['/mnt/a'] });
      mocks.cron.create.mockResolvedValue();
      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
      const updated = { ...library, importPaths: ['/mnt/b'] };
      mocks.library.get.mockResolvedValueOnce(library).mockResolvedValue(updated);
      mocks.library.update.mockResolvedValue(updated);

      await sut.update(library.id, { importPaths: ['/mnt/b'] });

      expect(mocks.storage.watch).toHaveBeenCalledWith(['/mnt/b'], expect.anything(), expect.anything());
    });
  });

  it.each(['create', 'update'] as const)('rejects traversal before normalizing %s import paths', async (method) => {
    const library = factory.library();
    mocks.library.get.mockResolvedValue(library);
    mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
    mocks.storage.checkFileExists.mockResolvedValue(true);
    const importPaths = ['/mnt/archive/../private'];
    const request =
      method === 'create'
        ? sut.create({ ownerId: library.ownerId, importPaths })
        : sut.update(library.id, { importPaths });
    await expect(request).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.library.create).not.toHaveBeenCalled();
    expect(mocks.library.update).not.toHaveBeenCalled();
    expect(mocks.storage.stat).not.toHaveBeenCalled();
  });

  describe('two-stage removal (FL-78)', () => {
    it('reviews the consequences without changing anything', async () => {
      const library = factory.library({ name: 'Archive' });
      mocks.library.get.mockResolvedValue(library);
      mocks.library.getRemovalCounts.mockResolvedValue(
        removalCounts({ photos: 4, videos: 1, albums: 2, sharedLinks: 1, faces: 3, offline: 1, usage: 500, all: 6 }),
      );

      const review = await sut.getRemovalReview(library.id);

      expect(review).toEqual(
        expect.objectContaining({
          libraryId: library.id,
          name: 'Archive',
          photos: 4,
          videos: 1,
          total: 5,
          albums: 2,
          sharedLinks: 1,
          faces: 3,
          offline: 1,
          usage: 500,
          originalsKept: true,
          reviewToken: expect.any(String),
        }),
      );
      expect(mocks.library.softDelete).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('removes the library when the name and review still match', async () => {
      const library = factory.library({ name: 'Archive' });
      mocks.library.get.mockResolvedValue(library);
      mocks.library.getRemovalCounts.mockResolvedValue(removalCounts({ photos: 2, all: 9 }));
      const { reviewToken } = await sut.getRemovalReview(library.id);

      await sut.remove(authStub.admin, library.id, { reviewToken, confirmName: 'Archive' });

      expect(mocks.library.softDelete).toHaveBeenCalledWith(library.id);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LibraryDelete, data: { id: library.id } });
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.LibraryDeleted, detail: '2' }),
      ]);
    });

    it('refuses a removal whose typed name does not match', async () => {
      const library = factory.library({ name: 'Archive' });
      mocks.library.get.mockResolvedValue(library);
      mocks.library.getRemovalCounts.mockResolvedValue(removalCounts());
      const { reviewToken } = await sut.getRemovalReview(library.id);

      await expect(sut.remove(authStub.admin, library.id, { reviewToken, confirmName: 'archive' })).rejects.toThrow(
        'Type the library name to confirm',
      );
      expect(mocks.library.softDelete).not.toHaveBeenCalled();
    });

    it('refuses a removal when the library changed after the review', async () => {
      const library = factory.library({ name: 'Archive' });
      mocks.library.get.mockResolvedValue(library);
      mocks.library.getRemovalCounts.mockResolvedValue(removalCounts({ photos: 2, all: 2 }));
      const { reviewToken } = await sut.getRemovalReview(library.id);

      // a scan imported more since
      mocks.library.getRemovalCounts.mockResolvedValue(removalCounts({ photos: 9, all: 9 }));

      await expect(
        sut.remove(authStub.admin, library.id, { reviewToken, confirmName: 'Archive' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.library.softDelete).not.toHaveBeenCalled();
    });

    it('refuses a removal of a library that is already being removed', async () => {
      mocks.library.get.mockResolvedValue(undefined);

      await expect(
        sut.remove(authStub.admin, newUuid(), { reviewToken: 'token', confirmName: 'Archive' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('onShutdown', () => {
    it('should do nothing if instance does not have the watch lock', async () => {
      await sut.onShutdown();
    });
  });

  describe('watchAll', () => {
    it('should return false if instance does not have the watch lock', async () => {
      await expect(sut.watchAll()).resolves.toBe(false);
    });

    describe('watching disabled', () => {
      beforeEach(async () => {
        mocks.cron.create.mockResolvedValue();

        await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchDisabled as SystemConfig });
      });

      it('should not watch library', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.getAll.mockResolvedValue([library]);

        await sut.watchAll();

        expect(mocks.storage.watch).not.toHaveBeenCalled();
      });
    });

    describe('watching enabled', () => {
      beforeEach(async () => {
        mocks.library.getAll.mockResolvedValue([]);
        mocks.cron.create.mockResolvedValue();

        await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
      });

      it('should watch library', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);

        await sut.watchAll();

        expect(mocks.storage.watch).toHaveBeenCalledWith(library.importPaths, expect.anything(), expect.anything());
      });

      it('should watch and unwatch library', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.getAll.mockResolvedValue([library]);
        mocks.library.get.mockResolvedValue(library);
        const mockClose = vitest.fn();
        mocks.storage.watch.mockImplementation(makeMockWatcher({ close: mockClose }));

        await sut.watchAll();
        await sut.unwatch(library.id);

        expect(mockClose).toHaveBeenCalled();
      });

      it('should not watch library without import paths', async () => {
        const library = factory.library();

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);

        await sut.watchAll();

        expect(mocks.storage.watch).not.toHaveBeenCalled();
      });

      it('should handle a new file event', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
        mocks.storage.watch.mockImplementation(makeMockWatcher({ items: [{ event: 'add', value: '/foo/photo.jpg' }] }));

        await sut.watchAll();

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.LibrarySyncFiles,
          data: {
            libraryId: library.id,
            paths: ['/foo/photo.jpg'],
          },
        });
      });

      it('should handle a file change event', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'change', value: '/foo/photo.jpg' }] }),
        );

        await sut.watchAll();

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.LibrarySyncFiles,
          data: {
            libraryId: library.id,
            paths: ['/foo/photo.jpg'],
          },
        });
      });

      it('should handle a file unlink event', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });
        const asset = AssetFactory.create();

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(asset);
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'unlink', value: asset.originalPath }] }),
        );

        await sut.watchAll();

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.LibraryRemoveAsset,
          data: {
            libraryId: library.id,
            paths: [asset.originalPath],
          },
        });
      });

      it('should handle an error event', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });
        const asset = AssetFactory.create({ libraryId: library.id, isExternal: true });

        mocks.library.get.mockResolvedValue(library);
        mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(asset);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({
            items: [{ event: 'error', value: 'Error!' }],
          }),
        );

        await expect(sut.watchAll()).resolves.toBeUndefined();
      });

      it('should not import a file with unknown extension', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.storage.watch.mockImplementation(makeMockWatcher({ items: [{ event: 'add', value: '/foo/photo.xyz' }] }));

        await sut.watchAll();

        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('should ignore excluded paths', async () => {
        const library = factory.library({ importPaths: ['/xyz', '/asdf'], exclusionPatterns: ['**/dir1/**'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'add', value: '/dir1/photo.txt' }] }),
        );

        await sut.watchAll();

        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('should ignore excluded paths without case sensitivity', async () => {
        const library = factory.library({
          importPaths: ['/xyz', '/asdf'],
          exclusionPatterns: ['**/dir1/**'],
        });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'add', value: '/DIR1/photo.txt' }] }),
        );

        await sut.watchAll();

        expect(mocks.job.queue).not.toHaveBeenCalled();
      });
    });
  });

  describe('handleAssetRemoval (FL-78 watcher)', () => {
    const library = factory.library({ importPaths: ['/mnt/photos'] });

    beforeEach(() => {
      mocks.library.get.mockResolvedValue(library);
      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
    });

    it('marks an item offline, in the trash, when its file is gone and its folder is there', async () => {
      const asset = AssetFactory.create({ libraryId: library.id, originalPath: '/mnt/photos/a.jpg' });
      mocks.storage.checkFileExists.mockImplementation((path) => Promise.resolve(path === '/mnt/photos'));
      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(asset);

      await expect(sut.handleAssetRemoval({ libraryId: library.id, paths: [asset.originalPath] })).resolves.toBe(
        JobStatus.Success,
      );

      expect(mocks.asset.updateAll).toHaveBeenCalledWith([asset.id], { isOffline: true, deletedAt: expect.any(Date) });
      expect(mocks.asset.remove).not.toHaveBeenCalled();
    });

    it('keeps an already-trashed item in the trash, just offline', async () => {
      const asset = AssetFactory.create({ originalPath: '/mnt/photos/a.jpg', deletedAt: new Date() });
      mocks.storage.checkFileExists.mockImplementation((path) => Promise.resolve(path === '/mnt/photos'));
      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(asset);

      await sut.handleAssetRemoval({ libraryId: library.id, paths: [asset.originalPath] });

      expect(mocks.asset.updateAll).toHaveBeenCalledWith([asset.id], { isOffline: true });
    });

    it('changes nothing when the whole folder went away (an unmounted share)', async () => {
      mocks.storage.stat.mockRejectedValue({ code: 'ENOENT' });

      await sut.handleAssetRemoval({ libraryId: library.id, paths: ['/mnt/photos/a.jpg', '/mnt/photos/b.jpg'] });

      expect(mocks.asset.getByLibraryIdAndOriginalPath).not.toHaveBeenCalled();
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('changes nothing when the file is back by the time the job runs', async () => {
      mocks.storage.checkFileExists.mockResolvedValue(true);

      await sut.handleAssetRemoval({ libraryId: library.id, paths: ['/mnt/photos/a.jpg'] });

      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('ignores a path outside every import folder', async () => {
      await sut.handleAssetRemoval({ libraryId: library.id, paths: ['/elsewhere/a.jpg'] });

      expect(mocks.asset.getByLibraryIdAndOriginalPath).not.toHaveBeenCalled();
    });
  });

  describe('teardown', () => {
    it('should tear down all watchers', async () => {
      const library1 = factory.library({ importPaths: ['/foo', '/bar'] });
      const library2 = factory.library({ importPaths: ['/xyz', '/asdf'] });

      mocks.library.getAll.mockResolvedValue([library1, library2]);
      mocks.library.get.mockImplementation((id) =>
        Promise.resolve([library1, library2].find((library) => library.id === id)),
      );

      const mockClose = vitest.fn();
      mocks.storage.watch.mockImplementation(makeMockWatcher({ close: mockClose }));
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
      await sut.onShutdown();

      expect(mockClose).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleDeleteLibrary', () => {
    it('should delete an empty library', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.library.streamAssetIds.mockReturnValue(makeStream([]));

      await expect(sut.handleDeleteLibrary({ id: library.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.library.delete).toHaveBeenCalled();
    });

    it('should delete all assets in a library', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.library.streamAssetIds.mockReturnValue(makeStream([AssetFactory.create()]));

      await expect(sut.handleDeleteLibrary({ id: library.id })).resolves.toBe(JobStatus.Success);
    });
  });

  describe('validate', () => {
    it('should not require import paths', async () => {
      await expect(sut.validate('library-id', {})).resolves.toEqual({ importPaths: [] });
    });

    it('should validate directory', async () => {
      mocks.storage.stat.mockResolvedValue({
        isDirectory: () => true,
      } as Stats);

      mocks.storage.checkFileExists.mockResolvedValue(true);

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/',
            isValid: true,
            reason: LibraryImportPathReason.Valid,
          },
        ],
      });
    });

    it('should detect when path does not exist', async () => {
      mocks.storage.stat.mockImplementation(() => {
        const error = { code: 'ENOENT' } as any;
        throw error;
      });

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/',
            isValid: false,
            reason: LibraryImportPathReason.NotFound,
            message: 'Path does not exist (ENOENT)',
          },
        ],
      });
    });

    it('should detect when path is not a directory', async () => {
      mocks.storage.stat.mockResolvedValue({
        isDirectory: () => false,
      } as Stats);

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/file'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/file',
            isValid: false,
            reason: LibraryImportPathReason.NotDirectory,
            message: 'Not a directory',
          },
        ],
      });
    });

    it('should return an unknown exception from stat', async () => {
      mocks.storage.stat.mockImplementation(() => {
        throw new Error('Unknown error');
      });

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/',
            isValid: false,
            reason: LibraryImportPathReason.Unavailable,
            message: 'Error: Unknown error',
          },
        ],
      });
    });

    it('should detect when access rights are missing', async () => {
      mocks.storage.stat.mockResolvedValue({
        isDirectory: () => true,
      } as Stats);

      mocks.storage.checkFileExists.mockResolvedValue(false);

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/',
            isValid: false,
            reason: LibraryImportPathReason.NotReadable,
            message: 'Lacking read permission for folder',
          },
        ],
      });
    });

    it('should detect when import path is not absolute', async () => {
      const cwd = process.cwd();

      await expect(sut.validate('library-id', { importPaths: ['relative/path'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: 'relative/path',
            isValid: false,
            reason: LibraryImportPathReason.NotAbsolute,
            message: `Import path must be absolute, try ${cwd}/relative/path`,
          },
        ],
      });
    });

    it('should detect when import path is in immich media folder', async () => {
      const importPaths = ['/data/thumbs', `${process.cwd()}/xyz`, '/data/library'];
      const library = factory.library({ importPaths });

      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);

      mocks.storage.checkFileExists.mockImplementation((importPath) => Promise.resolve(importPath === importPaths[1]));

      await expect(sut.validate(library.id, { importPaths })).resolves.toEqual({
        importPaths: [
          {
            importPath: importPaths[0],
            isValid: false,
            reason: LibraryImportPathReason.UploadFolder,
            message: 'Cannot use media upload folder for external libraries',
          },
          {
            importPath: importPaths[1],
            isValid: true,
            reason: LibraryImportPathReason.Valid,
          },
          {
            importPath: importPaths[2],
            isValid: false,
            reason: LibraryImportPathReason.UploadFolder,
            message: 'Cannot use media upload folder for external libraries',
          },
        ],
      });
    });
  });

  describe('administrator history (FL-76)', () => {
    const entry = (library: { id: string; name: string; ownerId: string }, action: AdminAuditAction) => ({
      userId: library.ownerId,
      actorId: authStub.admin.user.id,
      libraryId: library.id,
      action,
      subject: library.name,
      detail: null,
    });

    it("records a new library in its owner's history", async () => {
      const library = factory.library();
      mocks.library.create.mockResolvedValue(library);

      await sut.create({ ownerId: library.ownerId }, authStub.admin);

      expect(mocks.adminAudit.create).toHaveBeenCalledWith([entry(library, AdminAuditAction.LibraryCreated)]);
    });

    it('records a settings change', async () => {
      const library = factory.library();
      mocks.library.get.mockResolvedValue(library);
      mocks.library.update.mockResolvedValue(library);

      await sut.update(library.id, { name: library.name }, authStub.admin);

      expect(mocks.adminAudit.create).toHaveBeenCalledWith([entry(library, AdminAuditAction.LibraryUpdated)]);
    });

    it('records a removal', async () => {
      const library = factory.library();
      mocks.library.get.mockResolvedValue(library);

      await sut.delete(library.id, authStub.admin);

      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        { ...entry(library, AdminAuditAction.LibraryDeleted), detail: '0' },
      ]);
    });

    it('records nothing for a library that does not exist', async () => {
      mocks.library.get.mockResolvedValue(void 0);

      await expect(sut.delete(newUuid(), authStub.admin)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.adminAudit.create).not.toHaveBeenCalled();
    });
  });
});
