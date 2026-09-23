import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { TakeoutStagingError } from 'src/repositories/takeout-staging.repository.js';
import { TakeoutImport, TakeoutItem, TakeoutOperation, TakeoutSource } from 'src/repositories/takeout.repository.js';
import { TAKEOUT_MAX_ATTEMPTS, TakeoutService } from 'src/services/takeout.service.js';
import { TAKEOUT_DEFAULT_OPTIONS, TakeoutPhase } from 'src/utils/takeout.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newAccessRepositoryMock } from 'test/repositories/access.repository.mock.js';

const importId = '0195e2a0-0000-7000-8000-000000000001';
const itemId = '6f1c1a0e-1111-4111-8111-111111111111';

const rowOf = (phase: TakeoutPhase, overrides: Partial<TakeoutImport> = {}): TakeoutImport => ({
  id: importId,
  ownerId: authStub.user1.user.id,
  name: 'Google Photos import',
  phase,
  options: { ...TAKEOUT_DEFAULT_OPTIONS },
  runOperationId: null,
  createdAt: new Date('2026-09-23T10:00:00.000Z'),
  updatedAt: new Date('2026-09-23T10:00:00.000Z'),
  ...overrides,
});

const operationOf = (action: 'scan' | 'import', status: MediaOperationStatus): TakeoutOperation => ({
  id: '0195e2a0-0000-7000-8000-0000000000aa',
  status,
  snapshot: { importId, action },
  processedUnits: 3,
  totalUnits: 10,
  error: null,
  errorCode: null,
});

const archive = (overrides: Partial<TakeoutSource> = {}): TakeoutSource => ({
  id: '0195e2a0-0000-7000-8000-0000000000c1',
  importId,
  name: 'takeout-001.zip',
  kind: 'zip',
  path: '/data/takeout/user/import/a.zip',
  size: 100,
  received: 100,
  rejected: 0,
  scanned: false,
  ...overrides,
});

const itemOf = (overrides: Partial<TakeoutItem> = {}): TakeoutItem => ({
  id: itemId,
  importId,
  state: 'review',
  metadata: { title: 'IMG_1.jpg' },
  sidecarId: null,
  candidates: [
    {
      id: '6f1c1a0e-2222-4222-8222-222222222222',
      path: 'Trip/IMG_1.jpg.json',
      metadata: { title: 'IMG_1.jpg', description: 'one' },
    },
    {
      id: '6f1c1a0e-3333-4333-8333-333333333333',
      path: 'Trip/IMG_1(1).json',
      metadata: { title: 'IMG_1.jpg', description: 'two' },
    },
  ],
  albums: ['Trip'],
  warnings: ['ambiguous_sidecar'],
  locked: false,
  assetId: null,
  resultKind: null,
  createPath: null,
  withheld: false,
  error: null,
  relativePath: 'Trip/IMG_1.jpg',
  folder: 'Trip',
  name: 'IMG_1.jpg',
  kind: 'image',
  path: '/data/takeout/user/import/file',
  size: 10,
  checksum: Buffer.alloc(32),
  legacyChecksum: Buffer.alloc(20),
  modifiedAt: new Date(0),
  sourceName: 'takeout-001.zip',
  ...overrides,
});

const emptyCounts = {
  ready: 0,
  review: 0,
  importing: 0,
  imported: 0,
  matched: 0,
  skipped: 0,
  failed: 0,
  files: 0,
  items: 0,
  suggestedPairs: 0,
  unresolvedPairs: 0,
  hiddenLocked: 0,
  rejected: 0,
};

describe(TakeoutService.name, () => {
  let sut: TakeoutService;
  let row: TakeoutImport;
  let operations: TakeoutOperation[];
  let sources: TakeoutSource[];
  let repository: Record<string, any>;
  let staging: Record<string, any>;
  let mediaOperations: Record<string, any>;
  let access: ReturnType<typeof newAccessRepositoryMock>;
  let importRoots: string[];
  const tx = {};

  beforeEach(() => {
    row = rowOf('sources');
    operations = [];
    sources = [archive()];
    importRoots = ['/imports'];
    repository = {
      list: vi.fn(() => Promise.resolve([row])),
      get: vi.fn(() => Promise.resolve(row)),
      create: vi.fn(() => Promise.resolve(row)),
      withImport: vi.fn((_owner: string, _id: string, fn: (...args: unknown[]) => unknown) =>
        fn(
          tx,
          row,
          operations.find((operation) =>
            row.phase === 'scanning' || row.phase === 'review'
              ? operation.snapshot.action === 'scan'
              : operation.snapshot.action === 'import',
          ),
        ),
      ),
      latestOperations: vi.fn(() => Promise.resolve(operations.map((operation) => ({ importId, operation })))),
      sources: vi.fn(() => Promise.resolve(sources)),
      sourcesIn: vi.fn(() => Promise.resolve(sources)),
      addSource: vi.fn((_tx: unknown, source: Partial<TakeoutSource>) =>
        Promise.resolve(archive({ ...source, id: '0195e2a0-0000-7000-8000-0000000000c2', received: 0 })),
      ),
      setSourcePath: vi.fn(),
      removeSource: vi.fn(),
      setPhase: vi.fn(),
      setOptions: vi.fn(),
      countReview: vi.fn().mockResolvedValue({ total: 0, locked: 0 }),
      releaseReview: vi.fn(),
      counts: vi.fn().mockResolvedValue({ ...emptyCounts }),
      albums: vi.fn().mockResolvedValue([]),
      matchSummary: vi.fn().mockResolvedValue({ newAssets: 0, matchedOriginals: 0 }),
      items: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      lockItem: vi.fn(),
      updateDecision: vi.fn(),
      pairs: vi.fn().mockResolvedValue({ pairs: [], total: 0 }),
      decidePair: vi.fn(),
      delete: vi.fn(),
      writeChunk: vi.fn(),
      insertOperation: vi.fn((_tx: unknown, values: Record<string, unknown>) =>
        Promise.resolve({ id: '0195e2a0-0000-7000-8000-0000000000bb', ...values }),
      ),
      stagedArchiveBytes: vi.fn(() => Promise.resolve(sources.reduce((total, item) => total + item.size, 0))),
      sourceFilePaths: vi.fn().mockResolvedValue([]),
    };
    staging = {
      prepare: vi.fn().mockResolvedValue('/data/takeout/user/import'),
      freeBytes: vi.fn().mockResolvedValue(10 * 1024 ** 4),
      resolveDirectory: vi.fn().mockResolvedValue('/imports/Takeout'),
      remove: vi.fn(),
      removeImport: vi.fn(),
      removeOwner: vi.fn(),
      writeChunk: vi.fn(),
      verifyChunk: vi.fn(),
    };
    mediaOperations = { pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
    access = newAccessRepositoryMock();
    const config = { getEnv: () => ({ storage: { importRoots } }) };
    const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    sut = new TakeoutService(
      logger as never,
      repository as never,
      staging as never,
      mediaOperations as never,
      access as never,
      config as never,
    );
  });

  describe('get', () => {
    it('answers not found for an import that is not the caller’s', async () => {
      repository.get.mockResolvedValue(undefined);
      await expect(sut.get(authStub.user1, importId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reports a running scan with its growing progress', async () => {
      row = rowOf('scanning');
      operations = [operationOf('scan', MediaOperationStatus.Rendering)];

      const result = await sut.get(authStub.user1, importId);

      expect(result).toMatchObject({ state: 'scanning', action: 'scan', processed: 3, total: 10 });
      // Never matched against the library while a job is working.
      expect(repository.matchSummary).not.toHaveBeenCalled();
    });

    it('never names a server path', async () => {
      const result = await sut.get(authStub.user1, importId);
      expect(JSON.stringify(result)).not.toContain('/data/takeout');
    });

    it('counts Locked items for a locked session and only for it', async () => {
      row = rowOf('review');
      repository.counts.mockResolvedValue({ ...emptyCounts, hiddenLocked: 4 });

      expect((await sut.get(authStub.user1, importId)).counts.hiddenLocked).toBe(4);
      expect((await sut.get(authStub.adminWithElevatedPermission, importId)).counts.hiddenLocked).toBe(0);
    });

    it('refuses a shared link', async () => {
      await expect(sut.get(authStub.adminSharedLink as AuthDto, importId)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('create', () => {
    it('lets only an administrator import from a server folder', async () => {
      await expect(
        sut.create(authStub.user1, { name: 'Import', rootId: '0', directory: 'Takeout' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(staging.resolveDirectory).not.toHaveBeenCalled();
    });

    it('accepts only a configured root, named by the server, never a path from the browser', async () => {
      await expect(
        sut.create(authStub.admin, { name: 'Import', rootId: '/etc', directory: '' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.create(authStub.admin, { name: 'Import', rootId: '7' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('resolves the folder inside the root and records it with the import', async () => {
      await sut.create(authStub.admin, { name: 'Import', rootId: '0', directory: 'Takeout' });

      expect(staging.resolveDirectory).toHaveBeenCalledWith('/imports', 'Takeout');
      expect(repository.create).toHaveBeenCalledWith(authStub.admin.user.id, 'Import', expect.anything(), {
        name: 'Takeout',
        path: '/imports/Takeout',
      });
    });

    it('never lets an API key point the server at a folder, even an administrator’s', async () => {
      const auth = { ...authStub.admin, apiKey: { id: 'key', permissions: [] } } as unknown as AuthDto;
      await expect(sut.create(auth, { name: 'Import', rootId: '0' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(staging.resolveDirectory).not.toHaveBeenCalled();
    });

    it('reports a folder outside the root as a bad request', async () => {
      staging.resolveDirectory.mockRejectedValue(
        new TakeoutStagingError('Choose a folder inside the permitted import location'),
      );
      await expect(
        sut.create(authStub.admin, { name: 'Import', rootId: '0', directory: '../etc' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('addArchive', () => {
    it('answers with the archive already staged when the same file is chosen again', async () => {
      const result = await sut.addArchive(authStub.user1, importId, { name: 'takeout-001.zip', size: 100 });
      expect(result.id).toBe(sources[0].id);
      expect(repository.addSource).not.toHaveBeenCalled();
    });

    it('stages a new archive under a generated name', async () => {
      const result = await sut.addArchive(authStub.user1, importId, { name: 'takeout-002.zip', size: 200 });

      expect(result).toMatchObject({ name: 'takeout-002.zip', size: 200, received: 0 });
      expect(repository.setSourcePath).toHaveBeenCalledWith(
        tx,
        '0195e2a0-0000-7000-8000-0000000000c2',
        '/data/takeout/user/import/0195e2a0-0000-7000-8000-0000000000c2.zip',
      );
    });

    it('refuses an archive the account’s storage quota cannot hold', async () => {
      const auth = {
        ...authStub.user1,
        user: { ...authStub.user1.user, quotaSizeInBytes: 250, quotaUsageInBytes: 100 },
      };
      await expect(sut.addArchive(auth, importId, { name: 'takeout-002.zip', size: 200 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses an archive the staging volume cannot hold', async () => {
      staging.freeBytes.mockResolvedValue(1024);
      await expect(
        sut.addArchive(authStub.user1, importId, { name: 'takeout-002.zip', size: 200 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reopens staging after a scan that was cancelled, and refuses once the scan has finished', async () => {
      row = rowOf('scanning');
      operations = [operationOf('scan', MediaOperationStatus.Cancelled)];
      await sut.addArchive(authStub.user1, importId, { name: 'takeout-002.zip', size: 200 });
      expect(repository.setPhase).toHaveBeenCalledWith(tx, importId, 'sources');

      row = rowOf('review');
      await expect(
        sut.addArchive(authStub.user1, importId, { name: 'takeout-003.zip', size: 200 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('removeArchive', () => {
    it('removes what an earlier scan extracted from the archive along with it', async () => {
      repository.sourceFilePaths.mockResolvedValue(['/data/takeout/user/import/file-1']);

      await sut.removeArchive(authStub.user1, importId, sources[0].id);

      expect(repository.removeSource).toHaveBeenCalledWith(tx, sources[0].id);
      expect(staging.remove).toHaveBeenCalledWith('/data/takeout/user/import/file-1');
      expect(staging.remove).toHaveBeenCalledWith(sources[0].path);
    });
  });

  describe('uploadChunk', () => {
    it('reports an archive that differs from the staged one as a bad request', async () => {
      repository.writeChunk.mockRejectedValue(
        new TakeoutStagingError('This is not the archive that was being uploaded'),
      );
      await expect(
        sut.uploadChunk(authStub.user1, importId, sources[0].id, 0, Buffer.from('x')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('scan', () => {
    it('refuses while an archive is still uploading', async () => {
      sources = [archive({ received: 50 })];
      await expect(sut.scan(authStub.user1, importId)).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.insertOperation).not.toHaveBeenCalled();
    });

    it('queues the scan as a durable, pausable job and moves the import on', async () => {
      await sut.scan(authStub.user1, importId);

      expect(repository.insertOperation).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          ownerId: authStub.user1.user.id,
          kind: MediaOperationKind.TakeoutImport,
          destination: MediaOperationDestination.Local,
          snapshot: { importId, action: 'scan' },
          retryOfId: null,
          maxAttempts: TAKEOUT_MAX_ATTEMPTS,
        }),
      );
      expect(repository.setPhase).toHaveBeenCalledWith(tx, importId, 'scanning');
    });

    it('scans again after a failed scan, as a retry of it', async () => {
      row = rowOf('scanning');
      operations = [operationOf('scan', MediaOperationStatus.Failed)];

      await sut.scan(authStub.user1, importId);

      expect(repository.insertOperation).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ retryOfId: operations[0].id }),
      );
    });

    it('refuses a second scan while one is running', async () => {
      row = rowOf('scanning');
      operations = [operationOf('scan', MediaOperationStatus.Rendering)];
      await expect(sut.scan(authStub.user1, importId)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('startImport', () => {
    beforeEach(() => {
      row = rowOf('review');
      operations = [operationOf('scan', MediaOperationStatus.Completed)];
    });

    it('holds the import while flagged items are unresolved', async () => {
      repository.countReview.mockResolvedValue({ total: 3, locked: 0 });
      await expect(sut.startImport(authStub.user1, importId, { ...TAKEOUT_DEFAULT_OPTIONS })).rejects.toThrow(
        'Resolve the flagged items before importing',
      );
      expect(repository.insertOperation).not.toHaveBeenCalled();
    });

    it('asks a locked session to unlock Locked when only Locked items are flagged', async () => {
      repository.countReview.mockResolvedValue({ total: 2, locked: 2 });
      await expect(sut.startImport(authStub.user1, importId, { ...TAKEOUT_DEFAULT_OPTIONS })).rejects.toThrow(
        'Unlock Locked',
      );
    });

    it('imports disputed items without a sidecar when sidecar review is switched off', async () => {
      repository.countReview.mockResolvedValue({ total: 3, locked: 0 });
      await sut.startImport(authStub.user1, importId, { ...TAKEOUT_DEFAULT_OPTIONS, sidecarReview: false });

      expect(repository.releaseReview).toHaveBeenCalledWith(tx, importId);
      expect(repository.insertOperation).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ snapshot: { importId, action: 'import' } }),
      );
      expect(repository.setPhase).toHaveBeenCalledWith(tx, importId, 'importing');
    });

    it('keeps the owner’s choices on the import, where every run and retry reads them', async () => {
      await sut.startImport(authStub.user1, importId, {
        ...TAKEOUT_DEFAULT_OPTIONS,
        albums: false,
        selectedAlbums: ['Trip'],
      });
      expect(repository.setOptions).toHaveBeenCalledWith(
        tx,
        importId,
        expect.objectContaining({ albums: false, selectedAlbums: ['Trip'] }),
      );
    });

    it('refuses before the scan has finished', async () => {
      row = rowOf('scanning');
      operations = [operationOf('scan', MediaOperationStatus.Rendering)];
      await expect(sut.startImport(authStub.user1, importId, { ...TAKEOUT_DEFAULT_OPTIONS })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('control', () => {
    it('pauses the running job through the durable job itself', async () => {
      row = rowOf('importing');
      operations = [operationOf('import', MediaOperationStatus.Rendering)];

      await sut.control(authStub.user1, importId, { action: 'pause' });

      expect(mediaOperations.pause).toHaveBeenCalledWith(authStub.user1, operations[0].id);
    });

    it('refuses when nothing is running', async () => {
      row = rowOf('review');
      operations = [operationOf('scan', MediaOperationStatus.Completed)];
      await expect(sut.control(authStub.user1, importId, { action: 'cancel' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('items', () => {
    it('leaves Locked items out for a session that has not unlocked Locked, and says how many', async () => {
      repository.counts.mockResolvedValue({ ...emptyCounts, hiddenLocked: 2 });

      const result = await sut.items(authStub.user1, importId, { offset: 0, limit: 50 });

      expect(repository.items).toHaveBeenCalledWith(importId, expect.objectContaining({ includeLocked: false }));
      expect(result.hiddenLocked).toBe(2);
    });

    it('lists Locked items in an unlocked session', async () => {
      await sut.items(authStub.adminWithElevatedPermission, importId, { offset: 0, limit: 50 });
      expect(repository.items).toHaveBeenCalledWith(importId, expect.objectContaining({ includeLocked: true }));
    });

    it('names the library item only when the session may open it', async () => {
      const readable = '6f1c1a0e-4444-4444-8444-444444444444';
      const hidden = '6f1c1a0e-5555-4555-8555-555555555555';
      repository.items.mockResolvedValue({
        items: [
          itemOf({ state: 'imported', assetId: readable }),
          itemOf({ id: 'other', state: 'matched', assetId: hidden }),
        ],
        total: 2,
      });
      access.asset.checkOwnerAccess.mockResolvedValue(new Set([readable]));

      const result = await sut.items(authStub.user1, importId, { offset: 0, limit: 50 });

      expect(result.items.map((item) => item.assetId)).toEqual([readable, null]);
    });
  });

  describe('resolve', () => {
    beforeEach(() => {
      row = rowOf('review');
      operations = [operationOf('scan', MediaOperationStatus.Completed)];
    });

    it('uses the chosen sidecar’s metadata', async () => {
      const item = itemOf();
      repository.lockItem.mockResolvedValue(item);

      await sut.resolve(authStub.user1, importId, itemId, { sidecarId: item.candidates[1].id });

      expect(repository.updateDecision).toHaveBeenCalledWith(tx, itemId, {
        state: 'ready',
        sidecarId: item.candidates[1].id,
        metadata: item.candidates[1].metadata,
      });
    });

    it('imports without a sidecar when asked', async () => {
      repository.lockItem.mockResolvedValue(itemOf());
      await sut.resolve(authStub.user1, importId, itemId, { sidecarId: null });
      expect(repository.updateDecision).toHaveBeenCalledWith(tx, itemId, {
        state: 'ready',
        sidecarId: null,
        metadata: { title: 'IMG_1.jpg' },
      });
    });

    it('refuses a sidecar that is not one of the item’s candidates', async () => {
      repository.lockItem.mockResolvedValue(itemOf());
      await expect(
        sut.resolve(authStub.user1, importId, itemId, { sidecarId: '6f1c1a0e-9999-4999-8999-999999999999' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not reveal a Locked item to a session that has not unlocked Locked', async () => {
      repository.lockItem.mockResolvedValue(itemOf({ locked: true, withheld: true }));
      await expect(sut.resolve(authStub.user1, importId, itemId, { skip: true })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.updateDecision).not.toHaveBeenCalled();
    });

    it('does not reveal an item that matched a photo already Locked in the library', async () => {
      repository.lockItem.mockResolvedValue(itemOf({ withheld: true }));
      await expect(sut.resolve(authStub.user1, importId, itemId, { skip: true })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('never changes an item already in the library', async () => {
      repository.lockItem.mockResolvedValue(itemOf({ state: 'imported' }));
      await expect(sut.resolve(authStub.user1, importId, itemId, { skip: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses while a job is working on the import', async () => {
      row = rowOf('importing');
      operations = [operationOf('import', MediaOperationStatus.Rendering)];
      await expect(sut.resolve(authStub.user1, importId, itemId, { skip: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('remove', () => {
    it('refuses while a job is working on the import', async () => {
      row = rowOf('importing');
      operations = [operationOf('import', MediaOperationStatus.Paused)];
      await expect(sut.remove(authStub.user1, importId)).rejects.toBeInstanceOf(BadRequestException);
      expect(staging.removeImport).not.toHaveBeenCalled();
    });

    it('removes the import and its staged copies, and nothing in the library', async () => {
      row = rowOf('completed');
      operations = [operationOf('import', MediaOperationStatus.Completed)];

      await sut.remove(authStub.user1, importId);

      expect(repository.delete).toHaveBeenCalledWith(tx, importId);
      expect(staging.removeImport).toHaveBeenCalledWith(authStub.user1.user.id, importId);
    });
  });
});
