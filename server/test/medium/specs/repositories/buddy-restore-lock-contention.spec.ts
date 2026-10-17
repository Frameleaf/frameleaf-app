import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { BuddyBackupRestoreService } from 'src/services/buddy-backup-restore.service.js';
import { CloudBackupRestorer } from 'src/services/cloud-backup-restore.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

// The operation rows are real: a mocked `fail` hid that its automatic retry never applies to a Buddy restore.
it('finishes a Buddy restore whose first claim lost a NOWAIT lock (55P03)', async () => {
  const db = await getKyselyDB('fl310_buddy_restore_lock_contention');
  const directory = await mkdtemp(join(tmpdir(), 'buddy-restore-lock-'));
  const operations = new MediaOperationRepository(db);
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const assetId = randomUUID();
  const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
  const file = { role: 'original', path: join(directory, 'original'), size: 14, sha256: hash('original bytes') };
  const manifest = {
    library: { assets: { [assetId]: { owner: user.id, files: [file] } }, profiles: {}, albums: {}, people: {} },
  };
  const { id } = await operations.create({
    ownerId: user.id,
    kind: MediaOperationKind.BuddyRestore,
    destination: MediaOperationDestination.Local,
    label: 'Buddy restore lock contention',
    snapshot: {
      request: { scope: 'asset', assetIds: [assetId], mode: 'keep' },
      admin: true,
      owner: { current: { [assetId]: { originalPath: file.path, isExternal: false } } },
      manifestHash: hash(JSON.stringify(manifest)),
    },
    settings: {},
  });
  const guarded = vi
    .fn((...args: unknown[]) => (args[6] as () => Promise<unknown>)())
    .mockRejectedValueOnce(new Error('lock', { cause: Object.assign(new Error('lock'), { code: '55P03' }) }));
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
    repository: { root: () => directory, db },
    crypto: { hashFile: async (path: string) => Buffer.from(hash(await readFile(path)), 'hex') },
    storage: {
      mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
      rename,
      unlink,
      checkFileExists: async (path: string) => !!(await lstat(path).catch(() => null)),
    },
    logger,
    binding: async () => {},
    guarded,
    index: {
      getOwnerRestoreAuth: () => Promise.resolve({ auth: { user: { isAdmin: true } } }),
      getOwnerRestoreIdentities: () => Promise.resolve({ [assetId]: { originalPath: file.path, isExternal: false } }),
    },
    operations,
    open: () =>
      Promise.resolve({
        manifest,
        reader: {
          download: async (_manifest: unknown, sha256: string, path: string) => {
            await writeFile(path, 'original bytes');
            return { sha256, size: file.size };
          },
        },
      }),
  });
  const restore = CloudBackupRestorer.prototype.restore;
  // The file phase is under test; the database metadata finalizer has its own specs.
  const restorer = vi.spyOn(CloudBackupRestorer.prototype, 'restore').mockImplementation(function (
    this: CloudBackupRestorer,
    options,
  ) {
    return restore.call(this, { ...options, library: (result) => Promise.resolve(result) });
  });
  const media = vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(directory);
  const claim = () =>
    operations.claimNext({ kinds: [MediaOperationKind.BuddyRestore], workerId: 'test', leaseMs: 300_000 });
  const row = () =>
    db
      .selectFrom('media_operation')
      .select(['status', 'attempt', 'retryAt', 'errorCode'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  try {
    await writeFile(file.path, 'original bytes');
    const first = await claim();
    await service.run(first!.operation, first!.claimToken);
    expect(await row()).toMatchObject({ status: MediaOperationStatus.Queued, attempt: 1, errorCode: null });
    expect(logger.warn).toHaveBeenCalledWith(
      'BUDDY_RESTORE_DIAGNOSTIC {"category":"coded_error","code":"55P03","status":null}',
    );
    expect(logger.error).not.toHaveBeenCalled();
    // The handback waits out a short delay before anybody may claim it again.
    expect((await row()).retryAt).not.toBeNull();
    expect(await claim()).toBeUndefined();
    await db.updateTable('media_operation').set({ retryAt: null }).where('id', '=', id).execute();
    const second = await claim();
    expect(second!.operation.attempt).toBe(2);
    await service.run(second!.operation, second!.claimToken);
    expect(await row()).toMatchObject({ status: MediaOperationStatus.Completed, errorCode: null });

    // Contention that never clears is still reported, once the claims set aside for it are spent.
    const stuck = await operations.create({
      ownerId: user.id,
      kind: MediaOperationKind.BuddyRestore,
      destination: MediaOperationDestination.Local,
      label: 'Buddy restore lock contention',
      snapshot: {},
      settings: {},
    });
    service.binding = () => Promise.reject(Object.assign(new Error('lock'), { code: '55P03' }));
    for (let attempt = 1; attempt <= 6; attempt++) {
      await db.updateTable('media_operation').set({ retryAt: null }).where('id', '=', stuck.id).execute();
      const next = await claim();
      expect(next!.operation).toMatchObject({ id: stuck.id, attempt });
      await service.run(next!.operation, next!.claimToken);
    }
    expect(
      await db.selectFrom('media_operation').select('status').where('id', '=', stuck.id).executeTakeFirstOrThrow(),
    ).toEqual({ status: MediaOperationStatus.Failed });
  } finally {
    restorer.mockRestore();
    media.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
