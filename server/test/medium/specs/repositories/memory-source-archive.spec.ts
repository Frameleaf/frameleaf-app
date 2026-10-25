import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, MemoryExportFormat, MemoryExportStatus, MemoryType, QueueName } from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { bindSourceReference } from 'test/fixtures/source-reference.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db.destroy());
const fixture = async (count = 1) => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const assets = [];
  for (let i = 0; i < count; i++) assets.push((await ctx.newAsset({ ownerId: user.id })).asset);
  const binding = await bindSourceReference(db, assets[0]);
  const current = await db
    .selectFrom('asset')
    .select(['id', 'originalPath', 'checksum'])
    .where(
      'id',
      'in',
      assets.map((a) => a.id),
    )
    .execute();
  const epochs = await AssetLocalEffectRepository.sourceEpochs(
    db,
    assets.map((a) => a.id),
  );
  const sources = epochs.map((epoch) => ({ ...epoch, ...current.find((a) => a.id === epoch.assetId)! }));
  const memory = await db
    .insertInto('memory')
    .values({ ownerId: user.id, type: MemoryType.OnThisDay, data: {}, memoryAt: new Date() })
    .returningAll()
    .executeTakeFirstOrThrow();
  const run = await db
    .insertInto('memory_export')
    .values({
      ownerId: user.id,
      memoryId: memory.id,
      title: 'Fixture',
      assetIds: assets.map((a) => a.id),
      assetCount: count,
      format: MemoryExportFormat.Archive,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const repo = new MemoryRepository(db);
  const claim = (await repo.claimExport(run.id))!;
  const install = vi.fn(() =>
    Promise.resolve({
      path: '/synthetic/archive.zip',
      sizeInBytes: 42,
      processedAssets: count,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  );
  return { repo, claim, sources, install, binding };
};
it('publishes the complete archive source cohort', async () => {
  const f = await fixture(51);
  expect(await f.repo.checkArchiveSource(f.claim, f.sources[0])).toBe(true);
  expect(await f.repo.publishArchiveExport(f.claim, f.sources, f.install)).toBe(true);
  const run = await f.repo.getExportForJob(f.claim.id);
  expect(run?.status).toBe(MemoryExportStatus.Ready);
  expect(run?.settings?.sourceEpochs).toHaveLength(51);
  expect(f.install).toHaveBeenCalledOnce();
  await f.repo.settleArchiveExport(f.claim, MemoryExportStatus.Failed);
  expect((await f.repo.getExportForJob(f.claim.id))?.status).toBe(MemoryExportStatus.Ready);
});
it('refuses cancellation before installing any file', async () => {
  const f = await fixture();
  await f.repo.requestExportCancel(f.claim.id, f.claim.ownerId);
  expect(await f.repo.checkArchiveSource(f.claim, f.sources[0])).toBe(false);
  expect(await f.repo.publishArchiveExport(f.claim, f.sources, f.install)).toBe(false);
  expect(f.install).not.toHaveBeenCalled();
});
it('refuses a changed resource version before installation', async () => {
  const f = await fixture();
  await db
    .updateTable('photo_source_resource')
    .set({ version: 'e'.repeat(64) })
    .where('id', '=', f.binding.resource.id)
    .execute();
  await expect(f.repo.publishArchiveExport(f.claim, f.sources, f.install)).rejects.toThrow('source admission changed');
  expect(f.install).not.toHaveBeenCalled();
  expect((await f.repo.getExportForJob(f.claim.id))?.status).toBe(MemoryExportStatus.Running);
});
it('refuses a replaced export claim and cannot settle its successor', async () => {
  const f = await fixture();
  await db
    .updateTable('memory_export')
    .set({ startedAt: new Date(Date.now() + 1000) })
    .where('id', '=', f.claim.id)
    .execute();
  expect(await f.repo.publishArchiveExport(f.claim, f.sources, f.install)).toBe(false);
  await f.repo.settleArchiveExport(f.claim, MemoryExportStatus.Failed);
  expect(f.install).not.toHaveBeenCalled();
  expect((await f.repo.getExportForJob(f.claim.id))?.status).toBe(MemoryExportStatus.Running);
});

it('rolls back Ready if the source changes during installation', async () => {
  const f = await fixture();
  await expect(
    db.transaction().execute((tx) =>
      f.repo.publishArchiveExport(
        f.claim,
        f.sources,
        async () => {
          const output = await f.install();
          await tx
            .updateTable('photo_source_resource')
            .set({ version: 'e'.repeat(64) })
            .where('id', '=', f.binding.resource.id)
            .execute();
          return output;
        },
        tx,
      ),
    ),
  ).rejects.toThrow('source admission changed');
  expect(f.install).toHaveBeenCalledOnce();
  expect((await f.repo.getExportForJob(f.claim.id))?.status).toBe(MemoryExportStatus.Running);
});

it('reclaims an uncommitted ZIP even when a failed row has no stored path', async () => {
  const f = await fixture();
  await f.repo.settleArchiveExport(f.claim, MemoryExportStatus.Failed);
  const rows = await f.repo.getFailedArchiveExports([f.claim.id]);
  expect(rows).toHaveLength(1);
  expect(rows[0].path).toBeNull();
  const remove = vi.fn().mockResolvedValue(undefined);
  expect(await f.repo.reclaimArchive(rows[0], new Date(), new Date(0), remove)).toBe(true);
  expect(remove).toHaveBeenCalledOnce();
  expect(await f.repo.publishManagedArchive(f.claim, f.install)).toBe(false);
  expect(f.install).not.toHaveBeenCalled();
});
it('preserves a committed ZIP after a stale failed-row observation', async () => {
  const f = await fixture();
  await f.repo.settleArchiveExport(f.claim, MemoryExportStatus.Failed);
  const [observed] = await f.repo.getFailedArchiveExports([f.claim.id]);
  await db
    .updateTable('memory_export')
    .set({ status: MemoryExportStatus.Ready, path: '/synthetic/committed.zip' })
    .where('id', '=', f.claim.id)
    .execute();
  const remove = vi.fn().mockResolvedValue(undefined);
  expect(await f.repo.reclaimArchive(observed, new Date(), new Date(0), remove)).toBe(false);
  expect(remove).not.toHaveBeenCalled();
});
it('preserves a successor claim after a failed archive observation', async () => {
  const f = await fixture();
  await f.repo.settleArchiveExport(f.claim, MemoryExportStatus.Failed);
  const [observed] = await f.repo.getFailedArchiveExports([f.claim.id]);
  await db
    .updateTable('memory_export')
    .set({ startedAt: new Date(Date.now() + 1000) })
    .where('id', '=', f.claim.id)
    .execute();
  const remove = vi.fn().mockResolvedValue(undefined);
  expect(await f.repo.reclaimArchive(observed, new Date(), new Date(0), remove)).toBe(false);
  expect(remove).not.toHaveBeenCalled();
});
it('publishes a managed archive only while the original claim is current', async () => {
  const f = await fixture();
  expect(await f.repo.publishManagedArchive(f.claim, f.install)).toBe(true);
  expect((await f.repo.getExportForJob(f.claim.id))?.status).toBe(MemoryExportStatus.Ready);
  expect(await f.repo.publishManagedArchive(f.claim, f.install)).toBe(false);
  expect(f.install).toHaveBeenCalledOnce();
});

it('does not reclaim a formerly stale archive after publication or progress wins', async () => {
  const f = await fixture();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 60_000);
  const remove = vi.fn().mockResolvedValue(undefined);
  expect(await f.repo.reclaimArchive(f.claim, now, staleBefore, remove)).toBe(false);
  expect(await f.repo.publishManagedArchive(f.claim, f.install)).toBe(true);
  expect(await f.repo.reclaimArchive(f.claim, now, staleBefore, remove)).toBe(false);
  expect(remove).not.toHaveBeenCalled();
});
it('fences a stale archive before any late publication can install files', async () => {
  const f = await fixture();
  await db
    .updateTable('memory_export')
    .set({ updatedAt: new Date(0) })
    .where('id', '=', f.claim.id)
    .execute();
  const remove = vi.fn().mockResolvedValue(undefined);
  expect(await f.repo.reclaimArchive(f.claim, new Date(), new Date(Date.now() - 60_000), remove)).toBe(true);
  expect(await f.repo.publishManagedArchive(f.claim, f.install)).toBe(false);
  expect(f.install).not.toHaveBeenCalled();
  expect((await f.repo.getExportForJob(f.claim.id))?.status).toBe(MemoryExportStatus.Failed);
});

it('retains archive files until the queue executor has confirmed it stopped', async () => {
  const f = await fixture();
  await f.repo.settleArchiveExport(f.claim, MemoryExportStatus.Failed);
  const jobId = randomUUID(),
    workerId = randomUUID(),
    token = randomUUID();
  await sql`INSERT INTO job_queue(name) VALUES (${QueueName.BackgroundTask}) ON CONFLICT DO NOTHING`.execute(db);
  await sql`INSERT INTO job_worker(id) VALUES (${workerId}::uuid)`.execute(db);
  await sql`INSERT INTO job(id,queue,name,data,"safeToRetry","deadlineMs",state,attempt,token,"workerId","leaseExpiresAt")
    VALUES (${jobId}::uuid,${QueueName.BackgroundTask},${JobName.MemoryExport},${JSON.stringify({ id: f.claim.id })}::text::jsonb,
      true,60000,'active',1,${token}::uuid,${workerId}::uuid,now()+interval '1 minute')`.execute(db);
  await sql`INSERT INTO job_attempt("jobId",attempt,token,"workerId") VALUES (${jobId}::uuid,1,${token}::uuid,${workerId}::uuid)`.execute(
    db,
  );
  const remove = vi.fn().mockResolvedValue(undefined);
  expect(await f.repo.reclaimArchive(f.claim, new Date(), new Date(0), remove)).toBe(false);
  await sql`UPDATE job SET state='needs_attention',token=NULL,"leaseExpiresAt"=NULL WHERE id=${jobId}::uuid`.execute(
    db,
  );
  expect(await f.repo.reclaimArchive(f.claim, new Date(), new Date(0), remove)).toBe(false);
  expect(remove).not.toHaveBeenCalled();
  await db
    .insertInto('system_metadata')
    .values({
      key: `frameleaf-attempt-evidence:${token}` as never,
      value: { jobId, stoppedAt: new Date().toISOString() },
    })
    .execute();
  expect(await f.repo.reclaimArchive(f.claim, new Date(), new Date(0), remove)).toBe(true);
  expect(remove).toHaveBeenCalledOnce();
});

it('stops entry authorization after a resource version changes', async () => {
  const f = await fixture();
  await db
    .updateTable('photo_source_resource')
    .set({ version: 'e'.repeat(64) })
    .where('id', '=', f.binding.resource.id)
    .execute();
  expect(await f.repo.checkArchiveSource(f.claim, f.sources[0])).toBe(false);
});

it.each(['library', 'run'] as const)('pins %s authority through archive publication', async (kind) => {
  const f = await fixture();
  const asset = await db
    .selectFrom('asset')
    .select('libraryId')
    .where('id', '=', f.sources[0].assetId)
    .executeTakeFirstOrThrow();
  await f.repo.publishArchiveExport(f.claim, f.sources, async () => {
    const locked = db
      .transaction()
      .execute((tx) =>
        kind === 'library'
          ? sql`SELECT id FROM library WHERE id=${asset.libraryId}::uuid FOR UPDATE NOWAIT`.execute(tx)
          : sql`SELECT id FROM photo_source_run WHERE id=(SELECT "runId" FROM photo_source_resource WHERE id=${f.binding.resource.id}::uuid) FOR UPDATE NOWAIT`.execute(
              tx,
            ),
      );
    await expect(locked).rejects.toMatchObject({ code: '55P03' });
    return f.install();
  });
});

it('retains orphaned archive files until their actual queue attempt has stopped', async () => {
  const f = await fixture();
  const jobId = randomUUID(),
    workerId = randomUUID(),
    token = randomUUID();
  await sql`INSERT INTO job_queue(name) VALUES (${QueueName.BackgroundTask}) ON CONFLICT DO NOTHING`.execute(db);
  await sql`INSERT INTO job_worker(id) VALUES (${workerId}::uuid)`.execute(db);
  await sql`INSERT INTO job(id,queue,name,data,"safeToRetry","deadlineMs",state,attempt,token,"workerId","leaseExpiresAt")
    VALUES (${jobId}::uuid,${QueueName.BackgroundTask},${JobName.MemoryExport},${JSON.stringify({ id: f.claim.id })}::text::jsonb,
      true,60000,'active',1,${token}::uuid,${workerId}::uuid,now()+interval '1 minute')`.execute(db);
  await sql`INSERT INTO job_attempt("jobId",attempt,token,"workerId") VALUES (${jobId}::uuid,1,${token}::uuid,${workerId}::uuid)`.execute(
    db,
  );
  await f.repo.deleteExport(f.claim.id, f.claim.ownerId);
  const remove = vi.fn().mockResolvedValue(undefined);
  expect(await f.repo.removeArchiveFilesIfStopped(f.claim.id, remove)).toBe(false);
  await sql`UPDATE job SET state='needs_attention',token=NULL,"leaseExpiresAt"=NULL WHERE id=${jobId}::uuid`.execute(
    db,
  );
  expect(await f.repo.removeArchiveFilesIfStopped(f.claim.id, remove)).toBe(false);
  expect(remove).not.toHaveBeenCalled();
  await db
    .insertInto('system_metadata')
    .values({
      key: `frameleaf-attempt-evidence:${token}` as never,
      value: { jobId, stoppedAt: new Date().toISOString() },
    })
    .execute();
  expect(await f.repo.removeArchiveFilesIfStopped(f.claim.id, remove)).toBe(true);
  expect(remove).toHaveBeenCalledOnce();
});
