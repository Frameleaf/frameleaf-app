import { NoResultError } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, JobName, MediaOperationStatus } from 'src/enum.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { BuddyBackupRestoreService, retargetBuddyOwnerPath } from 'src/services/buddy-backup-restore.service.js';
import { CloudBackupRestorer } from 'src/services/cloud-backup-restore.js';
import { checkOwnerRestoreItems, ownerRestoreHash } from 'src/utils/cloud-backup-owner-restore.js';

vi.mock('src/services/base.service.js', () => ({ BaseService: class {} }));

it.each([
  ['keep', 'current edit', true],
  ['replace', 'backed up edit', true],
  ['replace', 'changed edit', false],
] as const)('uses inspection for %s/%s and never overwrites retained history', async (mode, currentEdit, completes) => {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-restore-history-'));
  const assetId = randomUUID();
  const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
  const files = [
    ['original', 'original bytes'],
    ['full-size', 'backed up edit'],
  ].map(([role, bytes]) => ({
    role,
    path: join(directory, role),
    size: Buffer.byteLength(bytes),
    sha256: hash(bytes),
  }));
  const manifest = {
    library: { assets: { [assetId]: { owner: 'owner', files } }, profiles: {}, albums: {}, people: {} },
    assetFiles: { [assetId]: [{ path: files[1].path, type: AssetFileType.FullSize, isEdited: true }] },
  };
  const operation: any = {
    id: randomUUID(),
    ownerId: 'owner',
    claimToken: 'token',
    result: {},
    snapshot: {
      request: { scope: 'asset', assetIds: [assetId], mode },
      admin: true,
      owner: { current: { [assetId]: { originalPath: files[0].path, isExternal: false } } },
      manifestHash: hash(JSON.stringify(manifest)),
    },
  };
  const query: any = {
    select: () => query,
    where: () => query,
    executeTakeFirst: () => Promise.resolve({ path: files[1].path }),
  };
  const complete = vi.fn().mockResolvedValue(true);
  const fail = vi.fn();
  const guard = vi.fn(async (_operation, _token, _job, _manifest, _snapshot, _file, action, inspect) => {
    if (!inspect) throw new Error('Owner restore destination unavailable');
    return await action();
  });
  const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
    repository: { root: () => directory, db: { selectFrom: () => query } },
    crypto: { hashFile: async (path: string) => Buffer.from(hash(await readFile(path)), 'hex') },
    storage: {
      mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
      rename,
      unlink,
      checkFileExists: async (path: string) => !!(await lstat(path).catch(() => null)),
    },
    logger: { warn: vi.fn(), error: vi.fn() },
    binding: async () => {},
    guarded: guard,
    index: {
      getOwnerRestoreAuth: () => Promise.resolve({ auth: { user: { isAdmin: true } } }),
      getOwnerRestoreIdentities: () =>
        Promise.resolve({ [assetId]: { originalPath: files[0].path, isExternal: false } }),
    },
    operations: {
      acknowledgeCancel: () => Promise.resolve(false),
      settlePause: () => Promise.resolve(false),
      getOfKind: () => Promise.resolve(operation),
      reportProgress: () => Promise.resolve(true),
      setBulkResult: () => Promise.resolve({ cancelRequestedAt: null, pauseRequestedAt: null }),
      beginValidation: () => Promise.resolve(true),
      complete,
      fail,
    },
    open: () =>
      Promise.resolve({
        manifest,
        reader: {
          download: async (_manifest: unknown, sha256: string, path: string) => {
            const bytes = sha256 === files[0].sha256 ? 'original bytes' : 'backed up edit';
            await writeFile(path, bytes);
            return { sha256, size: Buffer.byteLength(bytes) };
          },
        },
      }),
  });
  const restore = CloudBackupRestorer.prototype.restore;
  // Isolate the actual Buddy file publisher from the separately tested database metadata finalizer.
  const restorer = vi.spyOn(CloudBackupRestorer.prototype, 'restore').mockImplementation(function (
    this: CloudBackupRestorer,
    options,
  ) {
    return restore.call(this, { ...options, library: (result) => Promise.resolve(result) });
  });
  const media = vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(directory);
  try {
    await writeFile(files[0].path, 'original bytes');
    await writeFile(files[1].path, currentEdit);
    await service.run(operation, 'token');
    expect(complete).toHaveBeenCalledTimes(completes ? 1 : 0);
    expect(fail).toHaveBeenCalledTimes(completes ? 0 : 1);
    expect(await readFile(files[1].path, 'utf8')).toBe(currentEdit);
    expect(guard.mock.calls.some((call) => !call[7])).toBe(!completes);
  } finally {
    restorer.mockRestore();
    media.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ['keep', 'source edit', true],
  ['replace', 'original bytes', true],
  ['replace', 'source edit', false],
] as const)('never writes into a read-only library folder (%s, source holds %s)', async (mode, current, completes) => {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-restore-read-only-'));
  const source = join(directory, 'import');
  mkdirSync(source);
  const assetId = randomUUID();
  const libraryId = randomUUID();
  const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
  const original = join(source, 'photo.jpg');
  const manifest = {
    library: {
      assets: {
        [assetId]: {
          owner: 'owner',
          files: [{ role: 'original', path: original, size: 14, sha256: hash('original bytes') }],
        },
      },
      profiles: {},
      albums: {},
      people: {},
    },
    assetLinks: { [assetId]: { isExternal: true, libraryId } },
  };
  const operation: any = {
    id: randomUUID(),
    ownerId: 'owner',
    claimToken: 'token',
    result: {},
    snapshot: {
      request: { scope: 'asset', assetIds: [assetId], mode },
      admin: true,
      owner: { current: { [assetId]: { originalPath: original, isExternal: true } } },
      manifestHash: hash(JSON.stringify(manifest)),
    },
  };
  const query: any = {
    select: () => query,
    where: () => query,
    execute: () => Promise.resolve([{ id: libraryId, importPaths: [source] }]),
  };
  const complete = vi.fn().mockResolvedValue(true);
  const fail = vi.fn();
  const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
    repository: { root: () => join(directory, 'buddy'), db: { selectFrom: () => query } },
    crypto: { hashFile: async (path: string) => Buffer.from(hash(await readFile(path)), 'hex') },
    storage: {
      mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
      rename,
      unlink,
      checkFileExists: async (path: string) => !!(await lstat(path).catch(() => null)),
    },
    logger: { warn: vi.fn(), error: vi.fn() },
    binding: async () => {},
    guarded: (...args: any[]) => args[6](),
    index: {
      getOwnerRestoreAuth: () => Promise.resolve({ auth: { user: { isAdmin: true } } }),
      getOwnerRestoreIdentities: () => Promise.resolve({ [assetId]: { originalPath: original, isExternal: true } }),
    },
    operations: {
      acknowledgeCancel: () => Promise.resolve(false),
      settlePause: () => Promise.resolve(false),
      getOfKind: () => Promise.resolve(operation),
      reportProgress: () => Promise.resolve(true),
      setBulkResult: () => Promise.resolve({ cancelRequestedAt: null, pauseRequestedAt: null }),
      beginValidation: () => Promise.resolve(true),
      complete,
      fail,
    },
    open: () =>
      Promise.resolve({
        manifest,
        reader: {
          download: async (_manifest: unknown, _sha256: string, path: string) => {
            await writeFile(path, 'original bytes');
            return { sha256: hash('original bytes'), size: 14 };
          },
        },
      }),
  });
  const restore = CloudBackupRestorer.prototype.restore;
  const restorer = vi.spyOn(CloudBackupRestorer.prototype, 'restore').mockImplementation(function (
    this: CloudBackupRestorer,
    options,
  ) {
    return restore.call(this, { ...options, library: (result) => Promise.resolve(result) });
  });
  const media = vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(join(directory, 'media'));
  try {
    await writeFile(original, current);
    // A read-only mount: any staged copy or rename beside the original fails.
    await chmod(source, 0o555);
    await service.run(operation, 'token');
    expect(complete).toHaveBeenCalledTimes(completes ? 1 : 0);
    expect(fail).toHaveBeenCalledTimes(completes ? 0 : 1);
    expect(await readFile(original, 'utf8')).toBe(current);
    expect(await readdir(source)).toEqual(['photo.jpg']);
  } finally {
    restorer.mockRestore();
    media.mockRestore();
    await chmod(source, 0o755);
    await rm(directory, { recursive: true, force: true });
  }
});

it('replays deferred metadata jobs after a crash before or after restore completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-restore-jobs-'));
  const operationId = randomUUID();
  const assetId = randomUUID();
  const operation = { status: MediaOperationStatus.Rendering, claimToken: 'active' as string | null };
  const queued = [{ name: JobName.AssetExtractMetadata, data: { id: assetId } }];
  const queueAll = vi.fn().mockResolvedValue(undefined);
  const restart = () =>
    Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      repository: { root: () => directory },
      operations: { getOfKind: () => Promise.resolve(operation) },
      jobs: { queueAll },
    });
  try {
    await restart().saveRestoreJobs(operationId, assetId, queued);
    // A committed metadata outcome may produce no new jobs on replay; retain the original intent.
    await restart().saveRestoreJobs(operationId, assetId, []);
    await restart().saveRestoreJobs(operationId, assetId, queued);
    await restart().drainRestoreJobs();
    expect(queueAll).not.toHaveBeenCalled();
    operation.status = MediaOperationStatus.Completed;
    operation.claimToken = null;
    queueAll.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(restart().drainRestoreJobs()).rejects.toThrow('queue unavailable');
    await restart().drainRestoreJobs();
    expect(queueAll.mock.calls).toEqual([[queued], [queued]]);
    await restart().drainRestoreJobs();
    expect(queueAll).toHaveBeenCalledTimes(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('revalidates every completed target, including preserved files, before a restore can finish', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-restore-checkpoint-'));
  const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
  const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
    repository: { root: () => directory },
    crypto: { hashFile: async (path: string) => Buffer.from(hash(await readFile(path)), 'hex') },
  });
  const files = ['original', 'sidecar', 'preview'].map((role, index) => ({
    fileKey: `asset:${index}`,
    assetId: 'asset',
    role,
    target: join(directory, role),
    inPlace: true,
    sha256: hash('backup'),
    size: 6,
  }));
  try {
    for (const file of files) {
      await writeFile(file.target, file.role === 'original' ? 'current' : 'backup');
      await service.recordFile('operation', file, file.role === 'original');
    }
    expect((await service.verifyFiles('operation', files)).size).toBe(3);
    await writeFile(files[2].target, 'broken');
    await expect(service.verifyFiles('operation', files)).rejects.toThrow('changed');
    await expect(service.recordFile('operation', files[2], true)).rejects.toThrow('checkpoint changed');
    await rm(files[1].target);
    await expect(service.verifyFiles('operation', files.slice(0, 2))).rejects.toThrow('changed');
    expect(await readFile(files[0].target, 'utf8')).toBe('current');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('authorizes a hidden Live Photo component only through its selected, still-authorized owner still', async () => {
  const auth: any = { user: { id: 'owner' }, session: { hasElevatedPermission: true } };
  const asset = (visibility: string) => ({
    owner: 'owner',
    type: 'IMAGE',
    originalFileName: 'item.jpg',
    fileCreatedAt: '2026-01-01',
    fileModifiedAt: '2026-01-01',
    localDateTime: '2026-01-01',
    files: [{ role: 'original', path: '/data/original', sha256: 'a'.repeat(64), size: 10 }],
    details: { visibility, albums: [], faces: [] },
  });
  const manifest: any = {
    version: 2,
    assets: { still: asset('timeline'), motion: asset('hidden') },
    albums: {},
    people: {},
  };
  const buddy: any = { library: manifest, assetLinks: { still: { livePhotoVideoId: 'motion' } } };
  const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
    visible: () => Promise.resolve(['still']),
  });
  expect(await service.selection(auth, { scope: 'asset', assetIds: ['still'] }, buddy, false)).toEqual([
    'still',
    'motion',
  ]);
  await expect(service.selection(auth, { scope: 'asset', assetIds: ['motion'] }, buddy, false)).rejects.toThrow(
    'unavailable',
  );
  const identities = Object.fromEntries(
    ['still', 'motion'].map((id) => [
      id,
      {
        ownerId: 'owner',
        originalPath: '/data/original',
        checksum: 'current',
        checksumAlgorithm: 'sha1',
        isExternal: false,
      },
    ]),
  );
  const states = new Map(['still', 'motion'].map((id) => [id, { ownerId: 'owner', allowed: true, status: 'active' }]));
  const index: any = {
    getOwnerHistoryState: () => Promise.resolve(states),
    getAssetDetails: () => Promise.resolve(new Map()),
    getOwnerRestoreIdentities: () => Promise.resolve(identities),
  };
  const snapshot: any = {
    assetIds: ['still', 'motion'],
    owner: {
      ownerId: 'owner',
      current: identities,
      assetHashes: Object.fromEntries(
        Object.entries(manifest.assets).map(([id, item]) => [id, ownerRestoreHash(item as never, manifest)]),
      ),
    },
  };
  await expect(checkOwnerRestoreItems(auth, manifest, snapshot, true, index, ['motion'], true)).rejects.toThrow(
    'unavailable',
  );
  await checkOwnerRestoreItems(auth, manifest, snapshot, true, index, ['motion'], true, 'still');
  states.get('still')!.allowed = false;
  await expect(
    checkOwnerRestoreItems(auth, manifest, snapshot, true, index, ['motion'], true, 'still'),
  ).rejects.toThrow('unavailable');
  states.get('still')!.allowed = true;
  states.get('motion')!.allowed = false;
  await expect(
    checkOwnerRestoreItems(auth, manifest, snapshot, true, index, ['motion'], true, 'still'),
  ).rejects.toThrow('unavailable');
});

it('retains a terminal restore diagnostic without exposing exception text or details', async () => {
  const sentinel = 'private-buddy-sentinel';
  const error = Object.assign(new Error(`${sentinel}/path?token=${sentinel}`, { cause: new Error(sentinel) }), {
    code: '23505',
    detail: sentinel,
  });
  const logger = { error: vi.fn() };
  const fail = vi.fn().mockResolvedValue('failed');
  const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
    logger,
    beginRestoreWork: () => Promise.resolve(() => Promise.resolve()),
    binding: () => Promise.reject(error),
    operations: { fail, acknowledgeCancel: () => Promise.resolve(false), settlePause: () => Promise.resolve(false) },
  });
  await service.runClaim({ id: 'operation', snapshot: {} }, 'claim');
  expect(logger.error).toHaveBeenCalledExactlyOnceWith(
    'BUDDY_RESTORE_DIAGNOSTIC {"category":"coded_error","code":"23505","status":null}',
  );
  expect(fail).toHaveBeenCalledExactlyOnceWith(
    'operation',
    'claim',
    {
      error: 'Restore stopped. Check your PIN session, mounts, recovery kit, and backup integrity.',
      errorCode: 'buddy_restore_failed',
    },
    { retry: false },
  );
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain(sentinel);
  expect(JSON.stringify(fail.mock.calls)).not.toContain(sentinel);
});

it.each(['direct', 'cause'] as const)(
  'hands the claim back on %s PostgreSQL lock contention until its attempts are spent',
  async (source) => {
    const sentinel = 'private-buddy-lock-sentinel';
    const contention = Object.assign(new Error(sentinel), { code: '55P03', detail: sentinel });
    const error = source === 'direct' ? contention : new Error(sentinel, { cause: contention });
    const fail = vi.fn().mockResolvedValue('failed');
    const requeue = vi.fn().mockResolvedValue(true);
    const logger = { error: vi.fn(), warn: vi.fn() };
    const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      logger,
      beginRestoreWork: () => Promise.resolve(() => Promise.resolve()),
      binding: () => Promise.reject(error),
      operations: {
        fail,
        requeue,
        acknowledgeCancel: () => Promise.resolve(false),
        settlePause: () => Promise.resolve(false),
      },
    });
    const diagnostic = 'BUDDY_RESTORE_DIAGNOSTIC {"category":"coded_error","code":"55P03","status":null}';
    await service.runClaim({ id: 'operation', snapshot: {}, attempt: 2 }, 'claim');
    expect(requeue).toHaveBeenCalledExactlyOnceWith('operation', 'claim', { delayMs: 4000 });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(diagnostic);
    expect(fail).not.toHaveBeenCalled();
    await service.runClaim({ id: 'operation', snapshot: {}, attempt: 6 }, 'claim');
    expect(requeue).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledExactlyOnceWith('operation', 'claim', expect.any(Object), { retry: true });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(diagnostic);
    expect(JSON.stringify([fail.mock.calls, logger.error.mock.calls, logger.warn.mock.calls])).not.toContain(sentinel);
  },
);

describe('a library restore on a fresh replacement server (FL-508)', () => {
  const administrator = randomUUID();
  const previousOwner = randomUUID();
  const assetId = randomUUID();
  let directory: string;
  let media: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // The path guard refuses symlinked roots, and macOS temporary directories sit behind /var.
    directory = await realpath(await mkdtemp(join(tmpdir(), 'buddy-replacement-')));
    media = vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(directory);
  });

  afterEach(async () => {
    media.mockRestore();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  // A query builder that answers by table and by the `id` it was filtered on; nothing else is modelled.
  const fakeDb = (tables: Record<string, Record<string, unknown>>) => {
    const builder = (table: string, id?: string): any =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            const row = id === undefined ? Object.values(tables[table] ?? {})[0] : tables[table]?.[id];
            if (property === 'then') return;
            if (property === 'executeTakeFirst') return () => Promise.resolve(row);
            if (property === 'execute') return () => Promise.resolve(Object.values(tables[table] ?? {}));
            if (property === 'where')
              return (column: string, _operator: string, value: unknown) =>
                builder(table, column === 'id' && typeof value === 'string' ? value : id);
            return () => builder(table, id);
          },
        },
      );
    const db = { selectFrom: (table: string) => builder(table) };
    return { ...db, transaction: () => ({ execute: (run: (trx: unknown) => unknown) => run(db) }) };
  };

  const restoreService = (users: Record<string, unknown>) =>
    Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      repository: {
        db: fakeDb({
          user: users,
          session: { session: { id: 'session' } },
          media_operation: { operation: { id: 'operation' } },
        }),
      },
      binding: () => Promise.resolve(),
    });
  const manifest: any = {
    library: {
      assets: { [assetId]: { owner: previousOwner, files: [{ role: 'original', path: 'x', sha256: 'a', size: 1 }] } },
    },
  };
  const operation: any = { id: 'operation', ownerId: administrator };
  const original = (): any => ({
    fileKey: `${assetId}:000`,
    assetId,
    role: 'original',
    target: join(directory, 'upload', administrator, 'ab', 'cd', 'photo.jpg'),
  });
  const job = (owners?: Record<string, string>): any => ({ admin: true, sessionId: 'session', owners });

  it('moves an unknown owner’s private paths into the administrator’s folders only', () => {
    const to = { id: administrator, storageLabel: 'admin' };
    expect(
      retargetBuddyOwnerPath(join(directory, 'upload', previousOwner, 'ab', 'cd', 'a.jpg'), previousOwner, to),
    ).toBe(join(directory, 'upload', administrator, 'ab', 'cd', 'a.jpg'));
    expect(retargetBuddyOwnerPath(join(directory, 'thumbs', previousOwner, 'a.webp'), previousOwner, to)).toBe(
      join(directory, 'thumbs', administrator, 'a.webp'),
    );
    expect(retargetBuddyOwnerPath(join(directory, 'library', 'old-label', '2026', 'a.jpg'), previousOwner, to)).toBe(
      join(directory, 'library', 'admin', '2026', 'a.jpg'),
    );
    expect(retargetBuddyOwnerPath('/mnt/external/a.jpg', previousOwner, to)).toBe('/mnt/external/a.jpg');
    expect(retargetBuddyOwnerPath(join(directory, 'upload', administrator, 'a.jpg'), previousOwner, to)).toBe(
      join(directory, 'upload', administrator, 'a.jpg'),
    );
  });

  it('restores a missing owner’s item into the administrator’s account instead of failing as unexpected', async () => {
    vi.spyOn(CloudBackupIndexRepository.prototype, 'getOwnerRestoreAuth').mockResolvedValue({
      auth: { user: { id: administrator, isAdmin: true } },
    } as never);
    const inspect = vi.spyOn(PhysicalFileRepository.prototype, 'inspectOwnerRestorePath').mockResolvedValue();
    const users = { [administrator]: { id: administrator, storageLabel: 'admin', isAdmin: true } };
    const action = vi.fn().mockResolvedValue('skipped');
    const file = original();
    mkdirSync(join(directory, 'upload', administrator, 'ab', 'cd'), { recursive: true });

    // The replacement has no account for the backed-up owner: a named failure, never an unnamed "no result".
    await expect(
      restoreService(users).guarded(operation, 'token', job(), manifest, {}, file, action, true),
    ).rejects.toThrow('Buddy restore owner is missing');
    expect(action).not.toHaveBeenCalled();

    await restoreService(users).guarded(
      operation,
      'token',
      job({ [previousOwner]: administrator }),
      manifest,
      {},
      file,
      action,
      true,
    );
    expect(action).toHaveBeenCalledExactlyOnceWith(expect.anything(), administrator);
    expect(inspect).toHaveBeenCalledWith(file.target, assetId, administrator, undefined);
  });

  it('maps only the backup owners and album owners that have no account on this server', async () => {
    const albumOwner = randomUUID();
    const backup: any = {
      library: { assets: { [assetId]: { owner: previousOwner } } },
      metadata: { albums: { album: { ownerId: albumOwner } } },
    };
    const service = (users: Record<string, unknown>) =>
      Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
        repository: { db: fakeDb({ user: users }) },
      });
    await expect(
      service({ [administrator]: { id: administrator } }).missingOwners(backup, [assetId], administrator),
    ).resolves.toEqual({ [previousOwner]: administrator, [albumOwner]: administrator });
    await expect(
      service({ [previousOwner]: { id: previousOwner }, [albumOwner]: { id: albumOwner } }).missingOwners(
        backup,
        [assetId],
        administrator,
      ),
    ).resolves.toBeUndefined();
  });

  it('writes a missing owner’s original, hash-equal, into the administrator’s folder', async () => {
    const bytes = 'original bytes';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = join(directory, 'upload', previousOwner, 'ab', 'cd', 'photo.jpg');
    const restored = join(directory, 'upload', administrator, 'ab', 'cd', 'photo.jpg');
    mkdirSync(join(directory, 'upload', administrator), { recursive: true });
    const backup: any = {
      library: {
        assets: {
          [assetId]: { owner: previousOwner, files: [{ role: 'original', path, size: bytes.length, sha256 }] },
        },
        profiles: {},
        albums: {},
        people: {},
      },
    };
    const restoreOperation: any = {
      id: randomUUID(),
      ownerId: administrator,
      claimToken: 'token',
      result: {},
      snapshot: {
        request: { scope: 'library', assetIds: [assetId], mode: 'keep' },
        admin: true,
        owner: { current: {} },
        owners: { [previousOwner]: administrator },
        manifestHash: createHash('sha256').update(JSON.stringify(backup)).digest('hex'),
      },
    };
    const complete = vi.fn().mockResolvedValue(true);
    const fail = vi.fn();
    const targets: string[] = [];
    const guard = vi.fn((...args: any[]) => {
      targets.push(args[5].target);
      return args[6]();
    });
    const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      repository: {
        root: () => directory,
        db: fakeDb({ user: { [administrator]: { id: administrator, storageLabel: null } } }),
      },
      crypto: {
        hashFile: async (file: string) =>
          createHash('sha256')
            .update(await readFile(file))
            .digest(),
      },
      storage: {
        mkdirSync: (folder: string) => mkdirSync(folder, { recursive: true }),
        rename,
        unlink,
        checkFileExists: async (file: string) => !!(await lstat(file).catch(() => null)),
      },
      logger: { warn: vi.fn(), error: vi.fn() },
      binding: async () => {},
      guarded: guard,
      index: {
        getOwnerRestoreAuth: () => Promise.resolve({ auth: { user: { isAdmin: true } } }),
        getOwnerRestoreIdentities: () => Promise.resolve({}),
      },
      operations: {
        getOfKind: () => Promise.resolve(restoreOperation),
        reportProgress: () => Promise.resolve(true),
        setBulkResult: () => Promise.resolve({ cancelRequestedAt: null, pauseRequestedAt: null }),
        beginValidation: () => Promise.resolve(true),
        complete,
        fail,
      },
      open: () =>
        Promise.resolve({
          manifest: backup,
          reader: {
            download: async (_manifest: unknown, _sha256: string, file: string) => {
              await writeFile(file, bytes);
              return { sha256, size: bytes.length };
            },
          },
        }),
    });
    const restore = CloudBackupRestorer.prototype.restore;
    // The database finalizer is covered separately; this checks the file plan and publication.
    vi.spyOn(CloudBackupRestorer.prototype, 'restore').mockImplementation(function (
      this: CloudBackupRestorer,
      options,
    ) {
      return restore.call(this, { ...options, library: (result) => Promise.resolve(result) });
    });

    await service.run(restoreOperation, 'token');

    expect(fail).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(new Set(targets)).toEqual(new Set([restored]));
    expect(
      createHash('sha256')
        .update(await readFile(restored))
        .digest('hex'),
    ).toBe(sha256);
  });

  it.each([
    [new Error('Buddy restore owner is missing'), 'owner_missing'],
    [new NoResultError({ kind: 'SelectQueryNode' } as never), 'row_missing'],
  ])('names the failure in the retained diagnostic (%s)', async (error, category) => {
    const logger = { error: vi.fn() };
    const fail = vi.fn().mockResolvedValue('failed');
    const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      logger,
      beginRestoreWork: () => Promise.resolve(() => Promise.resolve()),
      binding: () => Promise.reject(error),
      operations: { fail, acknowledgeCancel: () => Promise.resolve(false), settlePause: () => Promise.resolve(false) },
    });
    await service.runClaim({ id: 'operation', snapshot: {} }, 'claim');
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      `BUDDY_RESTORE_DIAGNOSTIC {"category":"${category}","code":"UNKNOWN","status":null}`,
    );
  });
});
