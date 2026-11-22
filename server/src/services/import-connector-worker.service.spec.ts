import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MediaOperationCreate } from 'src/repositories/media-operation.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { MediaOperationStatus } from 'src/enum.js';
import {
  FAKE_PROVIDER,
  type FakeRemoteFile,
  FakeRemoteSource,
  fakeRemoteSourceProvider,
} from 'src/import-connectors/fake.source.js';
import { type RemoteItem, registerRemoteSource, unregisterRemoteSource } from 'src/import-connectors/remote-source.js';
import { IMPORT_CONNECTION_ACTIVE, type ImportConnection } from 'src/repositories/import-connector.repository.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { TakeoutStagingRepository } from 'src/repositories/takeout-staging.repository.js';
import { TakeoutFile, TakeoutImport, TakeoutItem } from 'src/repositories/takeout.repository.js';
import {
  IMPORT_CONNECTION_DAILY_MS,
  ImportConnectorWorkerService,
} from 'src/services/import-connector-worker.service.js';
import { TakeoutWorkerService } from 'src/services/takeout-worker.service.js';
import { sealImportCredentials } from 'src/utils/import-connector.js';
import { TAKEOUT_DEFAULT_OPTIONS, type TakeoutPhase } from 'src/utils/takeout.js';

/**
 * FL-920 acceptance, with the real connector worker, the real Google Photos import worker and real
 * staging on disk; the two SQL repositories and the library are small in-memory stand-ins. The same
 * flows run against PostgreSQL in `test/medium/specs/services/import-connector.service.spec.ts`.
 */

const ownerId = '0195e2a0-0000-7000-8000-00000000000a';
const connectionId = '0195e2a0-0000-7000-8000-0000000000c0';
const SECRET = 'hunter2-app-password';

const bytes = (text: string) => Buffer.from(text).toString('base64');
const sha256 = (data: string) => createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');

type Seen = RemoteItem & { id: string; importId: string | null; fileId: string | null; error: string | null };
type StoredItem = {
  id: string;
  importId: string;
  state: TakeoutItem['state'];
  metadata: TakeoutItem['metadata'];
  albums: string[];
  assetId: string | null;
  resultKind: TakeoutItem['resultKind'];
  createPath: string | null;
  error: string | null;
};
type LibraryAsset = {
  id: string;
  checksum: string;
  originalPath: string;
  filename: string;
  description: string | null;
  isFavorite: boolean;
};

describe(ImportConnectorWorkerService.name, () => {
  let directory: string;
  let source: FakeRemoteSource;
  let connection: ImportConnection;
  let sut: ImportConnectorWorkerService;
  let takeoutWorker: TakeoutWorkerService;
  let logger: Record<string, ReturnType<typeof vi.fn>>;
  let operations: Record<string, ReturnType<typeof vi.fn>>;
  let albums: Record<string, ReturnType<typeof vi.fn>>;
  let assetMedia: Record<string, ReturnType<typeof vi.fn>>;

  // The in-memory database.
  let runs: Map<string, TakeoutImport>;
  let files: Map<string, TakeoutFile>;
  let items: Map<string, StoredItem>;
  let seen: Seen[];
  let queued: Array<MediaOperationCreate & { id: string }>;
  let library: LibraryAsset[];
  let albumOf: Map<string, string>;
  let albumAssets: Map<string, Set<string>>;
  let albumNames: Map<string, string>;

  const remote = (overrides: Partial<FakeRemoteFile> & { path: string }): FakeRemoteFile => ({
    data: bytes(`bytes of ${overrides.path}`),
    ...overrides,
  });

  const asOperation = (operation: MediaOperationCreate & { id: string }, result: unknown = null) =>
    ({
      ...operation,
      status: MediaOperationStatus.Preparing,
      result,
      processedUnits: '0',
    }) as unknown as MediaOperation;
  /** Run the job most recently queued, as the worker would after claiming it. */
  const runQueued = (result: unknown = null) => takeoutWorker.run(asOperation(queued.at(-1)!, result), 'claim');
  const startScan = async () => {
    const outcome = await connectors.startScan(connectionId, { ...TAKEOUT_DEFAULT_OPTIONS }, (current, importId) => ({
      ownerId: current.ownerId,
      label: current.displayName,
      snapshot: { importId, action: 'scan' },
    }));
    return (outcome as { importId: string }).importId;
  };
  const startImport = (importId: string) => {
    runs.get(importId)!.phase = 'importing';
    queued.push({ id: randomUUID(), ownerId, snapshot: { importId, action: 'import' } } as never);
  };

  const connectors = {
    getById: vi.fn(() => Promise.resolve(connection)),
    setStatus: vi.fn((_id: string, status: string) => {
      connection.status = status;
      return Promise.resolve();
    }),
    setCursor: vi.fn((_id: string, cursor: ImportConnection['cursor']) => {
      connection.cursor = cursor;
      return Promise.resolve();
    }),
    dueForDailyCheck: vi.fn((before: Date) =>
      Promise.resolve(
        connection.dailyCheck &&
          connection.status === IMPORT_CONNECTION_ACTIVE &&
          (!connection.lastScanAt || connection.lastScanAt <= before)
          ? [connectionId]
          : [],
      ),
    ),
    startScan: vi.fn(
      (
        _id: string,
        options: Record<string, unknown>,
        operation: (current: ImportConnection, importId: string) => Partial<MediaOperationCreate>,
        _dueBefore?: Date,
      ) => {
        const importId = randomUUID();
        runs.set(importId, {
          id: importId,
          ownerId,
          name: connection.displayName,
          phase: 'scanning',
          options,
          runOperationId: null,
          connectionId,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        queued.push({ id: randomUUID(), ...operation(connection, importId) } as never);
        connection.lastScanAt = new Date(clock);
        return Promise.resolve({ importId });
      },
    ),
    deleteEmptyRun: vi.fn((importId: string) => {
      runs.delete(importId);
      return Promise.resolve();
    }),
    // The same rule as the SQL upsert: new, changed, or orphaned.
    offer: vi.fn((_connection: string, importId: string, item: RemoteItem) => {
      const known = seen.find((row) => row.remoteId === item.remoteId);
      if (!known) {
        seen.push({ ...item, id: randomUUID(), importId, fileId: null, error: null });
        return Promise.resolve(true);
      }
      const changed =
        known.size !== item.size ||
        known.modifiedAt.getTime() !== item.modifiedAt.getTime() ||
        known.contentHash !== item.contentHash ||
        (known.importId === null && known.fileId === null);
      if (changed) {
        Object.assign(known, item, { importId, fileId: null, error: null });
      }
      return Promise.resolve(changed);
    }),
    pendingItems: vi.fn((importId: string, limit: number) =>
      Promise.resolve(
        seen
          .filter((row) => row.importId === importId && !row.fileId && !row.error)
          .slice(0, limit)
          .map((row) => ({ ...row, state: 'ready', assetId: null })),
      ),
    ),
    pendingCount: vi.fn((importId: string) =>
      Promise.resolve(seen.filter((row) => row.importId === importId && !row.fileId && !row.error).length),
    ),
    itemStaged: vi.fn((id: string, fileId: string) => {
      Object.assign(
        seen.find((row) => row.id === id)!,
        { fileId, error: null },
      );
      return Promise.resolve();
    }),
    itemFailed: vi.fn((id: string, error: string) => {
      seen.find((row) => row.id === id)!.error = error;
      return Promise.resolve();
    }),
    retryFailed: vi.fn((importId: string) => {
      const failed = seen.filter((row) => row.importId === importId && !row.fileId && row.error);
      for (const row of failed) {
        row.error = null;
      }
      return Promise.resolve(failed.length);
    }),
  };

  const pendingOf = (importId: string) =>
    items
      .values()
      .filter((item) => item.importId === importId && ['ready', 'importing'].includes(item.state))
      .toArray();
  const takeout = {
    getById: vi.fn((id: string) => Promise.resolve(runs.get(id))),
    claimRun: vi.fn().mockResolvedValue(true),
    advancePhase: vi.fn((id: string, from: TakeoutPhase, to: TakeoutPhase) => {
      const run = runs.get(id);
      if (run?.phase !== from) {
        return Promise.resolve(false);
      }
      run.phase = to;
      return Promise.resolve(true);
    }),
    sources: vi.fn((importId: string) =>
      Promise.resolve([{ id: `source-${importId}`, importId, name: connection.displayName, rejected: 0 }]),
    ),
    markSourceScanned: vi.fn(),
    hasFile: vi.fn((id: string) => Promise.resolve(files.has(id))),
    recordFile: vi.fn((file: TakeoutFile) => {
      files.set(file.id, file);
      return Promise.resolve();
    }),
    recordItem: vi.fn((item: Pick<StoredItem, 'id' | 'importId' | 'state' | 'metadata' | 'albums'>) => {
      items.set(item.id, { ...item, assetId: null, resultKind: null, createPath: null, error: null });
      return Promise.resolve();
    }),
    pendingPhotos: vi.fn((importId: string) => Promise.resolve({ total: pendingOf(importId).length, alreadyIn: [] })),
    pendingItems: vi.fn((importId: string, limit: number) =>
      Promise.resolve(
        pendingOf(importId)
          .slice(0, limit)
          .map((item) => {
            const file = files.get(item.id)!;
            return {
              ...file,
              ...item,
              sidecarId: null,
              candidates: [],
              warnings: [],
              locked: false,
              withheld: false,
              sourceName: connection.displayName,
            } as unknown as TakeoutItem;
          }),
      ),
    ),
    approvedPairs: vi.fn().mockResolvedValue([]),
    itemCreating: vi.fn((id: string, createPath: string) => {
      Object.assign(items.get(id)!, { state: 'importing', createPath });
      return Promise.resolve();
    }),
    itemAsset: vi.fn((id: string, assetId: string, resultKind: TakeoutItem['resultKind']) => {
      Object.assign(items.get(id)!, { state: 'importing', assetId, resultKind });
      return Promise.resolve();
    }),
    itemDone: vi.fn((id: string, state: TakeoutItem['state'], error: string | null = null) => {
      Object.assign(items.get(id)!, { state, error });
      return Promise.resolve();
    }),
    retryFailed: vi.fn().mockResolvedValue(0),
    retryFailedPairs: vi.fn().mockResolvedValue(0),
    isOriginalPath: vi.fn().mockResolvedValue(false),
    getAssetState: vi.fn((assetId: string) => {
      const asset = library.find((candidate) => candidate.id === assetId)!;
      return Promise.resolve({
        id: asset.id,
        ownerId,
        deletedAt: null,
        description: asset.description,
        latitude: null,
        longitude: null,
        isFavorite: asset.isFavorite,
        visibility: 'timeline',
        livePhotoVideoId: null,
        originalPath: asset.originalPath,
        locked: false,
      });
    }),
    getAlbumFor: vi.fn((_owner: string, folder: string) => Promise.resolve(albumOf.get(folder))),
    isFolderAlbumRemoved: vi.fn().mockResolvedValue(false),
    setAlbumFor: vi.fn((_owner: string, folder: string, albumId: string) => {
      albumOf.set(folder, albumId);
      return Promise.resolve(albumId);
    }),
    withImport: vi.fn(
      (_owner: string, id: string, fn: (tx: unknown, row: TakeoutImport) => Promise<unknown>, _connector: boolean) =>
        fn({}, runs.get(id)!),
    ),
    setPhase: vi.fn((_tx: unknown, id: string, phase: TakeoutPhase) => {
      runs.get(id)!.phase = phase;
      return Promise.resolve();
    }),
    insertOperation: vi.fn((_tx: unknown, operation: MediaOperationCreate) => {
      queued.push({ id: randomUUID(), ...operation });
      return Promise.resolve(operation);
    }),
  };

  let clock: number;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'frameleaf-import-connector-'));
    StorageCore.setMediaLocation(directory);
    clock = Date.parse('2027-02-01T08:00:00.000Z');
    runs = new Map();
    files = new Map();
    items = new Map();
    seen = [];
    queued = [];
    library = [];
    albumOf = new Map();
    albumAssets = new Map();
    albumNames = new Map();
    vi.clearAllMocks();

    source = new FakeRemoteSource([]);
    registerRemoteSource({ ...fakeRemoteSourceProvider, open: () => source });

    const crypto = { serverKeyedHash: vi.fn().mockResolvedValue('keyed-hash') };
    const config = { getEnv: () => ({ frameleafCloud: { identityDir: directory }, storage: { importRoots: [] } }) };
    connection = {
      id: connectionId,
      ownerId,
      provider: FAKE_PROVIDER,
      displayName: 'My Nextcloud',
      sealedCredentials: await sealImportCredentials({ crypto, config } as never, connectionId, { password: SECRET }),
      roots: [],
      dailyCheck: true,
      cursor: null,
      lastScanAt: null,
      status: IMPORT_CONNECTION_ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const staging = new TakeoutStagingRepository();
    vi.spyOn(staging, 'freeBytes').mockResolvedValue(10 * 1024 ** 4);
    sut = new ImportConnectorWorkerService(
      logger as never,
      connectors as never,
      takeout as never,
      staging,
      crypto as never,
      config as never,
    );

    const working = { status: MediaOperationStatus.Rendering, cancelRequestedAt: null, pauseRequestedAt: null };
    operations = {
      reportProgress: vi.fn().mockResolvedValue(true),
      setBulkResult: vi.fn().mockResolvedValue(working),
      heartbeat: vi.fn().mockResolvedValue(true),
      beginValidation: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('failed'),
      requeue: vi.fn().mockResolvedValue(true),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      settlePause: vi.fn().mockResolvedValue(true),
    };
    assetMedia = {
      bulkUploadCheck: vi.fn((_auth: unknown, dto: { assets: Array<{ id: string; checksum: string }> }) =>
        Promise.resolve({
          results: dto.assets.map(({ id, checksum }) => ({
            id,
            assetId: library.find((asset) => asset.checksum === checksum)?.id,
          })),
        }),
      ),
      needsOriginal: vi.fn().mockResolvedValue(false),
      uploadAsset: vi.fn(
        (
          _auth: unknown,
          dto: { filename: string; isFavorite?: boolean },
          file: { checksum: Buffer; originalPath: string },
        ) => {
          const asset = {
            id: randomUUID(),
            checksum: file.checksum.toString('hex'),
            originalPath: file.originalPath,
            filename: dto.filename,
            description: null,
            isFavorite: dto.isFavorite === true,
          };
          library.push(asset);
          return Promise.resolve({ id: asset.id, status: AssetMediaStatus.CREATED });
        },
      ),
    };
    const assets = {
      lock: vi.fn(),
      fillMissingMetadata: vi.fn().mockResolvedValue(true),
      update: vi.fn((_auth: unknown, id: string, update: { description?: string; isFavorite?: boolean }) => {
        const asset = library.find((candidate) => candidate.id === id)!;
        asset.description = update.description ?? asset.description;
        asset.isFavorite = update.isFavorite ?? asset.isFavorite;
        return Promise.resolve();
      }),
    };
    albums = {
      create: vi.fn((_auth: unknown, dto: { albumName: string }) => {
        const id = randomUUID();
        albumNames.set(id, dto.albumName);
        albumAssets.set(id, new Set());
        return Promise.resolve({ id });
      }),
      addAssets: vi.fn((_auth: unknown, albumId: string, dto: { ids: string[] }) => {
        for (const id of dto.ids) {
          albumAssets.get(albumId)!.add(id);
        }
        return Promise.resolve(dto.ids.map((id) => ({ id, success: true })));
      }),
      delete: vi.fn(),
    };
    const users = {
      get: vi.fn().mockResolvedValue({
        id: ownerId,
        isAdmin: false,
        name: 'Owner',
        email: 'owner@example.com',
        quotaUsageInBytes: 0,
        quotaSizeInBytes: null,
        uploadsPaused: false,
      }),
    };
    takeoutWorker = new TakeoutWorkerService(
      logger as never,
      operations as never,
      takeout as never,
      staging,
      users as never,
      assetMedia as never,
      assets as never,
      albums as never,
      { relinkOne: vi.fn() } as never,
      config as never,
      sut,
    );
  });

  afterEach(async () => {
    unregisterRemoteSource(FAKE_PROVIDER);
    await rm(directory, { recursive: true, force: true });
  });

  const albumNamed = (name: string) => {
    const id = [...albumNames].find(([, albumName]) => albumName === name)?.[0];
    return id ? [...albumAssets.get(id)!] : undefined;
  };
  const stateOf = (remotePath: string) => {
    const row = seen.find((candidate) => candidate.path === remotePath);
    return row?.fileId ? items.get(row.fileId)?.state : row?.error ? 'failed' : row ? 'ready' : undefined;
  };

  it('imports a fake source: albums created, captions become descriptions, favourites kept, duplicates skipped', async () => {
    const duplicate = remote({ path: 'Camera/already-here.jpg' });
    library.push({
      id: randomUUID(),
      checksum: sha256(duplicate.data),
      originalPath: '/library/already-here.jpg',
      filename: 'already-here.jpg',
      description: null,
      isFavorite: false,
    });
    source.files = [
      remote({ path: 'Trips/Italy/rome.jpg', caption: 'Rome at dusk', favourite: true }),
      remote({ path: 'Trips/Italy/pisa.jpg' }),
      remote({ path: 'Camera/clip.mp4', albumHint: null }),
      duplicate,
      remote({ path: 'Trips/notes.txt' }),
      remote({ path: '../outside.jpg' }),
    ];

    const importId = await startScan();
    await runQueued();

    // Scan: the run waits in review with the four photos and videos; nothing has been downloaded.
    expect(runs.get(importId)!.phase).toBe('review');
    expect(seen.map((row) => row.path).toSorted()).toEqual([
      'Camera/already-here.jpg',
      'Camera/clip.mp4',
      'Trips/Italy/pisa.jpg',
      'Trips/Italy/rome.jpg',
    ]);
    expect(takeout.markSourceScanned).toHaveBeenCalledWith(`source-${importId}`, 2);
    expect(source.opened).toEqual([]);
    expect(connection.cursor).toEqual({ scans: 1 });

    startImport(importId);
    await runQueued();

    expect(runs.get(importId)!.phase).toBe('completed');
    expect(operations.fail).not.toHaveBeenCalled();
    // Duplicates skipped: the photo already in the library is matched, never uploaded again.
    expect(assetMedia.uploadAsset).toHaveBeenCalledTimes(3);
    expect(library).toHaveLength(4);
    expect(stateOf('Camera/already-here.jpg')).toBe('matched');
    expect(stateOf('Trips/Italy/rome.jpg')).toBe('imported');
    // Captions to descriptions, favourites kept.
    const rome = library.find((asset) => asset.filename === 'rome.jpg')!;
    expect(rome).toMatchObject({ description: 'Rome at dusk', isFavorite: true });
    expect(library.find((asset) => asset.filename === 'pisa.jpg')).toMatchObject({
      description: null,
      isFavorite: false,
    });
    // The digests are the library's own, of the bytes that arrived.
    expect(rome.checksum).toBe(sha256(source.files[0].data));
    // Albums from the hints: the folder's last segment names the album; no hint, no album.
    expect(albumNamed('Italy')).toHaveLength(2);
    expect(albumNamed('Camera')).toEqual([library[0].id]);
    expect(albumNames.size).toBe(2);
    // Activity names the connection, not Google Photos.
    expect(assetMedia.uploadAsset.mock.calls[0][5]).toEqual({ origin: 'import', label: 'My Nextcloud' });
    // Staging is emptied as each file goes into the library.
    expect(await readdir(path.join(directory, 'takeout', ownerId, importId))).toEqual([]);
  });

  it('daily check imports only new items, and a file removed at the source changes nothing here', async () => {
    source.files = [remote({ path: 'Trips/a.jpg' }), remote({ path: 'Trips/b.jpg' })];
    const first = await startScan();
    await runQueued();
    startImport(first);
    await runQueued();
    expect(library).toHaveLength(2);
    const before = structuredClone({ library, albums: [...albumAssets].map(([id, set]) => [id, [...set]]) });
    source.opened.length = 0;

    // Not due yet: the last scan started less than a day ago.
    clock += IMPORT_CONNECTION_DAILY_MS - 60_000;
    expect(await sut.dailyCheck(new Date(clock))).toBe(0);

    // A day later a.jpg is gone from the source and c.jpg is new.
    source.files = [remote({ path: 'Trips/b.jpg' }), remote({ path: 'Trips/c.jpg' })];
    clock += 120_000;
    expect(await sut.dailyCheck(new Date(clock))).toBe(1);
    expect(queued.at(-1)!.snapshot).toMatchObject({ action: 'scan', auto: true });
    await runQueued();
    // The daily scan goes straight on to its import, with no review.
    expect(queued.at(-1)!.snapshot).toMatchObject({ action: 'import', auto: true });
    await runQueued();

    // Only the new file was downloaded and imported.
    expect(source.opened.map(({ remoteId }) => remoteId)).toEqual(['Trips/c.jpg']);
    expect(library.map((asset) => asset.filename).toSorted()).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    // The photo that came from a.jpg, its album membership and the record of the file are untouched.
    expect(library.slice(0, 2)).toEqual(before.library);
    expect(albumNamed('Trips')).toEqual(expect.arrayContaining(before.albums[0][1] as string[]));
    expect(seen.find((row) => row.path === 'Trips/a.jpg')).toMatchObject({ error: null });
    expect(stateOf('Trips/a.jpg')).toBe('imported');
    expect(albums.delete).not.toHaveBeenCalled();
  });

  it('drops a daily run that found nothing new, without queueing an import', async () => {
    source.files = [remote({ path: 'Trips/a.jpg' })];
    const first = await startScan();
    await runQueued();
    startImport(first);
    await runQueued();
    const jobs = queued.length;

    clock += IMPORT_CONNECTION_DAILY_MS + 1;
    expect(await sut.dailyCheck(new Date(clock))).toBe(1);
    await runQueued();

    expect(queued).toHaveLength(jobs + 1);
    expect(runs.size).toBe(1);
    expect(library).toHaveLength(1);
  });

  it('offers a file again when it changed at the source, and keeps the photo it was before', async () => {
    source.files = [remote({ path: 'Trips/a.jpg' })];
    const first = await startScan();
    await runQueued();
    startImport(first);
    await runQueued();

    source.files = [
      remote({ path: 'Trips/a.jpg', data: bytes('edited at the source'), modifiedAt: '2025-05-05T00:00:00Z' }),
    ];
    const second = await startScan();
    await runQueued();
    startImport(second);
    await runQueued();

    expect(library).toHaveLength(2);
    expect(library[1].checksum).toBe(sha256(bytes('edited at the source')));
  });

  it('resumes an interrupted download by range instead of fetching the file again', async () => {
    const data = Buffer.alloc(300_000, 7).toString('base64');
    source.files = [remote({ path: 'Trips/big.jpg', data })];
    const importId = await startScan();
    await runQueued();
    source.failAfterBytes = 100_000;
    startImport(importId);
    await runQueued();

    // The download stopped part-way: the file is reported, and the run takes its one automatic retry.
    expect(connectors.itemFailed).toHaveBeenCalledWith(expect.any(String), 'The connection dropped');
    expect(operations.requeue).toHaveBeenCalled();
    expect(library).toHaveLength(0);

    await runQueued({ itemRetryUsed: true });

    expect(source.opened).toEqual([
      { remoteId: 'Trips/big.jpg', start: 0 },
      { remoteId: 'Trips/big.jpg', start: 100_000 },
    ]);
    expect(library).toHaveLength(1);
    expect(library[0].checksum).toBe(sha256(data));
    expect(runs.get(importId)!.phase).toBe('completed');
  });

  it('reports a file that is gone by download time and imports the rest', async () => {
    source.files = [remote({ path: 'Trips/a.jpg' }), remote({ path: 'Trips/b.jpg' })];
    const importId = await startScan();
    await runQueued();
    source.files = [remote({ path: 'Trips/b.jpg' })];
    startImport(importId);
    await runQueued({ itemRetryUsed: true });

    expect(stateOf('Trips/a.jpg')).toBe('failed');
    expect(stateOf('Trips/b.jpg')).toBe('imported');
    expect(runs.get(importId)!.phase).toBe('completed');
  });

  it('marks the connection for a new sign-in when the source refuses it, without a retry or a daily check', async () => {
    registerRemoteSource({ ...fakeRemoteSourceProvider, open: () => new FakeRemoteSource([], 'expired') });
    await startScan();
    await runQueued();

    expect(connection.status).toBe('sign_in_required');
    expect(operations.fail).toHaveBeenCalledWith(
      expect.any(String),
      'claim',
      expect.objectContaining({ errorCode: 'import_connection_sign_in_required' }),
      { retry: false },
    );
    clock += 2 * IMPORT_CONNECTION_DAILY_MS;
    expect(await sut.dailyCheck(new Date(clock))).toBe(0);
  });

  it('never writes the credentials, sealed or opened, to a log', async () => {
    source.files = [remote({ path: 'Trips/a.jpg' })];
    const importId = await startScan();
    await runQueued();
    startImport(importId);
    await runQueued();

    const logged = JSON.stringify(Object.values(logger).flatMap((fn) => fn.mock.calls));
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(connection.sealedCredentials.toString('base64'));
    expect(connection.sealedCredentials.toString('latin1')).not.toContain(SECRET);
  });

  it('fails the job in general terms when the source breaks in a way it did not describe', async () => {
    source.scan = () => {
      throw new Error(`GET https://user:${SECRET}@example.com failed`);
    };
    await startScan();
    await runQueued();

    expect(operations.fail).toHaveBeenCalledWith(expect.any(String), 'claim', {
      error: 'The source could not be read',
      errorCode: 'import_connection_source_failed',
    });
    expect(JSON.stringify(Object.values(logger).flatMap((fn) => fn.mock.calls))).not.toContain(SECRET);
  });
});
