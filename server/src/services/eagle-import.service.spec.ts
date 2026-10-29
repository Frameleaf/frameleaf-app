import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { type FileHandle, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import type { EagleImportRepository } from 'src/repositories/eagle-import.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { Mock } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { LibraryScope } from 'src/enum.js';
import { EagleLibraryRepository } from 'src/repositories/eagle-library.repository.js';
import { TakeoutStagingError, type TakeoutStagingRepository } from 'src/repositories/takeout-staging.repository.js';
import { EagleImportWorkerService } from 'src/services/eagle-import-worker.service.js';
import { EagleImportService } from 'src/services/eagle-import.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';

type AnyMock = Mock<(...args: any[]) => any>;

/**
 * The real repository, except that folders are listed by name: these tests run on any machine,
 * while the server itself lists only through a checked handle on Linux (see the repository spec).
 */
class AnyPlatformLibraryRepository extends EagleLibraryRepository {
  override isAvailable() {
    return Promise.resolve(true);
  }
  protected override listOpenDirectory(_handle: FileHandle, directory: string): Promise<Dirent[]> {
    return readdir(directory, { withFileTypes: true });
  }
}

const admin: AuthDto = { user: { ...authStub.admin.user, isAdmin: true }, session: { id: 'session' } as never };
const created = new Date('2026-10-29T10:00:00.000Z');

/** A small Eagle library on disk: two nested folders, a file in two of them, a loose one and a font. */
async function writeLibrary(root: string) {
  const library = path.join(root, 'Design', 'Studio References.library');
  const item = async (id: string, details: Record<string, unknown>, file?: string) => {
    const folder = path.join(library, 'images', `${id}.info`);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'metadata.json'), JSON.stringify({ id, ...details }));
    if (file) {
      await writeFile(path.join(folder, file), `bytes of ${id}`);
    }
  };
  await mkdir(library, { recursive: true });
  await writeFile(
    path.join(library, 'metadata.json'),
    JSON.stringify({
      folders: [
        {
          id: 'F1',
          name: 'Web',
          iconColor: 'blue',
          children: [{ id: 'F2', name: 'Hero sections', iconColor: 'orange', children: [] }],
        },
        { id: 'F3', name: 'Type', children: [] },
      ],
      modificationTime: 1_790_000_000_000,
    }),
  );
  await item(
    'I1',
    {
      name: 'hero',
      ext: 'jpg',
      folders: ['F2', 'F3'],
      tags: ['warm', 'hero'],
      star: 5,
      annotation: 'Keep',
      url: 'https://example.com/hero',
      modificationTime: 1_789_000_000_000,
    },
    'hero.jpg',
  );
  await item('I2', { name: 'loose', ext: 'png', modificationTime: 1_789_000_000_000 }, 'loose.png');
  await item('I3', { name: 'already', ext: 'png', folders: ['F3'], star: 2, modificationTime: 1 }, 'already.png');
  await item('I4', { name: 'Lodge Serif', ext: 'otf' }, 'Lodge Serif.otf');
  return library;
}

describe('FL-653 Eagle import from a server folder', () => {
  let root: string;
  let libraryPath: string;
  let repository: Record<string, AnyMock>;
  let staging: Record<string, AnyMock>;
  let service: EagleImportService;
  const logger = { setContext: vitest.fn(), log: vitest.fn(), warn: vitest.fn(), debug: vitest.fn() };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'eagle-import-'));
    libraryPath = await writeLibrary(root);
    repository = {
      findResumable: vitest.fn().mockResolvedValue(undefined),
      create: vitest.fn((input) => Promise.resolve({ ...row(), ...input })),
      restart: vitest.fn(),
      counts: vitest.fn().mockResolvedValue({ done: 0, already: 0 }),
      outcomes: vitest.fn().mockResolvedValue([]),
      getOwned: vitest.fn(),
      requestStop: vitest.fn(),
      listUnfinished: vitest.fn().mockResolvedValue([]),
    };
    staging = {
      resolveDirectory: vitest.fn((base: string, relative: string) => Promise.resolve(path.resolve(base, relative))),
      isInsideRoots: vitest.fn().mockResolvedValue(true),
      copyToLibrary: vitest.fn(),
    };
    service = new EagleImportService(
      logger as unknown as LoggingRepository,
      { getEnv: () => ({ storage: { importRoots: [root] } }) } as unknown as ConfigRepository,
      repository as unknown as EagleImportRepository,
      new AnyPlatformLibraryRepository(),
      staging as unknown as TakeoutStagingRepository,
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: '0f9a1b2c-3d4e-4f50-8a1b-2c3d4e5f6a7b',
    ownerId: admin.user.id,
    rootId: '0',
    relativePath: 'Design/Studio References.library',
    libraryPath,
    libraryName: 'Studio References.library',
    fingerprint: '',
    target: { mode: 'inside', inside: 'new' },
    existingTop: [],
    status: 'running',
    total: 0,
    rootAlbumId: null,
    albums: {},
    tagIds: {},
    failed: [],
    recent: [],
    error: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  });

  it('says a server that can’t list through a checked handle can’t import from its folders', async () => {
    class Unavailable extends EagleLibraryRepository {
      override isAvailable() {
        return Promise.resolve(false);
      }
    }
    const unavailable = new EagleImportService(
      logger as unknown as LoggingRepository,
      { getEnv: () => ({ storage: { importRoots: [root] } }) } as unknown as ConfigRepository,
      repository as unknown as EagleImportRepository,
      new Unavailable(),
      staging as unknown as TakeoutStagingRepository,
    );
    await expect(unavailable.listLibraries(admin)).resolves.toEqual({ available: false, roots: 1, libraries: [] });
    await expect(
      unavailable.check(admin, { rootId: '0', path: 'Design/Studio References.library' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  describe('who may choose a server folder', () => {
    it.each([
      ['someone who is not an administrator', { ...authStub.user1, session: { id: 's' } as never }],
      ['an API key, even an administrator’s', { ...admin, apiKey: { id: 'k' } as never }],
      ['a shared link', { ...admin, sharedLink: authStub.adminSharedLink.sharedLink }],
    ])('refuses %s', async (_name, auth) => {
      await expect(service.listLibraries(auth as AuthDto)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.check(auth as AuthDto, { rootId: '0', path: 'x.library' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('lists the libraries in the permitted import folders', async () => {
      await expect(service.listLibraries(admin)).resolves.toEqual({
        available: true,
        roots: 1,
        libraries: [
          {
            rootId: '0',
            path: path.join('Design', 'Studio References.library'),
            name: 'Studio References.library',
          },
        ],
      });
    });

    it('refuses a folder that is not one of them, or not a library', async () => {
      await expect(service.check(admin, { rootId: '3', path: 'x.library' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.check(admin, { rootId: '0', path: 'Design' })).rejects.toThrow(/ends in .library/);
      staging.resolveDirectory.mockRejectedValue(new TakeoutStagingError('Choose a folder inside it'));
      await expect(service.check(admin, { rootId: '0', path: '../etc.library' })).rejects.toThrow(
        'Choose a folder inside it',
      );
    });
  });

  it('reads the library for the check, with folders flat and parents first', async () => {
    const library = await service.check(admin, { rootId: '0', path: 'Design/Studio References.library' });
    expect(library.folders.map(({ id, parentId }) => [id, parentId])).toEqual([
      ['F1', null],
      ['F2', 'F1'],
      ['F3', null],
    ]);
    expect(library.items.map(({ id, present }) => [id, present])).toEqual([
      ['I1', true],
      ['I2', true],
      ['I3', true],
      ['I4', true],
    ]);
    expect(library.supported).toContain('jpg');
    expect(library.supported).not.toContain('otf');
    expect(JSON.stringify(library)).not.toContain(root);
  });

  it('refuses to start on a library that changed since the check', async () => {
    await expect(
      service.create(admin, {
        rootId: '0',
        path: 'Design/Studio References.library',
        fingerprint: 'stale',
        targetMode: 'top',
        existingTop: [],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('carries on an earlier import of the same library instead of starting another', async () => {
    const { fingerprint } = await service.check(admin, { rootId: '0', path: 'Design/Studio References.library' });
    repository.findResumable.mockResolvedValue(row({ status: 'stopped', fingerprint }));
    repository.restart.mockResolvedValue(row({ status: 'running', fingerprint }));
    const started = await service.create(admin, {
      rootId: '0',
      path: 'Design/Studio References.library',
      fingerprint,
      targetMode: 'inside',
      existingTop: [],
    });
    expect(started.status).toBe('running');
    expect(repository.create).not.toHaveBeenCalled();
    expect(JSON.stringify(started)).not.toContain(root);
    // The names it started with stay: a carry-on sent before the collections loaded can't clear them.
    expect(repository.restart).toHaveBeenCalledWith(expect.any(String), { target: { mode: 'inside', inside: 'new' } });
  });

  describe('the worker', () => {
    const workerId = expect.any(String);
    let albums: { create: AnyMock; addAssetsToAlbums: AnyMock };
    let tags: { upsert: AnyMock; bulkTagAssets: AnyMock };
    let assets: { update: AnyMock };
    let sources: { addImported: AnyMock; setAddedDate: AnyMock };
    let assetMedia: { uploadAsset: AnyMock };
    let assetRepository: { getById: AnyMock };
    let worker: EagleImportWorkerService;
    let fingerprint: string;
    let status: string;

    beforeEach(async () => {
      StorageCore.setMediaLocation('/data');
      fingerprint = (await service.check(admin, { rootId: '0', path: 'Design/Studio References.library' })).fingerprint;
      status = 'running';
      Object.assign(repository, {
        save: vitest.fn().mockResolvedValue(undefined),
        finish: vitest.fn().mockResolvedValue(undefined),
        release: vitest.fn().mockResolvedValue(undefined),
        renew: vitest.fn(() => Promise.resolve(status)),
        addOutcome: vitest.fn().mockResolvedValue(true),
      });
      let album = 0;
      albums = {
        create: vitest.fn(() => Promise.resolve({ id: `album-${++album}` })),
        addAssetsToAlbums: vitest.fn().mockResolvedValue({}),
      };
      tags = {
        upsert: vitest.fn((_auth, { tags }: { tags: string[] }) =>
          Promise.resolve(tags.map((value) => ({ id: `tag-${value}`, value }))),
        ),
        bulkTagAssets: vitest.fn().mockResolvedValue({}),
      };
      assets = { update: vitest.fn().mockResolvedValue({}) };
      sources = {
        addImported: vitest.fn().mockResolvedValue({}),
        setAddedDate: vitest.fn().mockResolvedValue(undefined),
      };
      staging.copyToLibrary.mockImplementation((_from: string, size: number) =>
        Promise.resolve({ size, checksum: Buffer.from('aa', 'hex'), legacyChecksum: Buffer.from('bb', 'hex') }),
      );
      assetMedia = {
        uploadAsset: vitest.fn((_auth, dto: { filename: string }) =>
          Promise.resolve(
            dto.filename === 'already.png'
              ? { id: 'existing-already', status: AssetMediaStatus.DUPLICATE }
              : { id: `asset-${dto.filename}`, status: AssetMediaStatus.CREATED },
          ),
        ),
      };
      assetRepository = {
        getById: vitest.fn().mockResolvedValue({
          id: 'existing-already',
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
          exifInfo: { rating: 4, description: '' },
        }),
      };
      worker = new EagleImportWorkerService(
        logger as unknown as LoggingRepository,
        repository as unknown as EagleImportRepository,
        new AnyPlatformLibraryRepository(),
        staging as unknown as TakeoutStagingRepository,
        {
          get: vitest.fn().mockResolvedValue({ ...admin.user, quotaUsageInBytes: 0, quotaSizeInBytes: null }),
        } as never,
        { getEnv: () => ({ storage: { importRoots: [root] } }) } as never,
        assetRepository as never,
        assetMedia as never,
        assets as never,
        albums as never,
        tags as never,
        sources as never,
        service,
      );
    });

    it('imports into a new "Studio References", nested, coloured, tagged, described and dated as in Eagle', async () => {
      await worker.run(row({ fingerprint }) as never);

      expect(albums.create.mock.calls.map(([, dto]) => dto)).toEqual([
        { albumName: 'Studio References', libraryScope: LibraryScope.Design },
        { albumName: 'Web', libraryScope: LibraryScope.Design, parentId: 'album-1', color: 'blue' },
        { albumName: 'Hero sections', libraryScope: LibraryScope.Design, parentId: 'album-2', color: 'amber' },
        { albumName: 'Type', libraryScope: LibraryScope.Design, parentId: 'album-1' },
      ]);
      // The font doesn't come over; the rest go through the upload path, into Boards only.
      expect(assetMedia.uploadAsset.mock.calls.map(([, dto]) => [dto.filename, dto.libraryScope])).toEqual([
        ['hero.jpg', LibraryScope.Design],
        ['loose.png', LibraryScope.Design],
        ['already.png', LibraryScope.Design],
      ]);
      expect(albums.addAssetsToAlbums).toHaveBeenCalledWith(expect.anything(), {
        albumIds: ['album-3', 'album-4'],
        assetIds: ['asset-hero.jpg'],
      });
      // Not in a folder: into the chosen collection.
      expect(albums.addAssetsToAlbums).toHaveBeenCalledWith(expect.anything(), {
        albumIds: ['album-1'],
        assetIds: ['asset-loose.png'],
      });
      expect(tags.bulkTagAssets).toHaveBeenCalledWith(expect.anything(), {
        assetIds: ['asset-hero.jpg'],
        tagIds: ['tag-warm', 'tag-hero'],
      });
      expect(assets.update).toHaveBeenCalledWith(expect.anything(), 'asset-hero.jpg', {
        rating: 5,
        description: 'Keep',
      });
      // Already in the library with a rating of its own: the rating is kept.
      expect(assets.update).not.toHaveBeenCalledWith(expect.anything(), 'existing-already', expect.anything());
      expect(sources.addImported).toHaveBeenCalledWith(expect.anything(), 'asset-hero.jpg', {
        importedFrom: 'eagle',
        pageUrl: 'https://example.com/hero',
      });
      expect(sources.setAddedDate.mock.calls.map(([, id, dto]) => [id, dto.addedAt])).toEqual([
        ['asset-hero.jpg', new Date(1_789_000_000_000).toISOString()],
        ['asset-loose.png', new Date(1_789_000_000_000).toISOString()],
      ]);
      expect(repository.addOutcome.mock.calls.map((call) => call.slice(2))).toEqual([
        ['I1', 'asset-hero.jpg', false],
        ['I2', 'asset-loose.png', false],
        ['I3', 'existing-already', true],
      ]);
      expect(repository.save).toHaveBeenCalledWith(expect.any(String), workerId, { total: 3 });
      expect(repository.finish).toHaveBeenCalledWith(expect.any(String), workerId, 'finished');
    });

    it('carries on without making collections, tags or items again', async () => {
      repository.outcomes.mockResolvedValue([{ itemId: 'I1', assetId: 'asset-hero.jpg', duplicate: false }]);
      await worker.run(
        row({
          fingerprint,
          rootAlbumId: 'album-root',
          albums: { F1: 'a1', F2: 'a2', F3: 'a3' },
          tagIds: {},
        }) as never,
      );
      expect(albums.create).not.toHaveBeenCalled();
      expect(tags.upsert).not.toHaveBeenCalled();
      expect(assetMedia.uploadAsset.mock.calls.map(([, dto]) => dto.filename)).toEqual(['loose.png', 'already.png']);
    });

    it('stops after the item in hand when Stop was pressed', async () => {
      repository.renew.mockImplementation(() =>
        Promise.resolve(assetMedia.uploadAsset.mock.calls.length > 0 ? 'stopping' : 'running'),
      );
      await worker.run(row({ fingerprint }) as never);
      expect(assetMedia.uploadAsset).toHaveBeenCalledTimes(1);
      expect(repository.finish).toHaveBeenCalledWith(expect.any(String), workerId, 'stopped');
    });

    it('lists an item that could not come over and goes on with the next', async () => {
      assetMedia.uploadAsset.mockRejectedValueOnce(new Error('disk full'));
      await worker.run(row({ fingerprint }) as never);
      expect(repository.addOutcome).toHaveBeenCalledTimes(2);
      expect(repository.save).toHaveBeenCalledWith(expect.any(String), workerId, { failed: ['I1'] });
      expect(repository.finish).toHaveBeenCalledWith(expect.any(String), workerId, 'finished');
    });

    it('copies from the checked handle, never by opening the path again', async () => {
      await worker.run(row({ fingerprint }) as never);
      const [source] = staging.copyToLibrary.mock.calls[0];
      expect(typeof source).toBe('object');
      expect(source).toHaveProperty('fd');
    });

    it('writes nothing more once another worker took the import part-way through an item', async () => {
      repository.addOutcome.mockResolvedValue(false);
      await worker.run(row({ fingerprint }) as never);
      expect(assetMedia.uploadAsset).toHaveBeenCalledTimes(1);
      expect(repository.release).toHaveBeenCalled();
      expect(repository.finish).not.toHaveBeenCalled();
    });

    it('cuts a long copy short when the lease is lost while it runs', async () => {
      vitest.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        staging.copyToLibrary.mockImplementationOnce(
          (_from: unknown, _size: number, _to: string, signal: AbortSignal) =>
            new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
        );
        repository.renew.mockImplementation(() =>
          Promise.resolve(staging.copyToLibrary.mock.calls.length > 0 ? undefined : 'running'),
        );
        const running = worker.run(row({ fingerprint }) as never);
        await vitest.waitFor(() => expect(staging.copyToLibrary).toHaveBeenCalled());
        await vitest.advanceTimersByTimeAsync(30_000);
        await running;
        expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
        expect(repository.release).toHaveBeenCalled();
        expect(repository.finish).not.toHaveBeenCalled();
      } finally {
        vitest.useRealTimers();
      }
    });

    describe('once the lease is lost part-way', () => {
      beforeEach(() => {
        vitest.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      });
      afterEach(() => {
        vitest.useRealTimers();
      });
      const loseLease = async () => {
        repository.renew.mockResolvedValue(undefined);
        await vitest.advanceTimersByTimeAsync(30_000);
      };

      it('makes no "Studio References" collection', async () => {
        let release!: () => void;
        repository.save.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
        const running = worker.run(row({ fingerprint }) as never);
        await vitest.waitFor(() => expect(release).toBeDefined());
        await loseLease();
        release();
        await running;
        expect(albums.create).not.toHaveBeenCalled();
        expect(repository.release).toHaveBeenCalled();
      });

      it('writes no rating, note or Added date for the item in hand', async () => {
        let release!: () => void;
        albums.addAssetsToAlbums.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({}))));
        const running = worker.run(row({ fingerprint }) as never);
        await vitest.waitFor(() => expect(release).toBeDefined());
        await loseLease();
        release();
        await running;
        expect(assets.update).not.toHaveBeenCalled();
        expect(sources.setAddedDate).not.toHaveBeenCalled();
        expect(sources.addImported).not.toHaveBeenCalled();
        expect(repository.addOutcome).not.toHaveBeenCalled();
      });

      it('stops before the last confirmed lease runs out when renewals keep failing', async () => {
        let release!: () => void;
        albums.addAssetsToAlbums.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({}))));
        const running = worker.run(row({ fingerprint }) as never);
        await vitest.waitFor(() => expect(release).toBeDefined());
        repository.renew.mockRejectedValue(new Error('database unreachable'));
        // One failed renewal with time left on the lease: the run carries on.
        await vitest.advanceTimersByTimeAsync(30_000);
        expect(repository.release).not.toHaveBeenCalled();
        // By the heartbeat before the lease would end, it has stopped.
        await vitest.advanceTimersByTimeAsync(60_000);
        release();
        await running;
        expect(repository.release).toHaveBeenCalled();
        expect(repository.addOutcome).not.toHaveBeenCalled();
      });
    });

    it('lets the import go, without ending it, when another worker has it', async () => {
      repository.renew.mockResolvedValue(undefined);
      await worker.run(row({ fingerprint }) as never);
      expect(repository.release).toHaveBeenCalled();
      expect(repository.finish).not.toHaveBeenCalled();
    });

    it('stops with a reason when the library changed or the folder is no longer allowed', async () => {
      await worker.run(row({ fingerprint: 'other' }) as never);
      expect(repository.finish).toHaveBeenLastCalledWith(
        expect.any(String),
        workerId,
        'stopped',
        expect.stringMatching(/changed since it was checked/),
      );
      staging.isInsideRoots.mockResolvedValue(false);
      await worker.run(row({ fingerprint }) as never);
      expect(repository.finish).toHaveBeenLastCalledWith(
        expect.any(String),
        workerId,
        'stopped',
        expect.stringMatching(/no longer one the server may import from/),
      );
      expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
    });
  });
});
