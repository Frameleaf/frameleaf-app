import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AssetType,
  JobName,
  JobStatus,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
} from 'src/enum.js';
import { deferJobAdoption, queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { QUEUE_TIMING, type QueueExecution } from 'src/queue/types.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import type { DB } from 'src/schema/index.js';
import { CloudMlBatchService } from 'src/services/cloud-ml-batch.service.js';
import { ImageEnrichmentService } from 'src/services/image-enrichment.service.js';
import { recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import {
  CloudDescriptionPhase,
  emptyCloudDescriptionResult,
  parseCloudDescriptionSnapshot,
} from 'src/utils/cloud-description-batch.js';
import type { CloudJobView } from 'src/utils/frameleaf-cloud.js';
import { seedCanonicalAsset, seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { getKyselyDB, newTestService } from 'test/utils.js';

// Real queue/media transactions; remote inference is represented by already-paid, retained results.
describe('cloud description adoption and remote release', () => {
  let db: Kysely<DB>;
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  afterAll(async () => {
    await db?.destroy();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const prepare = async () => {
    const user = await seedCanonicalUser(db);
    const assets = await Promise.all(
      [1, 2].map(() => seedCanonicalAsset(db, { ownerId: user.id, type: AssetType.Image })),
    );
    await db
      .insertInto('asset_exif')
      .values(assets.map(({ id }) => ({ assetId: id })))
      .onConflict((oc) => oc.column('assetId').doNothing())
      .execute();
    const operations = new MediaOperationRepository(db);
    const remoteJobId = randomUUID();
    const initial = {
      ...emptyCloudDescriptionResult(assets.map(({ id }) => id)),
      phase: CloudDescriptionPhase.Submitted,
      job: {
        jobId: remoteJobId,
        status: 'completed',
        holdUsd: 0.2,
        ceilingUsd: 0.22,
        admittedAt: new Date().toISOString(),
        meteredSeconds: 1,
        started: true,
      },
    };
    const operation = await operations.create({
      ownerId: user.id,
      kind: MediaOperationKind.CloudDescriptionBatch,
      destination: MediaOperationDestination.FrameleafCloud,
      label: 'paid descriptions',
      settings: {},
      snapshot: {
        version: 1,
        origin: 'backfill',
        destinationId: randomUUID(),
        assetIds: assets.map(({ id }) => id),
        modelSku: 'model-1',
        packKey: 'pack-1',
        approvedP90Usd: 1,
      },
      result: initial,
      remoteJobId,
    });
    // Isolate claim selection from other specs' unfinished cloud batches.
    const mediaToken = randomUUID();
    await db
      .updateTable('media_operation')
      .set({
        status: MediaOperationStatus.Preparing,
        claimToken: mediaToken,
        claimedBy: 'cloud-descriptions-test',
        claimExpiresAt: new Date(Date.now() + 60_000),
      })
      .where('id', '=', operation.id)
      .execute();
    const { sut, mocks } = newTestService(CloudMlBatchService);
    Object.assign(sut, { mediaOperationRepository: operations });
    const documents = new Map(
      initial.items.map((item) => [
        item.inputId,
        {
          modelRev: 'revision-1',
          item: { description: 'Paid cloud description', tags: [], moment: null, confidence: 0.9, warnings: [] },
        },
      ]),
    );
    vi.spyOn(sut as any, 'downloadResults').mockResolvedValue(documents);
    vi.spyOn(ImageEnrichmentService.prototype, 'publishCloudDescription').mockImplementation(
      async (assetId, _item, source) => {
        deferJobAdoption(async (tx) => {
          const row = await tx
            .updateTable('asset_exif')
            .set({ description: 'Paid cloud description' })
            .where('assetId', '=', assetId)
            .where('assetId', 'in', tx.selectFrom('asset').select('id').where('deletedAt', 'is', null))
            .returning('assetId')
            .executeTakeFirst();
          source.onPublished?.(
            row ? { status: JobStatus.Success } : { status: JobStatus.Skipped, reasonKey: 'not-eligible' },
          );
        });
        return { status: JobStatus.Success };
      },
    );
    mocks.mlDestination.applySettlements.mockResolvedValue(1);
    mocks.frameleafCloudMl.deleteJob.mockResolvedValue();
    const store = new SqlQueueStore(db);
    const queue = `cloud-adoption-${randomUUID()}`;
    const worker = randomUUID();
    await store.initialize([queue], worker);
    const stage = async () => {
      await store.enqueue([
        {
          queue,
          name: JobName.CloudMlDescriptionBatch,
          data: {},
          safeToRetry: false,
          sensitive: false,
          deadlineMs: QUEUE_TIMING.opaqueDeadline,
        },
      ]);
      const [claim] = await store.claim(queue, worker);
      const abort = new AbortController();
      const context: QueueExecution = {
        claim,
        signal: abort.signal,
        progress: () => {},
        progressUnits: 0,
        buffering: true,
        adoptions: [],
        followups: [],
      };
      const current = await db
        .selectFrom('media_operation')
        .selectAll()
        .where('id', '=', operation.id)
        .executeTakeFirstOrThrow();
      await queueExecution.run(context, () =>
        sut['collect'](
          {
            operation: current,
            claimToken: mediaToken,
            snapshot: parseCloudDescriptionSnapshot(operation.snapshot),
            result: initial,
            now: new Date(),
          },
          {} as never,
          { status: 'completed', result: { outputs: [{}] }, cost: { totalUsd: 0.2 } } as CloudJobView,
        ),
      );
      const commit = (extra?: (tx: Kysely<any>) => Promise<void>) =>
        store.complete(claim, context.followups, (tx) =>
          publicationTransaction.run(tx, () =>
            queueExecution.run(context, async () => {
              for (const adopt of context.adoptions) await adopt(tx);
              await extra?.(tx);
              context.signal.throwIfAborted();
            }),
          ),
        );
      const fail = async () => {
        await recordStoppedAttempt(db, claim.id, claim.token);
        // JobRepository settles after leaving the stopped executor's context.
        return store.fail(claim, 'parent stopped', undefined, { settlements: context.failureSettlements });
      };
      return { context, claim, abort, commit, fail };
    };
    const row = () =>
      db.selectFrom('media_operation').selectAll().where('id', '=', operation.id).executeTakeFirstOrThrow();
    const descriptions = async () =>
      (
        await db
          .selectFrom('asset_exif')
          .select('description')
          .where(
            'assetId',
            'in',
            assets.map(({ id }) => id),
          )
          .execute()
      ).map(({ description }) => description);
    return { assets, operation, mediaToken, remoteJobId, sut, mocks, initial, stage, row, descriptions };
  };

  it.each(['rollback', 'parent lease', 'stop'] as const)(
    'keeps paid results and retries after %s prevents parent commit',
    async (failure) => {
      const test = await prepare();
      const before = await test.descriptions();
      const staged = await test.stage();
      expect(await test.descriptions()).toEqual(before);
      expect((await test.row()).status).toBe(MediaOperationStatus.Preparing);
      expect(test.mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
      await expect(
        staged.commit(async (tx) => {
          if (failure === 'parent lease')
            await sql`update job set "leaseExpiresAt" = clock_timestamp() - interval '1 second' where id = ${staged.claim.id}::uuid`.execute(
              tx,
            );
          else if (failure === 'stop') staged.abort.abort(new Error('stop'));
          else throw new Error('rollback');
        }),
      ).rejects.toThrow();
      expect(await test.descriptions()).toEqual(before);
      expect((await test.row()).result).toEqual(test.initial);
      expect(test.mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
      await staged.fail();
      expect(await test.row()).toMatchObject({
        status: MediaOperationStatus.Queued,
        remoteJobId: test.remoteJobId,
        result: test.initial,
        claimToken: null,
      });
      // The next stopped-safe attempt adopts the same remote result; no admission/submission occurs.
      await db
        .updateTable('media_operation')
        .set({
          status: MediaOperationStatus.Preparing,
          claimToken: test.mediaToken,
          claimExpiresAt: new Date(Date.now() + 60_000),
        })
        .where('id', '=', test.operation.id)
        .execute();
      const retry = await test.stage();
      expect(await retry.commit()).toBe(true);
      expect(await test.descriptions()).toEqual(['Paid cloud description', 'Paid cloud description']);
      const accepted = await test.row();
      expect(accepted.status).toBe(MediaOperationStatus.Completed);
      expect(accepted.result).toMatchObject({
        phase: CloudDescriptionPhase.Finished,
        settledUsd: 0.2,
        items: [
          { outcome: 'described', costShareUsd: 0.1 },
          { outcome: 'described', costShareUsd: 0.1 },
        ],
      });
      expect(test.mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
      for (const observer of retry.context.afterCommit ?? []) await observer();
      expect((await test.row()).remoteReleasedAt).not.toBeNull();
      expect(test.mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
    },
  );

  it('keeps completed batches visible to cleanup after a post-commit release failure', async () => {
    const test = await prepare();
    const staged = await test.stage();
    expect(await staged.commit()).toBe(true);
    test.mocks.frameleafCloudMl.deleteJob.mockRejectedValueOnce(new Error('offline'));
    for (const observer of staged.context.afterCommit ?? []) await observer();
    expect(await test.row()).toMatchObject({ status: MediaOperationStatus.Completed, remoteReleasedAt: null });
    const operations = new MediaOperationRepository(db);
    const other = await operations.create({
      ownerId: test.operation.ownerId,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.FrameleafCloud,
      label: 'other remote output',
      settings: {},
      snapshot: {},
      remoteJobId: randomUUID(),
    });
    await db
      .updateTable('media_operation')
      .set({ status: MediaOperationStatus.Completed })
      .where('id', '=', other.id)
      .execute();
    const pending = await operations.getUnreleasedRemoteOperations(1000);
    expect(pending.some(({ id }) => id === test.operation.id)).toBe(true);
    expect(pending.some(({ id }) => id === other.id)).toBe(false);
    await test.sut['release']({} as never, test.operation.id, test.remoteJobId, false);
    expect((await test.row()).remoteReleasedAt).not.toBeNull();
    expect((await operations.getUnreleasedRemoteOperations(1000)).some(({ id }) => id === test.operation.id)).toBe(
      false,
    );
    expect(await test.descriptions()).toEqual(['Paid cloud description', 'Paid cloud description']);
    expect(test.mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
  });

  it('commits a truthful rejected-item outcome alongside another adopted photo', async () => {
    const test = await prepare();
    const staged = await test.stage();
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', test.assets[0].id).execute();
    expect(await staged.commit()).toBe(true);
    expect(await test.row()).toMatchObject({
      status: MediaOperationStatus.Completed,
      result: { items: [{ outcome: 'failed', error: 'not-eligible' }, { outcome: 'described' }] },
    });
    expect((await test.descriptions()).filter((description) => description === 'Paid cloud description')).toHaveLength(
      1,
    );
  });

  it.each(['expired', 'replaced', 'cancelled', 'paused'] as const)(
    'rejects a media claim that is %s before adoption',
    async (state) => {
      const test = await prepare();
      const before = await test.descriptions();
      const staged = await test.stage();
      await db
        .updateTable('media_operation')
        .set(
          state === 'expired'
            ? { claimExpiresAt: new Date(0) }
            : state === 'replaced'
              ? { claimToken: randomUUID() }
              : state === 'cancelled'
                ? { status: MediaOperationStatus.Cancelling, cancelRequestedAt: new Date() }
                : { pauseRequestedAt: new Date() },
        )
        .where('id', '=', test.operation.id)
        .execute();
      await expect(staged.commit()).rejects.toThrow('claim changed before adoption');
      expect(await test.descriptions()).toEqual(before);
      expect((await test.row()).result).toEqual(test.initial);
      expect(test.mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
      await staged.fail();
      expect((await test.row()).status).toBe(
        state === 'paused'
          ? MediaOperationStatus.Paused
          : state === 'expired'
            ? MediaOperationStatus.Queued
            : state === 'cancelled'
              ? MediaOperationStatus.Cancelling
              : MediaOperationStatus.Preparing,
      );
    },
  );
});
