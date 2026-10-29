import { Kysely, sql } from 'kysely';
import { DatabaseLock, JobStatus, SystemMetadataKey } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BackupSequenceService } from 'src/services/backup-sequence.service.js';
import { getKyselyDB } from 'test/utils.js';

describe('backup sequence worker serialization', () => {
  let db: Kysely<DB>;
  let metadata: SystemMetadataRepository;
  beforeAll(async () => {
    db = await getKyselyDB();
    metadata = new SystemMetadataRepository(db);
  });
  beforeEach(async () => {
    await metadata.delete(SystemMetadataKey.BackupSequence);
  });
  afterAll(async () => {
    await metadata?.delete(SystemMetadataKey.BackupSequence);
    await db?.destroy();
  });

  it.each(['move', 'handleStart'] as const)(
    'serializes %s from a second worker behind a running local backup',
    async (method) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const local = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return JobStatus.Success;
      });
      const worker = () => {
        const logger = LoggingRepository.create();
        const service = new BackupSequenceService(
          logger,
          {} as never,
          metadata,
          new DatabaseRepository(db, logger, {} as never),
          {} as never,
          { queue: vi.fn() } as never,
          {} as never,
          { handleBackupDatabase: local } as never,
          { sequenceStatus: () => Promise.resolve({ on: false, busy: false }) } as never,
          {
            sequenceStatus: () => Promise.resolve({ on: true, busy: true }),
            handleSchedule: () => Promise.resolve(JobStatus.Success),
          } as never,
          { emit: vi.fn() } as never,
        );
        vi.spyOn(service as unknown as { readConfig: () => Promise<unknown> }, 'readConfig').mockResolvedValue({
          backup: { database: { enabled: true } },
        });
        return service;
      };
      const starting = worker().handleStart();
      let following: Promise<unknown> | undefined;
      try {
        await Promise.race([entered.promise, starting]);
        following = worker()[method]();
        await vi.waitFor(
          async () => {
            const { rows } = await sql<{ waiting: number }>`
              SELECT count(*)::int AS waiting FROM pg_locks
              WHERE locktype='advisory' AND classid=0 AND objid=${DatabaseLock.BackupSequenceRun}
                AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted
            `.execute(db);
            expect(rows[0].waiting).toBeGreaterThan(0);
          },
          { timeout: 5000 },
        );
        expect(local).toHaveBeenCalledOnce();
        release.resolve();
        expect(await starting).toBe(JobStatus.Success);
        const result = await following;
        const state = await metadata.get(SystemMetadataKey.BackupSequence);
        expect(state?.run).toMatchObject({ place: 'cloud', begun: true });
        expect(local).toHaveBeenCalledOnce();
        if (method === 'handleStart') {
          expect(result).toBe(JobStatus.Skipped);
          expect(state?.dueAt).toEqual(expect.any(String));
        }
      } finally {
        release.resolve();
        await Promise.allSettled([starting, ...(following ? [following] : [])]);
      }
    },
  );
});
