import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobName, PhysicalFileType, QueueName } from 'src/enum.js';
import { queueAdmission } from 'src/queue/admission.js';
import { afterJobCommit } from 'src/queue/context.js';
import * as observers from 'src/queue/observers.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { StorageService } from 'src/services/storage.service.js';
import { JobOf } from 'src/types.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

describe('Queued asset deletion publication', () => {
  let db: Kysely<DB>;
  let directory: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each([
    'accepted',
    'accepted shared original',
    'accepted shared original without observers',
    'cancelled',
    'cancelled shared original',
    'restored',
    'cleanup refused',
    'handoff refused',
  ] as const)('waits before locking or deleting an asset: %s', async (outcome) => {
    db = await getKyselyDB();
    directory = await mkdtemp(join(tmpdir(), 'asset-deletion-queue-'));
    const originalPath = join(directory, 'original.txt');
    const bytes = 'An unaccepted deletion must keep this original';
    await writeFile(originalPath, bytes);
    const withoutObservers = outcome === 'accepted shared original without observers';
    const droppedObserver = vi.fn().mockResolvedValue(undefined);
    if (withoutObservers) {
      vi.spyOn(observers, 'deliverJobObservers').mockImplementation(
        observers.createObserverDelivery({ maxInFlight: 0 }),
      );
    }
    const { sut, ctx } = newMediumService(AssetService, {
      database: db,
      real: [AssetRepository, AssetJobRepository, PhysicalFileRepository, UserRepository],
      mock: [JobRepository, EventRepository, LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath, deletedAt: new Date() });
    let shared: { id: string; physicalId: string } | undefined;
    if (outcome.includes('shared original') || outcome === 'handoff refused') {
      const { asset: remaining } = await ctx.newAsset({ ownerId: user.id, originalPath });
      const physical = await db
        .insertInto('physical_file')
        .values({
          canonicalAssetId: asset.id,
          checksum: asset.checksum,
          path: originalPath,
          sizeInBytes: bytes.length,
          type: PhysicalFileType.Original,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .updateTable('asset')
        .set({ physicalOriginalFileId: physical.id })
        .where('id', 'in', [asset.id, remaining.id])
        .execute();
      shared = { id: remaining.id, physicalId: physical.id };
    }
    const readAsset = () => db.selectFrom('asset').select('id').where('id', '=', asset.id).executeTakeFirst();
    const announced: boolean[] = [];
    ctx.getMock(EventRepository).emit.mockImplementation(async (...args) => {
      if (args[0] === 'AssetDelete') announced.push((await readAsset()) !== undefined);
    });
    const { sut: storage, ctx: storageCtx } = newMediumService(StorageService, {
      database: db,
      real: [AssetRepository, PhysicalFileRepository],
      mock: [EventRepository, LoggingRepository, StorageRepository],
    });
    storageCtx.getMock(EventRepository).emit.mockImplementation(async (...args) => {
      if (args[0] === 'AssetDelete') announced.push((await readAsset()) !== undefined);
    });
    let returned!: () => void;
    const handlerReturned = new Promise<void>((resolve) => (returned = resolve));
    const jobs = new JobRepository(
      {} as never,
      {} as never,
      {
        emit: async (event: string) => {
          if (event !== 'JobRun') return;
          try {
            await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });
            if (withoutObservers) await afterJobCommit(droppedObserver);
          } finally {
            returned();
          }
        },
      } as never,
      ctx.getMock(LoggingRepository),
      db,
    );
    for (const name of [JobName.AssetDelete, JobName.FileDelete, JobName.StorageTemplateMigrationSingle]) {
      jobs['handlers'][name] = {
        jobName: name,
        queueName: QueueName.BackgroundTask,
        label: name,
        handler: vi.fn(),
      } as never;
    }
    ctx.getMock(JobRepository).queue.mockImplementation(async (item) => {
      if (outcome === 'cleanup refused' && item.name === JobName.FileDelete)
        throw new Error('Cleanup admission refused');
      if (outcome === 'handoff refused' && item.name === JobName.StorageTemplateMigrationSingle)
        throw new Error('Handoff admission refused');
      await jobs.queue(item);
    });
    const worker = randomUUID();
    await jobs['store'].initialize(Object.values(QueueName), worker);
    await jobs.queue({ name: JobName.AssetDelete, data: { id: asset.id, deleteOnDisk: true } });
    const [claim] = await jobs['store'].claim(QueueName.BackgroundTask, worker);
    expect(claim).toBeDefined();
    // An in-flight publication owns the catalogue; deletion must not take an asset lock first.
    const release = await queueAdmission(db).publication.acquire(new AbortController().signal);
    const abort = new AbortController();
    const execution = jobs['execute'](claim, abort);
    try {
      await handlerReturned;
      await expect(readAsset()).resolves.toEqual({ id: asset.id });
      await db.transaction().execute(async (tx) => {
        await sql`set local lock_timeout='200ms'`.execute(tx);
        expect(await tx.selectFrom('asset').select('id').where('id', '=', asset.id).forUpdate().execute()).toEqual([
          { id: asset.id },
        ]);
      });
      expect(announced).toEqual([]);
      if (outcome.startsWith('cancelled')) {
        await sql`update job set "cancelRequestedAt"=clock_timestamp() where id=${claim.id}::uuid`.execute(db);
        abort.abort(new Error('Deletion cancelled'));
      } else if (outcome === 'restored') {
        await db.updateTable('asset').set({ deletedAt: null }).where('id', '=', asset.id).execute();
      }
    } finally {
      release();
      await execution;
    }
    const accepted = outcome.startsWith('accepted');
    await expect(readAsset()).resolves.toEqual(accepted ? undefined : { id: asset.id });
    expect(announced).toEqual([]);
    const cleanup = (
      await sql<{ data: JobOf<JobName.FileDelete> }>`select data from job where name=${JobName.FileDelete}`.execute(db)
    ).rows;
    expect(cleanup).toHaveLength(accepted ? 1 : 0);
    if (accepted) {
      expect(cleanup[0].data.files).toContain(originalPath);
    }
    if (withoutObservers) {
      expect(droppedObserver).not.toHaveBeenCalled();
      expect(ctx.getMock(LoggingRepository).warn).toHaveBeenCalledWith('Accepted job observer delivery unavailable');
    }
    if (shared) {
      await expect(
        db
          .selectFrom('physical_file')
          .select('canonicalAssetId')
          .where('id', '=', shared.physicalId)
          .executeTakeFirst(),
      ).resolves.toEqual({ canonicalAssetId: accepted ? shared.id : asset.id });
      expect(
        (
          await sql<{
            data: { id: string };
          }>`select data from job where name=${JobName.StorageTemplateMigrationSingle}`.execute(db)
        ).rows,
      ).toEqual(accepted ? [{ data: { id: shared.id } }] : []);
      if (accepted) {
        // The durable cleanup runs the deletion listeners even if all queue observers were dropped.
        await storage.handleDeleteFiles(cleanup[0].data);
        expect(announced).toEqual([false]);
        expect(storageCtx.getMock(StorageRepository).unlink).not.toHaveBeenCalled();
      }
    }
    if (accepted) expect(cleanup[0].data).toMatchObject({ removedAssetId: asset.id, removedAssetOwnerId: user.id });
    await expect(readFile(originalPath, 'utf8')).resolves.toBe(bytes);
  });
});
