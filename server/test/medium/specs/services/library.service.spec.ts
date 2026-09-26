import { Kysely } from 'kysely';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AdminAuditAction,
  AssetLockReason,
  AssetStatus,
  JobName,
  JobStatus,
  LibraryImportPathReason,
  MediaOperationKind,
  MediaOperationStatus,
} from 'src/enum.js';
import { AdminAuditRepository } from 'src/repositories/admin-audit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { LibraryScanService } from 'src/services/library-scan.service.js';
import { LibraryService } from 'src/services/library.service.js';
import { libraryAssetFromFile, libraryPathsFingerprint } from 'src/utils/library-scan.js';
import { MediumTestContext, testAssetsDir } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

// `validateImportPath` checks candidate paths against the media location
StorageCore.setMediaLocation('/photos');

let defaultDatabase: Kysely<DB>;

const fileModifiedAt = new Date(1_700_000_000_000);

const createFile = async (filePath: string, modifiedAt: Date = fileModifiedAt) => {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, 'test');
  await utimes(filePath, modifiedAt, modifiedAt);
  return filePath;
};

const copyTestAsset = async (source: string, filePath: string, modifiedAt: Date = fileModifiedAt) => {
  await mkdir(dirname(filePath), { recursive: true });
  await copyFile(join(testAssetsDir, source), filePath);
  await utimes(filePath, modifiedAt, modifiedAt);
  return filePath;
};

class LibraryTestContext extends MediumTestContext<typeof LibraryService> {
  constructor(database: Kysely<DB>) {
    super(LibraryService, {
      database,
      real: [
        AdminAuditRepository,
        AssetRepository,
        AssetJobRepository,
        CryptoRepository,
        LibraryRepository,
        StorageRepository,
        UserRepository,
      ],
      mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
    });

    const jobs = this.getMock(JobRepository);
    jobs.queue.mockResolvedValue();
    jobs.queueAll.mockResolvedValue();

    this.getMock(EventRepository).emit.mockResolvedValue();
    this.getMock(WebsocketRepository).serverSend.mockReturnValue();
  }

  async createLibrary(options: { importPaths?: string[]; exclusionPatterns?: string[] } = {}) {
    const { user } = await this.newUser();
    return this.get(LibraryRepository).create({
      ownerId: user.id,
      name: 'Medium test library',
      importPaths: options.importPaths ?? [],
      exclusionPatterns: options.exclusionPatterns ?? [],
    });
  }

  /** The durable scan worker (FL-78), on the same database and repositories as the service. */
  scans() {
    return new LibraryScanService(
      this.getMock(LoggingRepository) as never,
      new MediaOperationRepository(this.database),
      this.get(LibraryRepository),
      this.get(AssetRepository),
      this.get(AssetJobRepository),
      this.get(StorageRepository),
      this.getMock(JobRepository) as never,
      this.get(UserRepository),
      this.getMock(EventRepository) as never,
      this.get(CryptoRepository),
      this.get(AdminAuditRepository),
    );
  }

  /** Queues a scan and runs it to its end, returning the scan job as it finished. */
  async scan(libraryId: string) {
    const scans = this.scans();
    const library = await this.get(LibraryRepository).get(libraryId);
    await scans.queue(library!, { ownerId: library!.ownerId, trigger: 'manual' });
    await scans.drain();
    const [operation] = await new MediaOperationRepository(this.database).getLatestBySubject(
      MediaOperationKind.LibraryScan,
      'libraryId',
      [libraryId],
    );
    return operation;
  }

  /** The paths a library scan left visible, i.e. neither offline nor trashed */
  async getAssetPaths(libraryId: string) {
    const assets = await this.database
      .selectFrom('asset')
      .select('originalPath')
      .where('libraryId', '=', libraryId)
      .where('deletedAt', 'is', null)
      .execute();

    return assets.map(({ originalPath }) => originalPath).sort();
  }
}

const setup = (db?: Kysely<DB>) => {
  const ctx = new LibraryTestContext(db || defaultDatabase);
  return { sut: ctx.sut, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(LibraryService.name, () => {
  let tempDir: string;
  let importRoot: string;
  let importPath: string;
  let excludedPath: string;
  let outsidePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'immich-library-'));
    importRoot = join(tempDir, 'libraries/offline');
    importPath = join(importRoot, 'in-path');
    excludedPath = join(importRoot, 'excluded');
    outsidePath = join(tempDir, 'libraries/outside');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create an external library with defaults', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      await expect(sut.create({ ownerId: user.id })).resolves.toEqual(
        expect.objectContaining({
          ownerId: user.id,
          name: 'New External Library',
          refreshedAt: null,
          assetCount: 0,
          importPaths: [],
          exclusionPatterns: expect.any(Array),
        }),
      );
    });

    it('should create an external library with options', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      await mkdir(importPath, { recursive: true });

      await expect(
        sut.create({
          ownerId: user.id,
          name: 'My Awesome Library',
          importPaths: [importPath],
          exclusionPatterns: ['**/Raw/**'],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          name: 'My Awesome Library',
          importPaths: [importPath],
          exclusionPatterns: ['**/Raw/**'],
        }),
      );
    });

    it("should record the new library in its owner's administrator history (FL-76)", async () => {
      const { sut, ctx } = setup();
      const { user: admin } = await ctx.newUser({ isAdmin: true });
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: admin.id, isAdmin: true } });

      const library = await sut.create({ ownerId: user.id, name: 'Family archive' }, auth);

      await expect(ctx.get(AdminAuditRepository).getByUserId(user.id, { take: 10 })).resolves.toEqual([
        expect.objectContaining({
          userId: user.id,
          actorId: admin.id,
          actorName: admin.name,
          libraryId: library.id,
          action: AdminAuditAction.LibraryCreated,
          subject: 'Family archive',
          detail: null,
        }),
      ]);
    });
  });

  describe('get', () => {
    it('should get a library by id', async () => {
      const { sut, ctx } = setup();
      const library = await ctx.createLibrary({ importPaths: [importPath] });

      await expect(sut.get(library.id)).resolves.toEqual(
        expect.objectContaining({
          id: library.id,
          ownerId: library.ownerId,
          refreshedAt: null,
          assetCount: 0,
          importPaths: [importPath],
          exclusionPatterns: [],
        }),
      );
    });

    it('should throw an error when the library does not exist', async () => {
      const { sut } = setup();

      await expect(sut.get(newUuid())).rejects.toThrow('Library not found');
    });
  });

  describe('update', () => {
    it('should change the library name', async () => {
      const { sut, ctx } = setup();
      const library = await ctx.createLibrary({ importPaths: [importPath] });

      await expect(sut.update(library.id, { name: 'New Library Name' })).resolves.toEqual(
        expect.objectContaining({ name: 'New Library Name' }),
      );
    });

    it('should change the import paths', async () => {
      const { sut, ctx } = setup();
      await mkdir(importPath, { recursive: true });
      const library = await ctx.createLibrary();

      await expect(sut.update(library.id, { importPaths: [importPath] })).resolves.toEqual(
        expect.objectContaining({ importPaths: [importPath] }),
      );
    });

    it('should reject an import path that does not exist', async () => {
      const { sut, ctx } = setup();
      const library = await ctx.createLibrary();

      await expect(sut.update(library.id, { importPaths: [join(tempDir, 'missing')] })).rejects.toThrow(
        'Invalid import path: Path does not exist (ENOENT)',
      );
    });

    it('should change the exclusion patterns', async () => {
      const { sut, ctx } = setup();
      const library = await ctx.createLibrary({ importPaths: [importPath] });

      await expect(sut.update(library.id, { exclusionPatterns: ['**/Raw/**'] })).resolves.toEqual(
        expect.objectContaining({ exclusionPatterns: ['**/Raw/**'] }),
      );
    });
  });

  describe('validate', () => {
    it('should pass with no import paths', async () => {
      const { sut } = setup();

      await expect(sut.validate(newUuid(), { importPaths: [] })).resolves.toEqual({ importPaths: [] });
    });

    it('should fail if the path does not exist', async () => {
      const { sut } = setup();
      const missingPath = join(tempDir, 'does/not/exist');

      await expect(sut.validate(newUuid(), { importPaths: [missingPath] })).resolves.toEqual({
        importPaths: [
          {
            importPath: missingPath,
            isValid: false,
            reason: LibraryImportPathReason.NotFound,
            message: 'Path does not exist (ENOENT)',
          },
        ],
      });
    });

    it('should fail if the path is not absolute', async () => {
      const { sut } = setup();

      await expect(sut.validate(newUuid(), { importPaths: ['relative/path'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: 'relative/path',
            isValid: false,
            reason: LibraryImportPathReason.NotAbsolute,
            message: `Import path must be absolute, try ${resolve('relative/path')}`,
          },
        ],
      });
    });

    it('should fail if the path is a file', async () => {
      const { sut } = setup();
      const filePath = await createFile(join(importPath, 'assetA.png'));

      await expect(sut.validate(newUuid(), { importPaths: [filePath] })).resolves.toEqual({
        importPaths: [
          {
            importPath: filePath,
            isValid: false,
            reason: LibraryImportPathReason.NotDirectory,
            message: 'Not a directory',
          },
        ],
      });
    });
  });

  describe('handleDeleteLibrary', () => {
    it('should delete an empty library', async () => {
      const { sut, ctx } = setup();
      const libraryRepo = ctx.get(LibraryRepository);
      const library = await ctx.createLibrary({ importPaths: [importPath] });

      await sut.delete(library.id);

      // the library is hidden right away, but the row survives until the job runs
      await expect(libraryRepo.get(library.id)).resolves.toBeUndefined();
      await expect(libraryRepo.get(library.id, true)).resolves.toEqual(expect.objectContaining({ id: library.id }));
      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: JobName.LibraryDelete,
        data: { id: library.id },
      });

      await expect(sut.handleDeleteLibrary({ id: library.id })).resolves.toBe(JobStatus.Success);

      await expect(libraryRepo.get(library.id, true)).resolves.toBeUndefined();
    });

    it('should delete a library with assets without deleting the files', async () => {
      const { sut, ctx } = setup();
      const libraryRepo = ctx.get(LibraryRepository);
      const jobs = ctx.getMock(JobRepository);
      const assetA = await createFile(join(importPath, 'assetA.png'));
      const assetB = await createFile(join(importPath, 'assetB.png'));
      const library = await ctx.createLibrary({ importPaths: [importPath] });

      await ctx.scan(library.id);
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([assetA, assetB].sort());

      await sut.delete(library.id);
      await expect(libraryRepo.get(library.id)).resolves.toBeUndefined();

      jobs.queueAll.mockClear();
      await expect(sut.handleDeleteLibrary({ id: library.id })).resolves.toBe(JobStatus.Success);

      // the assets are trashed and queued for removal, so the library row stays until they are gone
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([]);
      await expect(libraryRepo.get(library.id, true)).resolves.toEqual(expect.objectContaining({ id: library.id }));
      // deleteOnDisk is what keeps the files of an external library, so assert it explicitly
      expect(jobs.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetDelete, data: { id: expect.any(String), deleteOnDisk: false } },
        { name: JobName.AssetDelete, data: { id: expect.any(String), deleteOnDisk: false } },
      ]);

      // the asset delete jobs are only queued here, so this just proves the handler itself unlinks nothing
      expect(existsSync(assetA)).toBe(true);
      expect(existsSync(assetB)).toBe(true);
    });
  });

  describe('scan', () => {
    it('should import a new asset', async () => {
      const { ctx } = setup();

      const assetPath = await createFile(join(importPath, 'assetA.png'));
      const library = await ctx.createLibrary({ importPaths: [importPath] });

      await ctx.scan(library.id);

      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([assetPath]);
    });

    it('should scan multiple import paths', async () => {
      const { ctx } = setup();

      const directoryA = join(importRoot, 'directoryA');
      const directoryB = join(importRoot, 'directoryB');
      const assetA = await createFile(join(directoryA, 'assetA.png'));
      const assetB = await createFile(join(directoryB, 'assetB.png'));
      const library = await ctx.createLibrary({ importPaths: [directoryA, directoryB] });

      await ctx.scan(library.id);

      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([assetA, assetB].sort());
    });

    // https://github.com/immich-app/immich/issues/10699
    it('should scan multiple import paths with commas', async () => {
      const { ctx } = setup();

      const folderA = join(importRoot, 'folder, a');
      const folderB = join(importRoot, 'folder, b');
      const assetA = await createFile(join(folderA, 'assetA.png'));
      const assetB = await createFile(join(folderB, 'assetB.png'));
      const library = await ctx.createLibrary({ importPaths: [folderA, folderB] });

      await ctx.scan(library.id);

      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([assetA, assetB].sort());
    });

    // https://github.com/immich-app/immich/issues/10699
    it('should scan multiple import paths with braces', async () => {
      const { ctx } = setup();

      const folderA = join(importRoot, 'folder{ a');
      const folderB = join(importRoot, 'folder} b');
      const assetA = await createFile(join(folderA, 'assetA.png'));
      const assetB = await createFile(join(folderB, 'assetB.png'));
      const library = await ctx.createLibrary({ importPaths: [folderA, folderB] });

      await ctx.scan(library.id);

      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([assetA, assetB].sort());
    });

    // We never got backslashes to work
    const annoyingChars = [
      "'",
      '"',
      '`',
      '*',
      '{',
      '}',
      ',',
      '(',
      ')',
      '[',
      ']',
      '?',
      '!',
      '@',
      '#',
      '$',
      '%',
      '^',
      '&',
      '=',
      '+',
      '~',
      '|',
      '<',
      '>',
      ';',
      ':',
      '/',
    ];

    it.each(annoyingChars)('should scan multiple import paths with %s', async (char) => {
      const { ctx } = setup();

      const folderA = join(importRoot, `folder${char}1`);
      const folderB = join(importRoot, `folder${char}2`);
      const asset1 = await createFile(join(folderA, 'asset1.png'));
      const asset2 = await createFile(join(folderB, 'asset2.png'));
      const library = await ctx.createLibrary({ importPaths: [folderA, folderB] });

      await ctx.scan(library.id);

      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([asset1, asset2].sort());
    });

    it('should not import assets covered by an exclusion pattern', async () => {
      const { ctx } = setup();

      await createFile(join(importRoot, 'directoryA/assetA.png'));
      const assetB = await createFile(join(importRoot, 'directoryB/assetB.png'));
      const library = await ctx.createLibrary({
        importPaths: [importRoot],
        exclusionPatterns: ['**/directoryA/**'],
      });

      await ctx.scan(library.id);

      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([assetB]);
    });

    it('should not import assets covered by multiple exclusion patterns', async () => {
      const { ctx } = setup();

      await createFile(join(importRoot, 'directoryA/assetA.png'));
      await createFile(join(importRoot, 'directoryB/assetB.png'));
      const library = await ctx.createLibrary({
        importPaths: [importRoot],
        exclusionPatterns: ['**/directoryA/**', '**/directoryB/**'],
      });

      await ctx.scan(library.id);

      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([]);
    });

    it('should offline assets covered by a new exclusion pattern', async () => {
      const { sut, ctx } = setup();

      const assetA = await createFile(join(importRoot, 'directoryA/assetA.png'));
      const assetB = await createFile(join(importRoot, 'directoryB/assetB.png'));
      const library = await ctx.createLibrary({ importPaths: [importRoot] });

      await ctx.scan(library.id);
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([assetA, assetB].sort());

      await sut.update(library.id, { exclusionPatterns: ['**/directoryA/**'] });
      await ctx.scan(library.id);
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([assetB]);

      await sut.update(library.id, { exclusionPatterns: ['**/directoryA/**', '**/directoryB/**'] });
      await ctx.scan(library.id);
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([]);
    });

    // https://github.com/immich-app/immich/issues/17121
    it('should respect exclusion patterns when using multiple import paths', async () => {
      const { sut, ctx } = setup();

      const inPath = join(importRoot, 'exclusion');
      const secondPath = join(importRoot, 'exclusion2');
      const asset1 = await createFile(join(inPath, 'asset1.png'));
      const asset2 = await createFile(join(inPath, 'Raw/asset2.png'));
      await createFile(join(secondPath, 'asset3.png'));
      const library = await ctx.createLibrary({ importPaths: [`${inPath}/`, `${secondPath}/`] });

      // scanning twice must be idempotent
      await ctx.scan(library.id);
      const all = [asset1, asset2, join(secondPath, 'asset3.png')].sort();
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual(all);
      await ctx.scan(library.id);
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual(all);

      await sut.update(library.id, { exclusionPatterns: ['**/Raw/**'] });

      await ctx.scan(library.id);
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([asset1, join(secondPath, 'asset3.png')].sort());
    });

    it('should fail, marking nothing missing, when an import folder does not exist (FL-78)', async () => {
      const { ctx } = setup();

      const inPath = join(importRoot, 'present');
      const missingPath = join(importRoot, 'unmounted');
      const asset1 = await createFile(join(inPath, 'asset1.png'));
      const asset2 = await createFile(join(missingPath, 'asset2.png'));
      const library = await ctx.createLibrary({ importPaths: [inPath, missingPath] });
      await ctx.scan(library.id);
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([asset1, asset2].sort());

      await rm(missingPath, { recursive: true, force: true });
      const scan = await ctx.scan(library.id);

      expect(scan).toEqual(
        expect.objectContaining({
          status: MediaOperationStatus.Queued,
          errorCode: 'library_source_unavailable',
          error: expect.stringContaining(missingPath),
        }),
      );
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([asset1, asset2].sort());
    });

    it('should fail, marking nothing missing, when an import folder comes back empty (FL-78)', async () => {
      const { ctx } = setup();

      const asset1 = await createFile(join(importPath, 'asset1.png'));
      const asset2 = await createFile(join(importPath, 'asset2.png'));
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      await ctx.scan(library.id);

      // an unmounted share leaves an empty mount point behind
      await rm(asset1);
      await rm(asset2);
      const scan = await ctx.scan(library.id);

      expect(scan).toEqual(expect.objectContaining({ errorCode: 'library_source_empty' }));
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([asset1, asset2].sort());
    });

    it('should mark a missing file offline when its folder is still there (FL-78)', async () => {
      const { ctx } = setup();

      const asset1 = await createFile(join(importPath, 'asset1.png'));
      const asset2 = await createFile(join(importPath, 'asset2.png'));
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      await ctx.scan(library.id);

      await rm(asset2);
      const scan = await ctx.scan(library.id);

      expect(scan).toEqual(expect.objectContaining({ status: MediaOperationStatus.Completed }));
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([asset1]);
      await expect(ctx.get(LibraryRepository).get(library.id)).resolves.toEqual(
        expect.objectContaining({ refreshedAt: expect.any(Date) }),
      );
    });

    it('should answer a second scan request with the one already waiting (FL-78)', async () => {
      const { ctx } = setup();
      await createFile(join(importPath, 'asset1.png'));
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      const scans = ctx.scans();

      const [first, second] = await Promise.all([
        scans.queue(library, { ownerId: library.ownerId, trigger: 'manual' }),
        scans.queue(library, { ownerId: library.ownerId, trigger: 'manual' }),
      ]);

      expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
      expect(first.operation.id).toBe(second.operation.id);
      await scans.drain();
    });

    const annoyingExclusionPatterns = ['@', '#', '$', '%', '^', '&', '='];

    it.each(annoyingExclusionPatterns)('should support exclusion patterns with %s', async (char) => {
      const { sut, ctx } = setup();

      const inPath = join(importRoot, 'exclusion');
      const excludedFolder = `${char}folder`;
      const asset1 = await createFile(join(inPath, 'asset1.png'));
      const asset2 = await createFile(join(inPath, excludedFolder, 'asset2.png'));
      const library = await ctx.createLibrary({ importPaths: [inPath] });

      await ctx.scan(library.id);
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([asset1, asset2].sort());

      await sut.update(library.id, { exclusionPatterns: [`**/${excludedFolder}/**`] });

      await ctx.scan(library.id);
      await expect(ctx.getAssetPaths(library.id)).resolves.toEqual([asset1]);
    });
  });

  describe('scan: settings-driven offlining', () => {
    it('should set an asset offline if its file is not in any import path', async () => {
      const { ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        originalPath: await createFile(join(outsidePath, 'offline.png')),
        isExternal: true,
        isOffline: false,
        status: AssetStatus.Active,
      });

      await mkdir(importPath, { recursive: true });
      await expect(ctx.scan(library.id)).resolves.toEqual(
        expect.objectContaining({ status: MediaOperationStatus.Completed }),
      );

      const updated = await assetRepo.getById(asset.id);
      expect(updated).toEqual(expect.objectContaining({ isOffline: true }));
      expect(updated?.deletedAt).toBeInstanceOf(Date);
    });

    it('should set an asset offline if its file is covered by an exclusion pattern', async () => {
      const { ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);
      const library = await ctx.createLibrary({
        importPaths: [importRoot],
        exclusionPatterns: ['**/excluded/**'],
      });

      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        originalPath: await createFile(join(excludedPath, 'offline.png')),
        isExternal: true,
        isOffline: false,
        status: AssetStatus.Active,
      });

      await mkdir(importPath, { recursive: true });
      await expect(ctx.scan(library.id)).resolves.toEqual(
        expect.objectContaining({ status: MediaOperationStatus.Completed }),
      );

      const updated = await assetRepo.getById(asset.id);
      expect(updated).toEqual(expect.objectContaining({ isOffline: true }));
      expect(updated?.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('scan: checking existing items', () => {
    it('should set an asset offline if its file is missing', async () => {
      const { ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        // the file is intentionally never created on disk; its folder is there with another file
        originalPath: join(importPath, 'offline.png'),
        isExternal: true,
        isOffline: false,
        status: AssetStatus.Active,
      });
      await createFile(join(importPath, 'still-here.png'));

      await expect(ctx.scan(library.id)).resolves.toEqual(
        expect.objectContaining({ status: MediaOperationStatus.Completed }),
      );

      const updated = await assetRepo.getById(asset.id);
      expect(updated).toEqual(expect.objectContaining({ isOffline: true }));
      expect(updated?.deletedAt).toBeInstanceOf(Date);
    });

    it('should not set an asset offline if file exists in import path and is not excluded', async () => {
      const { ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);
      const library = await ctx.createLibrary({
        importPaths: [importRoot],
        exclusionPatterns: ['**/excluded/**'],
      });

      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        originalPath: await createFile(join(importPath, 'online.png')),
        fileModifiedAt,
        isExternal: true,
        isOffline: false,
        status: AssetStatus.Active,
      });

      await expect(ctx.scan(library.id)).resolves.toEqual(
        expect.objectContaining({ status: MediaOperationStatus.Completed }),
      );

      const updated = await assetRepo.getById(asset.id);
      expect(updated).toEqual(expect.objectContaining({ isOffline: false }));
      expect(updated?.deletedAt).toBeNull();
    });

    it('should set an offline asset to online if its file exists in an import path and is not excluded', async () => {
      const { ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        originalPath: await createFile(join(importPath, 'offline.png')),
        isExternal: true,
        isOffline: true,
        deletedAt: new Date(),
        status: AssetStatus.Active,
      });

      await expect(ctx.scan(library.id)).resolves.toEqual(
        expect.objectContaining({ status: MediaOperationStatus.Completed }),
      );

      const updated = await assetRepo.getById(asset.id);
      expect(updated).toEqual(expect.objectContaining({ isOffline: false }));
      expect(updated?.deletedAt).toBeNull();
    });

    it('should not set an offline asset to online if its file exists in an import path but is excluded', async () => {
      const { ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);
      const library = await ctx.createLibrary({
        importPaths: [importRoot],
        exclusionPatterns: ['**/excluded/**'],
      });

      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        originalPath: await createFile(join(excludedPath, 'offline.png')),
        isExternal: true,
        isOffline: true,
        deletedAt: new Date(),
        status: AssetStatus.Active,
      });

      await expect(ctx.scan(library.id)).resolves.toEqual(
        expect.objectContaining({ status: MediaOperationStatus.Completed }),
      );

      const updated = await assetRepo.getById(asset.id);
      expect(updated).toEqual(expect.objectContaining({ isOffline: true }));
      expect(updated?.deletedAt).toBeInstanceOf(Date);
    });

    it('should keep an offline asset offline if it is outside import paths', async () => {
      const { ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        originalPath: await createFile(join(outsidePath, 'offline.png')),
        isExternal: true,
        isOffline: true,
        deletedAt: new Date(),
        status: AssetStatus.Active,
      });
      await mkdir(importPath, { recursive: true });

      await expect(ctx.scan(library.id)).resolves.toEqual(
        expect.objectContaining({ status: MediaOperationStatus.Completed }),
      );

      const updated = await assetRepo.getById(asset.id);
      expect(updated).toEqual(expect.objectContaining({ isOffline: true }));
      expect(updated?.deletedAt).toBeInstanceOf(Date);
    });

    it('should set a trashed asset offline if its file is missing', async () => {
      const { ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        // the file is intentionally never created on disk
        originalPath: join(importPath, 'offline.png'),
        isExternal: true,
        isOffline: false,
        deletedAt: new Date(),
        status: AssetStatus.Trashed,
      });
      await mkdir(importPath, { recursive: true });

      await expect(ctx.scan(library.id)).resolves.toEqual(
        expect.objectContaining({ status: MediaOperationStatus.Completed }),
      );

      const updated = await assetRepo.getById(asset.id);
      expect(updated).toEqual(expect.objectContaining({ isOffline: true }));
      expect(updated?.deletedAt).toBeInstanceOf(Date);
    });

    it('should set a trashed offline asset to online but keep it in trash', async () => {
      const { ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        originalPath: await createFile(join(importPath, 'offline.png')),
        isExternal: true,
        isOffline: true,
        deletedAt: new Date(),
        status: AssetStatus.Trashed,
      });

      await expect(ctx.scan(library.id)).resolves.toEqual(
        expect.objectContaining({ status: MediaOperationStatus.Completed }),
      );

      const updated = await assetRepo.getById(asset.id);
      expect(updated).toEqual(expect.objectContaining({ isOffline: false }));
      expect(updated?.deletedAt).toBeInstanceOf(Date);
    });

    it('should queue sidecar checks for assets whose file changed', async () => {
      const { ctx } = setup();
      const jobs = ctx.getMock(JobRepository);
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      const rawPath = await copyTestAsset('formats/raw/Nikon/D80/glarus.nef', join(importPath, 'glarus.nef'));

      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        originalPath: rawPath,
        // the file on disk has a newer modified time
        fileModifiedAt: new Date(fileModifiedAt.valueOf() - 1000),
        isExternal: true,
        isOffline: false,
        status: AssetStatus.Active,
      });

      await expect(ctx.scan(library.id)).resolves.toEqual(
        expect.objectContaining({ status: MediaOperationStatus.Completed }),
      );

      expect(jobs.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.SidecarCheck,
          data: { id: asset.id, source: 'upload' },
        },
      ]);
    });

    it('should not queue sidecar checks for unchanged assets', async () => {
      const { ctx } = setup();
      const jobs = ctx.getMock(JobRepository);
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      const rawPath = await copyTestAsset('formats/raw/Nikon/D80/glarus.nef', join(importPath, 'glarus.nef'));

      await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        originalPath: rawPath,
        fileModifiedAt,
        isExternal: true,
        isOffline: false,
        status: AssetStatus.Active,
      });

      await expect(ctx.scan(library.id)).resolves.toEqual(
        expect.objectContaining({ status: MediaOperationStatus.Completed }),
      );

      expect(jobs.queueAll).not.toHaveBeenCalled();
    });
  });

  describe('handleSyncFiles', () => {
    it('should queue sidecar checks for newly imported assets', async () => {
      const { sut, ctx } = setup();
      const jobs = ctx.getMock(JobRepository);
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      const rawPath = await copyTestAsset('formats/raw/Nikon/D80/glarus.nef', join(importPath, 'glarus.nef'));

      await expect(
        sut.handleSyncFiles({
          libraryId: library.id,
          paths: [rawPath],
          progressCounter: 1,
        }),
      ).resolves.toBe(JobStatus.Success);

      expect(jobs.queueAll).toHaveBeenCalledWith([
        expect.objectContaining({
          name: JobName.SidecarCheck,
          data: expect.objectContaining({ id: expect.any(String) }),
        }),
      ]);
    });
  });

  describe('removal review (FL-78)', () => {
    it('counts what a removal takes with it and confirms against it', async () => {
      const { sut, ctx } = setup();
      const asset1 = await createFile(join(importPath, 'asset1.png'));
      await createFile(join(importPath, 'asset2.png'));
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      await ctx.scan(library.id);
      const [{ id: assetId }] = await ctx.database
        .selectFrom('asset')
        .select('id')
        .where('originalPath', '=', asset1)
        .execute();
      const { album } = await ctx.newAlbum({ ownerId: library.ownerId });
      await ctx.newAlbumAsset({ albumId: album.id, assetId });

      const review = await sut.getRemovalReview(library.id);

      expect(review).toEqual(
        expect.objectContaining({ total: 2, photos: 2, albums: 1, sharedLinks: 0, originalsKept: true }),
      );

      await sut.remove(factory.auth(), library.id, { reviewToken: review.reviewToken, confirmName: library.name });
      await expect(ctx.get(LibraryRepository).get(library.id)).resolves.toBeUndefined();
      expect(existsSync(asset1)).toBe(true);
    });
  });

  describe('scan mutation fence', () => {
    const claimedScan = async () => {
      const { ctx } = setup();
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      const { operation } = await ctx.scans().queue(library, { ownerId: library.ownerId, trigger: 'manual' });
      const operations = new MediaOperationRepository(defaultDatabase);
      const claim = { operation, claimToken: newUuid() };
      await defaultDatabase
        .updateTable('media_operation')
        .set({
          status: MediaOperationStatus.Rendering,
          claimToken: claim.claimToken,
          claimExpiresAt: new Date(Date.now() + 60_000),
        })
        .where('id', '=', operation.id)
        .execute();
      return {
        ctx,
        library,
        operations,
        claim: {
          operationId: claim.operation.id,
          claimToken: claim.claimToken,
          libraryId: library.id,
          fingerprint: libraryPathsFingerprint(library),
        },
      };
    };

    it.each(['replacement', 'expired', 'cancelled', 'paths', 'removed', 'owner'])(
      'rejects asset mutations after %s changes',
      async (change) => {
        const { ctx, library, claim } = await claimedScan();
        switch (change) {
          case 'replacement': {
            await defaultDatabase
              .updateTable('media_operation')
              .set({ claimToken: newUuid() })
              .where('id', '=', claim.operationId)
              .execute();
            break;
          }
          case 'expired': {
            await defaultDatabase
              .updateTable('media_operation')
              .set({ claimExpiresAt: new Date(0) })
              .where('id', '=', claim.operationId)
              .execute();
            break;
          }
          case 'cancelled': {
            await defaultDatabase
              .updateTable('media_operation')
              .set({ status: MediaOperationStatus.Cancelling })
              .where('id', '=', claim.operationId)
              .execute();
            break;
          }
          case 'paths': {
            await ctx.get(LibraryRepository).update(library.id, { importPaths: ['/different'] });
            break;
          }
          case 'removed': {
            await ctx.get(LibraryRepository).softDelete(library.id);
            break;
          }
          case 'owner': {
            await defaultDatabase
              .updateTable('user')
              .set({ deletedAt: new Date() })
              .where('id', '=', library.ownerId)
              .execute();
            // No default
            break;
          }
        }
        const mutate = vi.fn().mockResolvedValue(true);
        await ctx.get(LibraryRepository).withScanClaim(claim, mutate);
        expect(mutate).not.toHaveBeenCalled();
      },
    );

    it('rolls back asset creation with its claim transaction', async () => {
      const { ctx, library, claim } = await claimedScan();
      await expect(
        ctx.get(LibraryRepository).withScanClaim(claim, async (assets) => {
          await assets.createAll([
            libraryAssetFromFile(
              { path: join(importPath, 'file.jpg'), mtime: new Date() },
              { ownerId: library.ownerId, libraryId: library.id },
              () => Buffer.from('checksum'),
              false,
            ),
          ]);
          throw new Error('abort batch');
        }),
      ).rejects.toThrow('abort batch');
      expect(await ctx.get(AssetRepository).getLibraryAssetCount(library.id)).toBe(0);
    });

    it('does not let a stale scan cancel its replacement', async () => {
      const { operations, claim } = await claimedScan();
      const replacement = newUuid();
      await defaultDatabase
        .updateTable('media_operation')
        .set({ claimToken: replacement })
        .where('id', '=', claim.operationId)
        .execute();
      const operation = await defaultDatabase
        .selectFrom('media_operation')
        .selectAll()
        .where('id', '=', claim.operationId)
        .executeTakeFirstOrThrow();
      expect(await operations.requestCancel(claim.operationId, operation.ownerId, claim.claimToken)).toBeUndefined();
      expect(await operations.getForOwner(claim.operationId, operation.ownerId)).toMatchObject({
        claimToken: replacement,
        status: MediaOperationStatus.Rendering,
        cancelRequestedAt: null,
      });
    });
  });

  describe('managed uploads (FL-78)', () => {
    it('excludes Locked originals from managed and external byte totals', async () => {
      const { ctx } = setup();
      const library = await ctx.createLibrary();
      for (const libraryId of [null, library.id]) {
        const { asset } = await ctx.newAsset({
          ownerId: library.ownerId,
          libraryId,
          originalPath: `/test/${libraryId ?? 'managed'}.jpg`,
        });
        await ctx
          .get(AssetRepository)
          .upsertExif({ exif: { assetId: asset.id!, fileSizeInByte: 1234 }, lockedPropertiesBehavior: 'override' });
        await ctx.get(AssetRepository).lock([asset.id!], AssetLockReason.Marked, library.ownerId);
        const { asset: visible } = await ctx.newAsset({
          ownerId: library.ownerId,
          libraryId,
          originalPath: `/test/${libraryId ?? 'managed'}-visible.jpg`,
        });
        await ctx.get(AssetRepository).upsertExif({
          exif: { assetId: visible.id!, fileSizeInByte: 567 },
          lockedPropertiesBehavior: 'override',
        });
      }
      const repository = ctx.get(LibraryRepository);
      expect(await repository.getStatistics(library.id)).toMatchObject({ total: 1, usage: 567, usagePhysical: 567 });
      expect(
        (await repository.getManagedUploadStatistics()).find((row) => row.ownerId === library.ownerId),
      ).toMatchObject({ total: 1, usage: 567, usagePhysical: 567 });
    });

    it("counts an account's uploads and leaves its external library items out", async () => {
      const { sut, ctx } = setup();
      await createFile(join(importPath, 'asset1.png'));
      const library = await ctx.createLibrary({ importPaths: [importPath] });
      await ctx.scan(library.id);
      await ctx.newAsset({ ownerId: library.ownerId });

      const rows = await sut.getManagedUploads();

      expect(rows.find((row) => row.ownerId === library.ownerId)).toEqual(
        expect.objectContaining({ photos: 1, total: 1 }),
      );
    });
  });
});
