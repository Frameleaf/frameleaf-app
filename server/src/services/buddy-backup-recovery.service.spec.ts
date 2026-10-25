import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuddySettings, BuddyState } from 'src/repositories/buddy-backup.repository.js';
import { defaults } from 'src/config.js';
import { SystemMetadataKey } from 'src/enum.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BuddyBackupRecoveryService } from 'src/services/buddy-backup-recovery.service.js';
import { BuddyRecoveryFiles } from 'src/utils/buddy-backup-recovery.js';
import { flushBuddyDirectory, writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { backupKeyFile, keyFingerprint } from 'src/utils/cloud-backup.js';
import { beginCloudNativeWork } from 'src/utils/cloud-native-work.js';
import { recoveryAuthorityDigest, recoveryMlConfigOf } from 'src/utils/recovery-ml-authority.js';

const fixture = vi.hoisted(() => ({
  reset: vi.fn(),
  sourceReset: vi.fn(),
  referenceRecovery: vi.fn(),
  media: '',
  rows: [] as unknown[],
  authority: {} as any,
}));
// These tests isolate real file/publication barriers; canonical PG tests exercise the authority helpers.
vi.mock('node:fs/promises', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...fs, open: vi.fn(fs.open) };
});
vi.mock('src/utils/buddy-recovery-ml.js', () => ({
  captureReplacementMl: () => Promise.resolve(fixture.authority),
  readReplacementMl: () => Promise.resolve(fixture.authority),
  preserveHistoricalMl: async () => {},
  admitReplacementMl: async () => {},
  verifyCommittedReplacementMl: async () => {},
}));
vi.mock('src/utils/source-resource-restore.js', () => ({ resetSourceResourcesAfterRestore: fixture.sourceReset }));
vi.mock('src/utils/buddy-reference-recovery.js', () => ({ recoverBuddyReferenceOriginals: fixture.referenceRecovery }));
vi.mock('src/queue/store.js', () => ({ resetQueueAfterRestore: fixture.reset }));
vi.mock('src/constants.js', () => ({ serverVersion: '2.6.0' }));
vi.mock('src/cores/storage.core.js', () => ({ StorageCore: { getMediaLocation: () => fixture.media } }));
vi.mock('src/repositories/buddy-backup.repository.js', () => ({ BuddyBackupRepository: class {} }));
vi.mock('src/repositories/config.repository.js', () => ({ ConfigRepository: class {} }));
vi.mock('src/services/database-backup.service.js', () => ({ DatabaseBackupService: class {} }));
vi.mock('kysely', () => ({ sql: () => ({ execute: () => Promise.resolve({ rows: fixture.rows }) }) }));
vi.mock('src/utils/buddy-backup-vault.js', async (importOriginal) => {
  const vault = await importOriginal<typeof import('src/utils/buddy-backup-vault.js')>();
  return {
    ...vault,
    flushBuddyDirectory: vi.fn(vault.flushBuddyDirectory),
    writeBuddyFile: vi.fn(vault.writeBuddyFile),
  };
});

describe('Buddy recovery crash barriers', () => {
  let root: string;
  let directory: string;
  let id: string;
  let target: string;
  let plan: any;
  let database: any;
  let repository: any;
  let service: BuddyBackupRecoveryService;
  const assert = async () => {};

  beforeEach(async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockReset().mockImplementation(fs.open);
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-service-')));
    fixture.media = join(root, 'media');
    await mkdir(fixture.media);
    id = randomUUID();
    directory = join(root, 'identity', 'buddy', 'recovery', id);
    await mkdir(join(directory, 'objects'), { recursive: true, mode: 0o700 });
    target = join(fixture.media, 'config.json');
    const content = Buffer.from('recovered');
    const sha256 = createHash('sha256').update(content).digest('hex');
    await writeFile(join(directory, 'objects', sha256), content);
    plan = {
      version: 1,
      scope: 'settings',
      mode: 'replace',
      files: [{ path: target, sha256, size: content.length }],
      manifest: {
        version: 1,
        frameleafVersion: '2.6.0',
        storageRoot: fixture.media,
        storageRoots: [fixture.media],
        library: { database: { key: 'dump.sql.gz' } },
        settings: { system: { version: 'restored' }, users: [], fork: [] },
      },
    };
    fixture.authority = {
      binding: {
        format: 1,
        recoveryId: id,
        preparedPlanDigest: recoveryAuthorityDigest(plan),
        replacementIdentity: 'a'.repeat(64),
      },
      config: recoveryMlConfigOf(defaults),
      epoch: 1,
      destinations: [],
      routes: [],
      modelChoices: [],
    };
    // Real filesystem crash barriers here; canonical PG authority is covered separately.
    const metadata = new Map<string, unknown>([[SystemMetadataKey.SystemConfig, { version: 'original' }]]);
    const queryFor = () => {
      let key: string;
      let inserted: { key: string; value: unknown };
      const query: any = {
        select: () => query,
        selectAll: () => query,
        where: (_column: string, _op: string, value: string) => {
          key = value;
          return query;
        },
        values: (value: typeof inserted) => {
          inserted = value;
          return query;
        },
        onConflict: () => query,
        execute: vi.fn(() => {
          if (inserted) metadata.set(inserted.key, inserted.value);
          return Promise.resolve([]);
        }),
        executeTakeFirst: vi.fn(() => Promise.resolve(metadata.has(key) ? { value: metadata.get(key) } : undefined)),
      };
      return query;
    };
    database = {
      selectFrom: vi.fn(() => queryFor()),
      insertInto: vi.fn(() => queryFor()),
      transaction: () => ({ execute: async (run: (trx: any) => Promise<unknown>) => run(database) }),
    };
    const settings: BuddySettings = {
      directory: join(root, 'vault'),
      quotaBytes: 20 * 1024 ** 3,
      uploadMbps: 20,
      downloadMbps: 20,
      schedule: '0 2 * * *',
      timezone: 'UTC',
      windowStart: '00:00',
      windowEnd: '00:00',
      pausedSending: true,
      pausedReceiving: false,
      includeDerived: false,
      configurationFiles: [target],
    };
    const state: BuddyState = {
      version: 1,
      settings,
      pairing: { pairId: randomUUID(), state: 'blocked' } as never,
      recoveryVerified: false,
      probeVerified: false,
      nextScheduledAt: '2026-10-03T02:00:00.000Z',
      lastCompleteAt: null,
      lastVerifiedAt: null,
      lastSequence: 42,
      run: null,
    };
    const statePath = join(root, 'identity', 'buddy', 'state.json');
    await writeBuddyFile(statePath, JSON.stringify(state));
    repository = {
      root: () => join(root, 'identity', 'buddy'),
      db: database,
      state: async () => JSON.parse(await readFile(statePath, 'utf8')) as BuddyState,
      locked: async (_name: string, run: () => Promise<void>) => run(),
      update: async (change: (state: BuddyState) => BuddyState) => {
        const next = change(await repository.state());
        await writeBuddyFile(statePath, JSON.stringify(next));
        return next;
      },
    };
    service = new BuddyBackupRecoveryService(
      repository as never,
      { getEnv: () => ({}) } as never,
      {} as never,
      new CloudBackupKeyRepository(LoggingRepository.create()),
    );
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
  });
  afterEach(async () => {
    vi.mocked(open).mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  it('retains ownership when the first prepared-plan descriptor cannot confirm close', async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let descriptor: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await fs.open(...args);
      if (args[0] !== join(directory, 'prepared.json')) return file;
      descriptor = file;
      return new Proxy(file, {
        get(target, key) {
          if (key === 'close') return () => Promise.reject(new Error('first plan close unconfirmed'));
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    try {
      await expect(service.settings(id, assert)).rejects.toThrow('buddy_file_close_unconfirmed');
      expect(descriptor).toBeDefined();
      expect((await descriptor!.stat()).isFile()).toBe(true);
      await expect(beginCloudNativeWork(join(repository.root(), 'restores', 'producer'))).rejects.toThrow(
        'cloud_ml_native_work_retained',
      );
      await expect(lstat(join(directory, 'publication.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await descriptor?.close();
    }
  });

  it('holds the shared producer reservation until settings recovery settles', async () => {
    const shared = join(repository.root(), 'restores', 'producer');
    await mkdir(shared, { recursive: true });
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let waiting = false;
    let contender: (() => Promise<void>) | undefined;
    const running = service.settings(id, async () => {
      if (!waiting) {
        waiting = true;
        entered.resolve();
        await released.promise;
      }
    });
    try {
      await Promise.race([
        entered.promise,
        running.then(() => {
          throw new Error('Recovery skipped its authority checkpoint');
        }),
      ]);
      const outcome = await beginCloudNativeWork(shared)
        .then((close) => {
          contender = close;
          return 'accepted';
        })
        .catch((error: Error) => error.message);
      expect(outcome).toBe('cloud_ml_native_work_retained');
    } finally {
      await contender?.();
      released.resolve();
      await running;
    }
    expect(await readFile(target, 'utf8')).toBe('recovered');
    const next = await beginCloudNativeWork(shared);
    await next();
  });

  it('retains admission and skips rollback when settings publication cannot confirm file closure', async () => {
    const descriptor = await open(join(directory, 'pending-publisher'), 'w+');
    const publish = BuddyRecoveryFiles.prototype.publish;
    const publishing = vi.spyOn(BuddyRecoveryFiles.prototype, 'publish').mockImplementationOnce(async function (
      this: BuddyRecoveryFiles,
      ...args
    ) {
      await publish.apply(this, args);
      await descriptor.writeFile('pending');
      throw new Error('buddy_file_close_unconfirmed');
    });
    const rollback = vi.spyOn(BuddyRecoveryFiles.prototype, 'rollback');
    try {
      await expect(service.settings(id, assert)).rejects.toThrow('buddy_file_close_unconfirmed');
      expect(rollback).not.toHaveBeenCalled();
      expect(await readFile(target, 'utf8')).toBe('recovered');
      expect(await descriptor.stat()).toMatchObject({ size: 7 });
      await expect(beginCloudNativeWork(join(repository.root(), 'restores', 'producer'))).rejects.toThrow(
        'cloud_ml_native_work_retained',
      );
    } finally {
      await descriptor.close();
      publishing.mockRestore();
      rollback.mockRestore();
    }
  });

  it('retains admission when the actual rollback file read cannot confirm closure', async () => {
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let failed = false;
    let descriptor: Awaited<ReturnType<typeof real.open>> | undefined;
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await real.open(...args);
      if (!failed || args[0] !== target) return file;
      descriptor = file;
      return new Proxy(file, {
        get(target, key) {
          if (key === 'close') return () => Promise.reject(new Error('rollback close unconfirmed'));
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    const rollback = vi.spyOn(BuddyRecoveryFiles.prototype, 'rollback');
    await writeFile(target, 'previous');
    try {
      const outcome = await service
        .settings(id, async () => {
          const current = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          });
          if (!failed && current === 'recovered') {
            failed = true;
            throw new Error('interrupted after file publication');
          }
        })
        .catch((error: Error) => error);
      expect(rollback).toHaveBeenCalledOnce();
      await expect(rollback.mock.results[0].value).rejects.toThrow('buddy_file_close_unconfirmed');
      expect(outcome).toMatchObject({ message: 'buddy_file_close_unconfirmed' });
      expect(descriptor).toBeDefined();
      expect(await descriptor!.stat()).toMatchObject({ size: 9 });
      expect(await readFile(target, 'utf8')).toBe('recovered');
      expect(await readFile(`${target}.buddy-rollback-${id}`, 'utf8')).toBe('previous');
      await expect(beginCloudNativeWork(join(repository.root(), 'restores', 'producer'))).rejects.toThrow(
        'cloud_ml_native_work_retained',
      );
    } finally {
      rollback.mockRestore();
      vi.mocked(open).mockRestore();
      await descriptor?.close();
    }
  });

  it('refuses settings publication while an earlier producer is retained', async () => {
    const owner = join(repository.root(), 'restores', randomUUID());
    await mkdir(owner, { recursive: true });
    const release = await beginCloudNativeWork(owner);
    await writeFile(target, 'replacement settings');
    try {
      await expect(service.prepare(id, assert)).rejects.toThrow('cloud_ml_native_work_retained');
      await expect(service.settings(id, assert)).rejects.toThrow('cloud_ml_native_work_retained');
      expect(await readFile(target, 'utf8')).toBe('replacement settings');
      expect(await readdir(directory)).not.toContain('publication.json');
    } finally {
      await release();
    }
    await service.settings(id, assert);
    expect(await readFile(target, 'utf8')).toBe('recovered');
  });

  it('restores stored Cloud Backup keys without restoring or overwriting instance credentials', async () => {
    const key = Buffer.alloc(32, 42);
    const fingerprint = keyFingerprint(key);
    const content = JSON.stringify(
      backupKeyFile({ key, instanceId: 'old-instance', bucket: 'test', mode: 'server', createdAt: new Date() }),
    );
    plan.manifest.cloudBackupKeys = [{ fingerprint, content }];
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    const identity = join(root, 'identity', 'instance-key.pem');
    await writeFile(identity, 'replacement identity');
    const vault = await vi.importActual<typeof import('src/utils/buddy-backup-vault.js')>(
      'src/utils/buddy-backup-vault.js',
    );
    vi.mocked(flushBuddyDirectory).mockImplementation(async (directory) => {
      if (directory === join(root, 'identity')) {
        vi.mocked(flushBuddyDirectory).mockImplementation(vault.flushBuddyDirectory);
        throw new Error('simulated directory flush failure');
      }
      await vault.flushBuddyDirectory(directory);
    });
    await expect(service.settings(id, assert)).rejects.toThrow('directory flush failure');
    expect(vi.mocked(flushBuddyDirectory)).toHaveBeenLastCalledWith(join(root, 'identity'));
    expect(JSON.parse(await readFile(join(directory, 'publication.json'), 'utf8')).state).toBe('database-ready');
    await service.settings(id, assert);
    const stored = join(root, 'identity', `cloud-backup-${fingerprint}.key`);
    expect(await readFile(stored, 'utf8')).toBe(content);
    expect(await readFile(identity, 'utf8')).toBe('replacement identity');
    await rm(stored);
    // A crash/restart or a missing key after completed publication must replay the import.
    await service.settings(id, assert);
    expect(await readFile(stored, 'utf8')).toBe(content);
    await writeFile(stored, JSON.stringify({ key: Buffer.alloc(32, 7).toString('base64') }));
    await expect(service.settings(id, assert)).rejects.toThrow('different backup key');
    expect(await readFile(identity, 'utf8')).toBe('replacement identity');
  });

  it('rechecks complete recovery before allowing maintenance to end, without replacing the database again', async () => {
    plan.scope = 'server';
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    await writeFile(join(directory, 'publication.json'), JSON.stringify({ version: 2, state: 'complete' }));
    await writeFile(target, 'recovered');
    const restore = vi.fn();
    const state = {
      isMaintenanceMode: true,
      action: { restoreBackupFilename: `buddy-restore-${id}-dump.sql.gz` },
    } as never;
    await service.restore(id, restore, state, assert);
    await rm(target);
    await expect(service.restore(id, restore, state, assert)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(restore).not.toHaveBeenCalled();
  });

  it.each(['settings', 'server'] as const)(
    'blocks completed %s recovery when local boot readiness cannot finalize',
    async (scope) => {
      plan.scope = scope;
      await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
      await writeFile(join(directory, 'publication.json'), JSON.stringify({ version: 2, state: 'complete' }));
      await writeFile(target, 'recovered');
      const restore = vi.fn();
      const maintenance = {
        isMaintenanceMode: true,
        action: { restoreBackupFilename: `buddy-restore-${id}-dump.sql.gz` },
      } as never;
      const recover = () =>
        scope === 'settings' ? service.settings(id, assert) : service.restore(id, restore, maintenance, assert);
      try {
        // A real configured invalid pointer must block the caller before marker removal;
        // the completed publication stays durable for a retry, with no second DB import.
        vi.stubEnv('FRAMELEAF_BUDDY_BOOT_BINDING_FILE', 'invalid-local-pointer');
        await expect(recover()).rejects.toThrow('Invalid replacement-local Buddy boot authority');
        expect(JSON.parse(await readFile(join(directory, 'publication.json'), 'utf8')).state).toBe('complete');
        expect(await readFile(target, 'utf8')).toBe('recovered');
      } finally {
        vi.unstubAllEnvs();
      }
      await recover();
      expect(restore).not.toHaveBeenCalled();
    },
  );

  it('refuses source identity files and aliases before any publication or settings mutation', async () => {
    const key = join(root, 'identity', 'instance-key.pem');
    await writeFile(key, 'replacement identity');
    plan.files[0].path = key;
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    await expect(service.settings(id, assert)).rejects.toThrow('replacement server identity');
    expect(await readFile(key, 'utf8')).toBe('replacement identity');
    await symlink(join(root, 'identity'), join(fixture.media, 'alias'));
    plan.scope = 'server';
    plan.files[0].path = join(fixture.media, 'alias', 'instance-key.pem');
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    await expect(service.restore(id, vi.fn(), {} as never, assert)).rejects.toThrow('Unsafe recovery path');
    expect(database.selectFrom).not.toHaveBeenCalled();
  });

  it('preserves the original settings preimage across a crash after database commit and complete resumes', async () => {
    let committed = false;
    database.transaction = () => ({
      execute: async (run: (trx: any) => Promise<void>) => {
        const result = await run(database);
        committed = true;
        return result;
      },
    });
    await expect(
      service.settings(id, () => {
        if (committed) return Promise.reject(new Error('simulated power loss'));
        return Promise.resolve();
      }),
    ).rejects.toThrow('power loss');
    const original = await readFile(join(directory, 'settings-rollback.json'));
    expect(JSON.parse(original.toString()).system.version).toBe('original');
    const readsBeforeResume = database.selectFrom.mock.calls.length;
    await service.settings(id, assert);
    await service.settings(id, assert);
    expect(await readFile(join(directory, 'settings-rollback.json'))).toEqual(original);
    expect(database.selectFrom.mock.calls.length).toBeGreaterThan(readsBeforeResume);
    await writeFile(target, 'corrupted');
    await expect(service.settings(id, assert)).rejects.toThrow('integrity');
  });

  const savedSettings = (root: string): BuddySettings => ({
    directory: join(root, 'source-vault'),
    quotaBytes: 60 * 1024 ** 3,
    uploadMbps: 7,
    downloadMbps: 9,
    schedule: '0 4 * * *',
    timezone: 'America/Edmonton',
    windowStart: '02:00',
    windowEnd: '07:00',
    pausedSending: false,
    pausedReceiving: true,
    includeDerived: true,
    configurationFiles: [join(root, 'source.conf')],
  });

  it.each(['keep', 'replace'] as const)('restores only safe Buddy preferences under %s', async (mode) => {
    const before = await repository.state();
    const saved = savedSettings(root);
    plan.mode = mode;
    plan.manifest.settings.buddy = { version: 1, settings: saved };
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    const identity = join(root, 'identity', 'instance-key.pem');
    const grants = join(repository.root(), 'grant.json');
    await writeFile(identity, 'replacement identity');
    await writeFile(grants, 'replacement grant');
    await service.settings(id, assert);
    const after = await repository.state();
    const expected =
      mode === 'keep'
        ? before.settings
        : {
            ...saved,
            directory: before.settings.directory,
            quotaBytes: before.settings.quotaBytes,
            configurationFiles: before.settings.configurationFiles,
            pausedSending: true,
          };
    expect(after.settings).toEqual(expected);
    expect({ ...after, settings: before.settings, nextScheduledAt: before.nextScheduledAt }).toEqual(before);
    expect(await readFile(identity, 'utf8')).toBe('replacement identity');
    expect(await readFile(grants, 'utf8')).toBe('replacement grant');
  });

  it('retries failed preferences writes and preserves edits after completion', async () => {
    plan.manifest.settings.buddy = { version: 1, settings: savedSettings(root) };
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    const vault = await vi.importActual<typeof import('src/utils/buddy-backup-vault.js')>(
      'src/utils/buddy-backup-vault.js',
    );
    vi.mocked(writeBuddyFile).mockImplementation(async (...args) => {
      if (args[0] === join(repository.root(), 'state.json')) {
        vi.mocked(writeBuddyFile).mockImplementation(vault.writeBuddyFile);
        throw new Error('simulated local preferences write failure');
      }
      await vault.writeBuddyFile(...args);
    });
    await expect(service.settings(id, assert)).rejects.toThrow('local preferences write failure');
    expect(JSON.parse(await readFile(join(directory, 'publication.json'), 'utf8')).state).toBe('database-ready');
    await service.settings(id, assert);
    expect((await repository.state()).settings.uploadMbps).toBe(7);
    await repository.update((state: BuddyState) => ({
      ...state,
      settings: { ...state.settings!, uploadMbps: 333, schedule: '0 8 * * *', pausedReceiving: false },
    }));
    await service.settings(id, assert);
    expect((await repository.state()).settings).toMatchObject({
      uploadMbps: 333,
      schedule: '0 8 * * *',
      pausedReceiving: false,
    });
  });

  it.each([1, 2])('resumes format %s server recovery at database-ready without repeating import', async (version) => {
    fixture.sourceReset.mockClear();
    fixture.referenceRecovery.mockClear();
    plan.manifest.version = version;
    plan.scope = 'server';
    plan.manifest.settings.buddy = { version: 1, settings: savedSettings(root) };
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    await writeFile(join(directory, 'publication.json'), JSON.stringify({ version: 2, state: 'database-ready' }));
    await writeFile(join(directory, 'replacement.json'), JSON.stringify({ keys: [], metadata: [] }));
    await writeFile(target, 'recovered');
    const deletion = { where: vi.fn().mockReturnThis(), execute: vi.fn().mockResolvedValue(undefined) };
    database.deleteFrom = vi.fn(() => deletion);
    const restore = vi.fn();
    const maintenance = {
      isMaintenanceMode: true,
      action: { restoreBackupFilename: `buddy-restore-${id}-dump.sql.gz` },
    } as never;
    const before = await repository.state();
    await service.restore(id, restore, maintenance, assert);
    expect(fixture.reset).toHaveBeenCalledWith(database);
    expect(fixture.sourceReset).toHaveBeenCalledWith(database);
    if (version === 2) {
      expect(fixture.referenceRecovery).toHaveBeenCalledWith(database, plan, assert);
      expect(fixture.sourceReset.mock.invocationCallOrder[0]).toBeLessThan(
        fixture.referenceRecovery.mock.invocationCallOrder[0],
      );
    } else expect(fixture.referenceRecovery).not.toHaveBeenCalled();
    expect(database.deleteFrom.mock.calls).toEqual([['session'], ['system_metadata']]);
    expect(deletion.where).toHaveBeenCalledExactlyOnceWith('key', 'in', []);
    expect((await repository.state()).settings).toMatchObject({
      uploadMbps: 7,
      pausedSending: true,
      pausedReceiving: true,
    });
    expect((await repository.state()).pairing).toEqual(before.pairing);
    expect((await repository.state()).recoveryVerified).toBe(false);
    await repository.update((state: BuddyState) => ({ ...state, settings: { ...state.settings!, uploadMbps: 333 } }));
    await service.restore(id, restore, maintenance, assert);
    expect((await repository.state()).settings.uploadMbps).toBe(333);
    expect(restore).not.toHaveBeenCalled();
  });

  it('checks the lease before local preferences publication and resumes safely', async () => {
    plan.manifest.settings.buddy = { version: 1, settings: savedSettings(root) };
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    const before = await repository.state();
    const lease = async () => {
      if ((await readdir(repository.root())).some((name) => name.startsWith('.tmp-'))) {
        throw new Error('maintenance lease lost before preferences publication');
      }
    };
    await expect(service.settings(id, lease)).rejects.toThrow('maintenance lease lost');
    expect(await repository.state()).toEqual(before);
    expect(JSON.parse(await readFile(join(directory, 'publication.json'), 'utf8')).state).toBe('database-ready');
    expect((await readdir(repository.root())).some((name) => name.startsWith('.tmp-'))).toBe(false);
    await service.settings(id, assert);
    expect((await repository.state()).settings.uploadMbps).toBe(7);
  });

  it.each([
    ['rate below minimum', { uploadMbps: 0 }],
    ['rate above maximum', { downloadMbps: 10_001 }],
    ['quota below minimum', { quotaBytes: 1024 ** 3 }],
    ['unsafe quota', { quotaBytes: Number.MAX_SAFE_INTEGER + 1 }],
    ['invalid cron', { schedule: 'manual' }],
    ['invalid timezone', { timezone: 'Not/A_Timezone' }],
    ['invalid window', { windowStart: '25:00' }],
    ['invalid pause', { pausedSending: 'false' }],
    ['configuration limit', { configurationFiles: Array.from({ length: 33 }, (_, index) => `/config/${index}`) }],
    ['unknown authority field', { pairing: {} }],
  ] as const)('rejects %s before publication or database writes', async (_name, invalid) => {
    plan.manifest.settings.buddy = { version: 1, settings: { ...savedSettings(root), ...invalid } };
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    await expect(service.settings(id, assert)).rejects.toThrow();
    expect(database.selectFrom).not.toHaveBeenCalled();
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(directory, 'publication.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an unsupported Buddy settings version before server preparation or database replacement', async () => {
    plan.scope = 'server';
    plan.manifest.settings.buddy = { version: 2, settings: savedSettings(root) };
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    const restore = vi.fn();
    await expect(service.prepare(id)).rejects.toThrow('version');
    await expect(service.restore(id, restore, {} as never, assert)).rejects.toThrow('version');
    expect(restore).not.toHaveBeenCalled();
    expect(database.selectFrom).not.toHaveBeenCalled();
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(directory, 'replacement.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
