import { Kysely, sql } from 'kysely';
import type { Mock } from 'vitest';
import { JobName, JobStatus } from 'src/enum.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { DB } from 'src/schema/index.js';
import { BackfillBatchHandler, ForkSchemaMigrationService } from 'src/services/fork-schema-migration.service.js';
import { mediumFactory } from 'test/medium.factory.js';
import { ServiceMocks, getKyselyDB, newTestService } from 'test/utils.js';

/**
 * FL-289: no fork-schema command is ever required, and a restart during the backfill is the normal
 * case. Real Postgres: a claim orphaned by a restart is waited out and taken over, and only an
 * operator pause (the latest pause/resume audit row) keeps startup from continuing the backfill.
 */
const LEASE_MS = 15 * 60_000;

const privacyProgress = async (db: Kysely<DB>) => {
  const { rows } = await sql<{ processed: number; claimToken: string | null }>`
    SELECT processed::float8 AS processed, "claimToken" FROM immich_fork.backfill_progress WHERE kind = 'privacy'
  `.execute(db);
  return rows[0];
};

describe('fork-schema backfill across restarts (FL-289)', () => {
  let db: Kysely<DB>;
  let forkSchema: ForkSchemaRepository;
  let sut: ForkSchemaMigrationService;
  let mocks: ServiceMocks;
  let handler: Mock<BackfillBatchHandler>;
  const assetIds: string[] = [];

  beforeAll(async () => {
    db = await getKyselyDB('fork_backfill_restart');
    forkSchema = new ForkSchemaRepository(db);
    const user = await mediumFactory.userWithClusterGroup(db);
    await db.insertInto('user').values(user).execute();
    for (let index = 0; index < 3; index++) {
      const asset = mediumFactory.assetInsert({ ownerId: user.id });
      await db.insertInto('asset').values(asset).execute();
      assetIds.push(asset.id!);
    }
    await sql`DELETE FROM immich_fork.backfill_progress`.execute(db);
    await sql`UPDATE immich_fork.state SET phase = 'legacy', active = false WHERE id = 1`.execute(db);
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ForkSchemaMigrationService));
    (sut as unknown as { forkSchemaRepository: ForkSchemaRepository }).forkSchemaRepository = forkSchema;
    handler = vi.fn<BackfillBatchHandler>((ids) => Promise.resolve({ count: ids.length, digest: 'c'.repeat(64) }));
    sut.registerHandler('privacy', handler);
  });

  it('re-seeds a dual-write backfill at boot and takes over a claim orphaned by the restart', async () => {
    await sql`UPDATE immich_fork.state SET phase = 'dual-write' WHERE id = 1`.execute(db);
    // The previous process claimed a batch and died with it.
    const orphaned = await forkSchema.claimBatch('privacy', 2);
    expect(orphaned?.ids).toHaveLength(2);

    await sut.onBootstrap();
    expect(mocks.job.queueAll).toHaveBeenCalledOnce();
    expect(mocks.job.queueAll.mock.calls[0]![0]).toContainEqual({
      name: JobName.ForkSchemaBackfill,
      data: { kind: 'privacy', batchSize: 100 },
    });

    // The re-seeded job finds the live lease and comes back just after it expires.
    await expect(sut.runBatch('privacy', 2)).resolves.toBe(JobStatus.Skipped);
    expect(handler).not.toHaveBeenCalled();
    const [{ data }] = mocks.job.queue.mock.calls.at(-1) as [{ data: { delay: number; kind: string } }];
    expect(data.kind).toBe('privacy');
    expect(data.delay).toBeGreaterThan(LEASE_MS - 60_000);
    expect(data.delay).toBeLessThanOrEqual(LEASE_MS + 5000);

    // The lease runs out; the delayed job reclaims the orphaned ids and completes the batch.
    await sql`
      UPDATE immich_fork.backfill_progress SET "claimExpiresAt" = now() - interval '1 second' WHERE kind = 'privacy'
    `.execute(db);
    await expect(sut.runBatch('privacy', 2)).resolves.toBe(JobStatus.Success);

    expect(handler).toHaveBeenCalledExactlyOnceWith(orphaned!.ids);
    await expect(privacyProgress(db)).resolves.toEqual({ processed: 2, claimToken: null });
  });

  it('continues after pause and resume when a later seed failure falls back to legacy', async () => {
    await sut.pause();
    await expect(forkSchema.beginInitialBackfill()).resolves.toEqual({ outcome: 'paused', phase: 'legacy' });

    await sut.resume(100);
    // A later automatic seed failed and returned the library to legacy, with progress rows.
    await expect(forkSchema.transitionPhase('dual-write', 'legacy')).resolves.toBe(true);

    await expect(forkSchema.beginInitialBackfill()).resolves.toEqual({ outcome: 'resumed', phase: 'dual-write' });
  });

  it('reads a pause after a resume as paused', async () => {
    await sut.resume(100);
    await sut.pause();

    await expect(forkSchema.beginInitialBackfill()).resolves.toEqual({ outcome: 'paused', phase: 'legacy' });

    mocks.job.queueAll.mockClear();
    await sut.onBootstrap();
    expect(mocks.job.queueAll).not.toHaveBeenCalled();
  });
});
