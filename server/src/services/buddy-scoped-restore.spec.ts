import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, JobName, MediaOperationStatus } from 'src/enum.js';
import { BuddyBackupRestoreService } from 'src/services/buddy-backup-restore.service.js';
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
    binding: () => Promise.reject(error),
    operations: { fail },
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
  'uses the single automatic retry for %s PostgreSQL lock contention',
  async (source) => {
    const sentinel = 'private-buddy-lock-sentinel';
    const contention = Object.assign(new Error(sentinel), { code: '55P03', detail: sentinel });
    const error = source === 'direct' ? contention : new Error(sentinel, { cause: contention });
    const fail = vi.fn().mockResolvedValue('retrying');
    const logger = { error: vi.fn() };
    const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      logger,
      binding: () => Promise.reject(error),
      operations: { fail },
    });
    await service.runClaim({ id: 'operation', snapshot: {} }, 'claim');
    expect(fail).toHaveBeenCalledWith('operation', 'claim', expect.any(Object), { retry: true });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'BUDDY_RESTORE_DIAGNOSTIC {"category":"coded_error","code":"55P03","status":null}',
    );
    expect(JSON.stringify([fail.mock.calls, logger.error.mock.calls])).not.toContain(sentinel);
  },
);
