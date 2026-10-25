import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JobName, MediaOperationStatus } from 'src/enum.js';
import { BuddyBackupRestoreService } from 'src/services/buddy-backup-restore.service.js';
import * as nativeWork from 'src/utils/cloud-native-work.js';
import { executionSignal } from 'src/utils/execution-signal.js';
import { withOperationExecution } from 'src/utils/operation-execution.js';

vi.mock('src/services/base.service.js', () => ({ BaseService: class {} }));

it.each([
  'unknown-close',
  'claim-lost',
  'stopped-failure',
  'complete',
  'concurrent',
  'new-operation',
  'new-operation-unknown',
] as const)('owns restore producers across %s and database claim changes', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-restore-owner-'));
  const id = randomUUID();
  const hash = createHash('sha256').update('backup').digest('hex');
  const manifest: any = {
    snapshotId: 'snapshot',
    configurationFiles: [{ role: 'configuration', path: '/old/config', sha256: hash, size: 6 }],
  };
  const operation: any = {
    id,
    ownerId: 'owner',
    kind: 'buddy_restore',
    claimToken: 'claim',
    snapshot: {
      request: { scope: 'settings', snapshotId: 'snapshot', mode: 'replace' },
      admin: true,
      manifestHash: 'hash',
    },
  };
  const marker = join(root, 'restores', id, '.frameleaf-native-owner');
  const target = join(root, 'recovery', id, 'objects', hash);
  const temporary = `${target}.tmp-pending`;
  let producerReleased = false;
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const download = vi.fn(async (_manifest, _hash, destination) => {
    await mkdir(dirname(destination), { recursive: true });
    if (
      download.mock.calls.length > 1 &&
      !producerReleased &&
      ['concurrent', 'new-operation', 'new-operation-unknown'].includes(kind)
    )
      throw new Error('Second producer admitted');
    if (['unknown-close', 'claim-lost', 'new-operation-unknown'].includes(kind)) {
      descriptor = await open(temporary, 'wx');
      await descriptor.writeFile('backup');
      if (kind === 'claim-lost')
        await new Promise<void>((resolve) => {
          const signal = executionSignal()!;
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
      throw new Error('buddy_file_close_unconfirmed');
    }
    if (kind === 'stopped-failure') throw new Error('Stopped download');
    if (kind === 'concurrent' || kind === 'new-operation') {
      enter();
      await released;
    }
    await writeFile(destination, 'backup');
    return { size: 6, sha256: hash };
  });
  const operations = {
    getOfKind: vi.fn(() => Promise.resolve(operation)),
    reportProgress: vi.fn().mockResolvedValue(true),
    setBulkResult: vi.fn().mockResolvedValue(true),
    beginValidation: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    fail: vi.fn(),
    acknowledgeCancel: vi.fn().mockResolvedValue(false),
    settlePause: vi.fn().mockResolvedValue(false),
    requeue: vi.fn().mockResolvedValue(true),
  };
  const opened = vi.fn(() => Promise.resolve({ manifest, reader: { download } }));
  const service = () =>
    Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      repository: { root: () => root },
      operations,
      logger: { error: vi.fn(), warn: vi.fn() },
      binding: async () => {},
      fingerprint: () => 'hash',
      open: opened,
      index: { getOwnerRestoreAuth: () => Promise.resolve({ auth: { user: { isAdmin: true } } }) },
      drainRestoreJobs: vi.fn(),
    });
  let running: Promise<void> | undefined;
  try {
    if (kind === 'concurrent' || kind === 'new-operation') {
      running = service().runClaim(operation, 'claim');
      await entered;
      // A new process with a new SQL claim cannot replace the still-owned producer.
      const next = kind === 'new-operation' ? { ...operation, id: randomUUID(), claimToken: 'new-claim' } : operation;
      next.claimToken = 'new-claim';
      operations.getOfKind.mockImplementation((...args: unknown[]) =>
        Promise.resolve(args[0] === next.id ? next : operation),
      );
      await service().runClaim(next, 'new-claim');
      expect(opened).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledTimes(1);
      expect(await lstat(marker)).toMatchObject({ size: 0 });
      expect(operations.complete).not.toHaveBeenCalled();
      producerReleased = true;
      release();
      await running;
      expect(await lstat(marker).catch(() => null)).toBeNull();
      await service().runClaim(next, 'new-claim');
      expect(operations.complete).toHaveBeenCalledTimes(kind === 'new-operation' ? 2 : 1);
    } else {
      if (kind === 'claim-lost')
        await withOperationExecution({ renew: () => Promise.resolve(!descriptor), pollMs: 1 }, () =>
          service().runClaim(operation, 'claim'),
        );
      else await service().runClaim(operation, 'claim');
      if (['unknown-close', 'claim-lost', 'new-operation-unknown'].includes(kind)) {
        expect(await descriptor!.stat()).toMatchObject({ size: 6 });
        expect(await readFile(temporary, 'utf8')).toBe('backup');
        expect(await lstat(target).catch(() => null)).toBeNull();
        const next =
          kind === 'new-operation-unknown' ? { ...operation, id: randomUUID(), claimToken: 'new-claim' } : operation;
        next.claimToken = 'new-claim';
        operations.getOfKind.mockImplementation((...args: unknown[]) =>
          Promise.resolve(args[0] === next.id ? next : operation),
        );
        await service().runClaim(next, 'new-claim');
        expect(opened).toHaveBeenCalledTimes(1);
        expect(download).toHaveBeenCalledTimes(1);
        expect(operations.complete).not.toHaveBeenCalled();
        expect(await lstat(marker)).toMatchObject({ size: 0 });
      } else {
        expect(await lstat(marker).catch(() => null)).toBeNull();
        if (kind === 'stopped-failure') {
          expect(operations.complete).not.toHaveBeenCalled();
          download.mockImplementationOnce(async (_manifest, _hash, destination) => {
            await writeFile(destination, 'backup');
            return { size: 6, sha256: hash };
          });
          await service().runClaim(operation, 'claim');
        }
        expect(operations.complete).toHaveBeenCalledTimes(1);
        expect(await readFile(target, 'utf8')).toBe('backup');
        expect(await lstat(marker).catch(() => null)).toBeNull();
      }
    }
  } finally {
    release();
    await running;
    await descriptor?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not dispatch retained restore jobs when rewound SQL says the producer completed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-restore-dispatch-owner-'));
  const id = randomUUID();
  const assetId = randomUUID();
  const queueAll = vi.fn();
  const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
    repository: { root: () => root },
    operations: { getOfKind: () => Promise.resolve({ status: MediaOperationStatus.Completed, claimToken: null }) },
    jobs: { queueAll },
  });
  let close: (() => Promise<void>) | undefined;
  try {
    const jobs = [{ name: JobName.AssetExtractMetadata, data: { id: assetId } }];
    await service.saveRestoreJobs(id, assetId, jobs);
    close = await nativeWork.beginCloudNativeWork(join(root, 'restores', id));
    await service.drainRestoreJobs();
    expect(queueAll).not.toHaveBeenCalled();
    await close();
    close = undefined;
    await service.drainRestoreJobs();
    expect(queueAll).toHaveBeenCalledExactlyOnceWith(jobs);
    await service.drainRestoreJobs();
    expect(queueAll).toHaveBeenCalledTimes(1);
  } finally {
    await close?.();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not dispatch another completed operation while a legacy restore producer remains unclosed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-restore-legacy-dispatch-'));
  const oldId = randomUUID();
  const id = randomUUID();
  const assetId = randomUUID();
  const oldDirectory = join(root, 'restores', oldId);
  await mkdir(oldDirectory, { recursive: true });
  const closeOld = await nativeWork.beginCloudNativeWork(oldDirectory);
  const descriptor = await open(join(oldDirectory, 'pending.tmp'), 'wx');
  await descriptor.writeFile('unfinished');
  let stopped = false;
  const queueAll = vi.fn();
  const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
    repository: { root: () => root },
    operations: { getOfKind: () => Promise.resolve({ status: MediaOperationStatus.Completed, claimToken: null }) },
    jobs: { queueAll },
  });
  try {
    const jobs = [{ name: JobName.AssetExtractMetadata, data: { id: assetId } }];
    await service.saveRestoreJobs(id, assetId, jobs);
    await expect(service.drainRestoreJobs()).rejects.toThrow('cloud_ml_native_work_retained');
    expect(queueAll).not.toHaveBeenCalled();
    expect(await descriptor.stat()).toMatchObject({ size: 10 });
    await descriptor.close();
    await closeOld();
    stopped = true;
    await service.drainRestoreJobs();
    expect(queueAll).toHaveBeenCalledExactlyOnceWith(jobs);
  } finally {
    if (!stopped) {
      await descriptor.close();
      await closeOld();
    }
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['shared', 'operation'] as const)(
  'reports competing %s ownership as producer-retained even when the atomic create loses its race',
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-restore-owner-race-'));
    const id = randomUUID();
    const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      repository: { root: () => root },
    });
    const begin = nativeWork.beginCloudNativeWork;
    const admission = vi.spyOn(nativeWork, 'beginCloudNativeWork');
    if (phase === 'operation') admission.mockImplementationOnce(begin);
    admission.mockRejectedValueOnce(Object.assign(new Error('Atomic owner create lost'), { code: 'EEXIST' }));
    try {
      await expect(service.beginRestoreWork(id)).rejects.toMatchObject({
        message: 'cloud_ml_native_work_retained',
        cause: { code: 'EEXIST' },
      });
      expect(await lstat(join(root, 'restores', 'producer', '.frameleaf-native-owner')).catch(() => null)).toBeNull();
      expect(await lstat(join(root, 'restores', id, '.frameleaf-native-owner')).catch(() => null)).toBeNull();
    } finally {
      admission.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('refuses a symlink legacy restore scope without touching its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-restore-legacy-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'buddy-restore-link-target-'));
  const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
    repository: { root: () => root },
  });
  try {
    await mkdir(join(root, 'restores'));
    await writeFile(join(outside, 'canary'), 'unchanged');
    await symlink(outside, join(root, 'restores', randomUUID()));
    await expect(service.beginRestoreWork(randomUUID())).rejects.toThrow('cloud_ml_native_work_retained');
    expect(await readFile(join(outside, 'canary'), 'utf8')).toBe('unchanged');
    expect(await readdir(outside)).toEqual(['canary']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it('refuses an oversized restore history without pruning retained records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-restore-history-bound-'));
  const history = join(root, 'restores');
  const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
    repository: { root: () => root },
  });
  try {
    await mkdir(history);
    await Promise.all(Array.from({ length: 2048 }, (_, index) => writeFile(join(history, `retained-${index}`), '')));
    await expect(service.beginRestoreWork(randomUUID())).rejects.toThrow('buddy_restore_history_limit');
    expect((await readdir(history)).filter((name) => name.startsWith('retained-'))).toHaveLength(2048);
    expect(await lstat(join(history, 'producer', '.frameleaf-native-owner')).catch(() => null)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['pause', 'cancel', 'unknown-close', 'retained-producer'] as const)(
  'handles %s after a guard failure without settling an unconfirmed producer',
  async (kind) => {
    const error = new Error(
      kind === 'unknown-close'
        ? 'buddy_file_close_unconfirmed'
        : kind === 'retained-producer'
          ? 'cloud_ml_native_work_retained'
          : 'Buddy restore metadata authority unavailable',
    );
    const operation = { id: randomUUID(), snapshot: { request: { snapshotId: randomUUID() } } };
    const close = vi.fn().mockResolvedValue(undefined);
    const operations = {
      acknowledgeCancel: vi.fn().mockResolvedValue(kind === 'cancel'),
      settlePause: vi.fn().mockResolvedValue(kind === 'pause'),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      logger: { error: vi.fn() },
      binding: () => Promise.resolve(),
      beginRestoreWork: () => (kind === 'retained-producer' ? Promise.reject(error) : Promise.resolve(close)),
      open: () => Promise.reject(error),
      operations,
    });
    await service.runClaim(operation, 'claim');
    if (kind === 'unknown-close' || kind === 'retained-producer') {
      expect(operations.acknowledgeCancel).not.toHaveBeenCalled();
      expect(operations.settlePause).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
    } else {
      expect(operations.acknowledgeCancel).toHaveBeenCalledExactlyOnceWith(operation.id, 'claim', { released: true });
      if (kind === 'pause') expect(operations.settlePause).toHaveBeenCalledExactlyOnceWith(operation.id, 'claim');
      else expect(operations.settlePause).not.toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    }
  },
);

it.each(['ready', 'revoked', 'already-applying'] as const)(
  'holds apply ownership through the maintenance barrier with %s authority',
  async (kind) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-apply-admission-')));
    const id = randomUUID();
    const shared = join(root, 'restores', 'producer');
    await mkdir(shared, { recursive: true });
    await mkdir(join(root, 'recovery', id), { recursive: true });
    await writeFile(
      join(root, 'recovery', id, 'prepared.json'),
      JSON.stringify({
        version: 1,
        scope: 'settings',
        mode: 'replace',
        manifest: { version: 1 },
        files: [],
      }),
    );
    const auth = { user: { id: randomUUID(), email: 'synthetic@example.test' } };
    const job = { admin: true, request: { scope: 'settings' } };
    let contender: (() => Promise<void>) | undefined;
    const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      repository: { root: () => root },
      administrator: vi
        .fn()
        .mockResolvedValueOnce(auth)
        .mockImplementation(() =>
          kind === 'revoked' ? Promise.reject(new Error('administrator revoked')) : Promise.resolve(auth),
        ),
      status: () => Promise.resolve({ phase: 'ready-to-apply', recoveryId: id, state: MediaOperationStatus.Completed }),
      operations: {
        getOfKind: () =>
          Promise.resolve({
            snapshot: job,
            ownerId: auth.user.id,
            status: MediaOperationStatus.Completed,
            result: { recoveryId: id, phase: 'ready-to-apply' },
          }),
      },
      binding: () => Promise.resolve(),
      maintenance: {
        startMaintenance: vi.fn(async () => {
          const outcome = await nativeWork
            .beginCloudNativeWork(shared)
            .then((close) => {
              contender = close;
              return 'accepted';
            })
            .catch((error: Error) => error.message);
          expect(outcome).toBe('cloud_ml_native_work_retained');
          await writeFile(join(root, 'recovery-active.json'), JSON.stringify({ action: { buddyRecoveryId: id } }));
          return { jwt: 'synthetic-maintenance-token' };
        }),
      },
    });
    try {
      if (kind === 'already-applying') {
        await writeFile(join(root, 'recovery-active.json'), 'existing maintenance intent');
        await expect(service.apply(auth, id)).rejects.toThrow('buddy_restore_maintenance_active');
        expect(service.maintenance.startMaintenance).not.toHaveBeenCalled();
        expect(await readFile(join(root, 'recovery-active.json'), 'utf8')).toBe('existing maintenance intent');
        await rm(join(root, 'recovery-active.json'));
      } else if (kind === 'revoked') {
        await expect(service.apply(auth, id)).rejects.toThrow('administrator revoked');
        expect(service.maintenance.startMaintenance).not.toHaveBeenCalled();
        expect(await lstat(join(root, 'recovery-active.json')).catch(() => null)).toBeNull();
      } else {
        await expect(service.apply(auth, id)).resolves.toEqual({ jwt: 'synthetic-maintenance-token' });
        await expect(service.beginRestoreWork(randomUUID())).rejects.toThrow('buddy_restore_maintenance_active');
        await rm(join(root, 'recovery-active.json'));
      }
      expect(await lstat(join(shared, '.frameleaf-native-owner')).catch(() => null)).toBeNull();
      const close = await service.beginRestoreWork(randomUUID());
      await close();
    } finally {
      await contender?.();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('refuses a symlink restore root before writing into its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-restore-root-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'buddy-restore-root-target-'));
  const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
    repository: { root: () => root },
  });
  try {
    await writeFile(join(outside, 'canary'), 'unchanged');
    await symlink(outside, join(root, 'restores'));
    await expect(service.beginRestoreWork(randomUUID())).rejects.toThrow('cloud_ml_native_work_retained');
    expect(await readdir(outside)).toEqual(['canary']);
    expect(await readFile(join(outside, 'canary'), 'utf8')).toBe('unchanged');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
