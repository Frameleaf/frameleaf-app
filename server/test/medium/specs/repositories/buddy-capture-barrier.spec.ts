import { Kysely, sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { ChecksumAlgorithm } from 'src/enum.js';
import { BuddyBackupRepository, type BuddySettings } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { BuddyBackupCaptureService } from 'src/services/buddy-backup-capture.service.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

// The capture's realpath calls are the seam: the hook runs while capture resolves a pinned path.
const hook = vi.hoisted(() => ({ onRealpath: undefined as ((path: string) => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped = (async (path: string, ...rest: unknown[]) => {
    await hook.onRealpath?.(path);
    return (actual.realpath as (...args: unknown[]) => Promise<string>)(path, ...rest);
  }) as typeof actual.realpath;
  return { ...actual, default: { ...actual, realpath: wrapped }, realpath: wrapped };
});
vi.mock('src/utils/disk-usage.js', () => ({
  getDiskUsage: () =>
    Promise.resolve({ total: 4096 * 1_000_000_000, free: 4096 * 1_000_000_000, available: 4096 * 1_000_000_000 }),
}));

describe('Buddy capture barrier (FL-1602)', () => {
  let db: Kysely<DB>;
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-capture-barrier-')));
    for (const directory of ['identity', 'vault', 'source']) await mkdir(join(root, directory), { mode: 0o700 });
    StorageCore.setMediaLocation(join(root, 'source'));
    db = await getKyselyDB();
    vi.stubEnv('FRAMELEAF_CONFIG_FILE', undefined);
  }, 30_000);

  afterEach(async () => {
    hook.onRealpath = undefined;
    StorageCore.reset();
    vi.unstubAllEnvs();
    await db?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('lets an import write a file while capture resolves and pins paths, and the snapshot stays pinned', async () => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const bytes = Buffer.from('synthetic original');
    const originalPath = join(root, 'source', 'original.jpg');
    await writeFile(originalPath, bytes);
    await ctx.newAsset({
      ownerId: user.id,
      originalPath,
      checksum: createHash('sha256').update(bytes).digest(),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const config = {
      getEnv: () =>
        mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir: join(root, 'identity') } }),
    } as ConfigRepository;
    const settings: BuddySettings = {
      directory: join(root, 'vault'),
      quotaBytes: 20 * 1024 ** 3,
      uploadMbps: 10,
      downloadMbps: 10,
      schedule: '0 2 * * *',
      timezone: 'UTC',
      windowStart: '00:00',
      windowEnd: '23:59',
      pausedSending: false,
      pausedReceiving: false,
      includeDerived: false,
      configurationFiles: [],
    };
    const runId = randomUUID();
    const events: string[] = [];
    const imported = join(root, 'source', 'imported.jpg');
    hook.onRealpath = async (path) => {
      if (path !== originalPath || events.length > 0) return;
      events.push('pinning');
      // What an import does (asset-writer.ts): the shared barrier, the path lock, then the row.
      await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
        await lockFilePath(trx, imported);
        await sql`INSERT INTO public.physical_file(id, type, checksum, "sizeInBytes", path)
          VALUES (${randomUUID()}::uuid, 'original', ${randomBytes(32)}, 1, ${imported})`.execute(trx);
      });
      events.push('import committed');
      // The snapshot's paths are pinned before the barrier is released.
      const references = await sql<{ path: string }>`SELECT path FROM public.buddy_backup_reference
        WHERE "runId" = ${runId}::uuid`.execute(db);
      expect(references.rows.map((row) => row.path)).toContain(originalPath);
    };
    const backups = {
      createDatabaseBackup: async () => {
        events.push('dump');
        const dump = join(root, 'source', 'database.sql.gz');
        await writeFile(dump, 'fake pg_dump bytes');
        return dump;
      },
    } as unknown as DatabaseBackupService;
    const capture = new BuddyBackupCaptureService(
      new BuddyBackupRepository(db, config),
      backups,
      { queue: vi.fn() } as unknown as JobRepository,
      new CloudBackupKeyRepository(LoggingRepository.create()),
    );

    const result = await capture.capture({
      runId,
      instanceId: randomUUID(),
      sequence: 1,
      previous: null,
      ring: { version: 1, vaultId: randomUUID(), current: 1, keys: { 1: randomBytes(32).toString('base64url') } },
      settings,
      checkpoint: async () => {},
    });

    expect(events).toEqual(['pinning', 'import committed', 'dump']);
    expect(Object.values(result.manifest.library.assets).flatMap((asset) => asset.files)).toEqual([
      expect.objectContaining({ role: 'original', path: originalPath }),
    ]);
    // Nothing of this run holds a transaction open once it returns.
    const open = await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND state LIKE 'idle in transaction%'`.execute(db);
    expect(open.rows[0].count).toBe(0);
  }, 30_000);
});
