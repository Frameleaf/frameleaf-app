import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  AssetType,
  JobName,
  JobStatus,
  MediaOperationKind,
  MediaOperationStatus,
  QueueJobStatus,
  QueueName,
} from 'src/enum.js';
import { publishJobResult, queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { QUEUE_TIMING, QueueExecution } from 'src/queue/types.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { ATTEMPT_EVIDENCE_PREFIX, recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import { EditOperationRun, EditOperationTracker } from 'src/utils/edit-operation-tracker.js';
import { EditOperationEdit, editOperationCreate } from 'src/utils/edit-operation.js';
import { seedCanonicalAsset, seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

describe('retained video publication under queue and operation claims', () => {
  let db: Kysely<DB>;
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const prepare = async (runHandler = true, destination?: QueueName) => {
    const user = await seedCanonicalUser(db);
    const asset = await seedCanonicalAsset(db, { ownerId: user.id, type: AssetType.Video });
    const edits = new AssetEditRepository(db);
    const result = (label: string) => ({
      masterPath: `/${asset.id}/${label}/master.mp4`,
      width: 320,
      height: 240,
      duration: 1000,
      files: [
        {
          assetId: asset.id,
          type: AssetFileType.EncodedVideo,
          path: `/${asset.id}/${label}/proxy.mp4`,
          isEdited: true,
          isProgressive: false,
          isTransparent: false,
        },
      ],
    });
    await edits.replaceAll(asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }]);
    const previous = (await edits.getRequestedVideoVersion(asset.id))!;
    expect((await edits.publishVideoVersion(previous, result('previous'))).published).toBe(true);
    await edits.replaceAll(asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }]);
    const candidate = (await edits.getRequestedVideoVersion(asset.id))!;
    const operations = new MediaOperationRepository(db);
    const operation = await operations.create(
      editOperationCreate({
        ownerId: user.id,
        assetId: asset.id,
        edit: EditOperationEdit.VideoEdit,
        label: 'video fixture',
        job: { name: JobName.AssetVideoEditGeneration, data: { id: asset.id, versionId: candidate.id } },
      }),
    );
    const store = new SqlQueueStore(db);
    const queue = destination ?? `video-publication-${randomUUID()}`;
    const worker = randomUUID();
    await store.initialize([queue], worker);
    await store.enqueue([
      {
        queue,
        name: JobName.AssetVideoEditGeneration,
        data: { id: asset.id, versionId: candidate.id, operationId: operation.id },
        safeToRetry: false,
        sensitive: false,
        deadlineMs: QUEUE_TIMING.opaqueDeadline,
      },
    ]);
    const [claim] = await store.claim(queue, worker);
    const context: QueueExecution = {
      claim,
      signal: new AbortController().signal,
      progress: vi.fn(),
      progressUnits: 0,
      buffering: false,
      adoptions: [],
      followups: [],
    };
    const tracker = new EditOperationTracker(operations, {} as never, { log: vi.fn(), warn: vi.fn(), error: vi.fn() });
    let run: EditOperationRun | undefined;
    const render = () =>
      tracker.execute(operation.id, async (activeRun) => {
        run = activeRun;
        await publishJobResult(async () => {
          if (!(await edits.publishVideoVersion(candidate, result('candidate'))).published) {
            throw new Error('Video version changed before publication');
          }
        });
        return JobStatus.Success;
      });
    if (runHandler) await queueExecution.run(context, render);
    const commit = () =>
      store.complete(claim, [], (tx) =>
        publicationTransaction.run(tx, () =>
          queueExecution.run(context, async () => {
            for (const adopt of context.adoptions) await adopt(tx);
          }),
        ),
      );
    const files = () => db.selectFrom('asset_file').select('path').where('assetId', '=', asset.id).execute();
    return {
      asset,
      edits,
      previous,
      candidate,
      operations,
      operation,
      claim,
      context,
      store,
      render,
      commit,
      files,
      result,
      get run() {
        return run;
      },
    };
  };

  it('keeps the previous projection until the version, references, job and operation commit together', async () => {
    const fixture = await prepare();
    const changed = vi.fn();
    fixture.operations.onChange(changed);
    expect(await fixture.files()).toEqual([{ path: fixture.result('previous').files[0].path }]);
    expect((await fixture.edits.getVideoVersion(fixture.asset.id, fixture.candidate.id))?.masterPath).toBeNull();
    expect(await fixture.commit()).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    for (const notify of fixture.context.afterCommit ?? []) await notify();
    expect(changed).toHaveBeenCalledExactlyOnceWith([{ id: fixture.operation.id, ownerId: fixture.operation.ownerId }]);
    expect(await fixture.files()).toEqual([{ path: fixture.result('candidate').files[0].path }]);
    expect((await fixture.edits.getVideoVersion(fixture.asset.id, fixture.candidate.id))?.status).toBe('ready');
    expect((await fixture.operations.getForWorker(fixture.operation.id))?.status).toBe(MediaOperationStatus.Completed);
    expect(await fixture.commit()).toBe(false);
    expect((await fixture.edits.getVideoVersion(fixture.asset.id, fixture.previous.id))?.masterPath).toBe(
      fixture.result('previous').masterPath,
    );
  });

  it('keeps the same operation claim usable when queue publication rolls back after adoption', async () => {
    const fixture = await prepare();
    const run = fixture.run!;
    expect(run).toBeDefined();
    expect(run.done).toBe(false);
    fixture.context.adoptions.push(async (tx) => {
      // The real operation transition has succeeded inside the publication transaction.
      // Expire only its queue lease so the store's final guard rolls that transaction back.
      expect(
        await tx
          .selectFrom('media_operation')
          .select(['status', 'claimToken'])
          .where('id', '=', run.id)
          .executeTakeFirst(),
      ).toEqual({ status: MediaOperationStatus.Completed, claimToken: null });
      await sql`update job set "leaseExpiresAt" = clock_timestamp() - interval '1 second'
        where id = ${fixture.claim.id}::uuid and token = ${fixture.claim.token}::uuid`.execute(tx);
    });
    await expect(fixture.commit()).rejects.toThrow('Publication lease expired before commit');
    expect(await fixture.files()).toEqual([{ path: fixture.result('previous').files[0].path }]);
    expect((await fixture.edits.getVideoVersion(fixture.asset.id, fixture.candidate.id))?.masterPath).toBeNull();
    expect(await fixture.operations.getForWorker(run.id)).toMatchObject({
      status: MediaOperationStatus.Validating,
      claimToken: run.claimToken,
      resultAssetId: null,
      attempt: 1,
      autoRetries: 0,
    });
    const {
      rows: [job],
    } = await sql`select state,token,attempt from job where id = ${fixture.claim.id}::uuid`.execute(db);
    expect(job).toEqual({ state: 'active', token: fixture.claim.token, attempt: 1 });
    // Rollback cannot grant a different claimant authority or silently settle this owner.
    const failure = { error: 'Publication lease expired before commit', errorCode: 'publication_lease_expired' };
    const changed = vi.fn();
    fixture.operations.onChange(changed);
    expect(await fixture.operations.fail(run.id, randomUUID(), failure, { retry: false })).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(await run.fail(failure.error, failure.errorCode, { retry: false })).toBe('failed');
    expect(changed).toHaveBeenCalledExactlyOnceWith([{ id: fixture.operation.id, ownerId: fixture.operation.ownerId }]);
    expect(await fixture.operations.getForWorker(run.id)).toMatchObject({
      status: MediaOperationStatus.Failed,
      claimToken: null,
      resultAssetId: null,
      errorCode: failure.errorCode,
      attempt: 1,
      autoRetries: 0,
    });
  });

  it('hands a rolled-back publication to its stopped operation owner through the real facade', async () => {
    const fixture = await prepare(false, QueueName.VideoConversion);
    const notify = vi.fn();
    const emit = vi.fn(async () => {
      await fixture.render();
      const context = queueExecution.getStore()!;
      (context.afterCommit ??= []).push(notify);
      context.followups.push({
        queue: fixture.claim.queue,
        name: JobName.FileDelete,
        data: { files: ['must-not-publish'] },
        safeToRetry: false,
        sensitive: true,
        deadlineMs: QUEUE_TIMING.opaqueDeadline,
      });
      context.adoptions.push(async (tx) => {
        expect(
          await tx
            .selectFrom('media_operation')
            .select('status')
            .where('id', '=', fixture.operation.id)
            .executeTakeFirst(),
        ).toEqual({ status: MediaOperationStatus.Completed });
        await sql`update job set "leaseExpiresAt" = clock_timestamp() - interval '1 second'
          where id = ${fixture.claim.id}::uuid and token = ${fixture.claim.token}::uuid`.execute(tx);
      });
    });
    const logger = { setContext: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const facade = new JobRepository({} as never, {} as never, { emit } as never, logger as never, db);
    await facade['execute'](fixture.claim, new AbortController());
    expect(emit).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'Queue execution failed',
      expect.objectContaining({ phase: 'deferred_publication', reasonCode: 'publication_lease_expired' }),
    );
    expect(await fixture.files()).toEqual([{ path: fixture.result('previous').files[0].path }]);
    expect((await fixture.edits.getVideoVersion(fixture.asset.id, fixture.candidate.id))?.masterPath).toBeNull();
    expect(await fixture.operations.getForWorker(fixture.operation.id)).toMatchObject({
      status: MediaOperationStatus.Queued,
      claimToken: null,
      resultAssetId: null,
      attempt: 1,
      autoRetries: 1,
    });
    const { rows: jobs } =
      await sql`select id, state, token, attempt from job where queue = ${fixture.claim.queue}`.execute(db);
    expect(jobs).toEqual([{ id: fixture.claim.id, state: 'needs_attention', token: null, attempt: 1 }]);
    const { rows: evidence } = await sql`select value->>'jobId' "jobId", value ? 'stoppedAt' stopped
      from system_metadata where key = ${ATTEMPT_EVIDENCE_PREFIX + fixture.claim.token}`.execute(db);
    expect(evidence).toEqual([{ jobId: fixture.claim.id, stopped: true }]);
    expect(await fixture.store.claim(fixture.claim.queue, fixture.claim.workerId)).toEqual([]);
    // The operation owns the delayed retry; an empty execution buffer is still unfinished.
    expect(await fixture.store.hasUnfinishedWork(fixture.claim.queue)).toBe(true);
    expect(await fixture.store.queuesWithUnfinishedWork([fixture.claim.queue])).toEqual([fixture.claim.queue]);
    expect(await fixture.store.counts(fixture.claim.queue)).toMatchObject({ failed: 0, delayed: 1, completed: 0 });
    expect(await facade.searchJobs(QueueName.VideoConversion, { status: [QueueJobStatus.Failed] })).toEqual([]);
    expect(
      await fixture.operations.requestPause(fixture.operation.id, fixture.operation.ownerId, [MediaOperationKind.QuickEdit]),
    ).toMatchObject({ status: MediaOperationStatus.Paused });
    expect(await fixture.store.counts(fixture.claim.queue)).toMatchObject({ failed: 0, paused: 1, delayed: 0 });
    expect(await fixture.store.hasUnfinishedWork(fixture.claim.queue)).toBe(true);
    await fixture.operations.resume(fixture.operation.id, fixture.operation.ownerId);
    await sql`update media_operation set "retryAt" = null where id = ${fixture.operation.id}::uuid`.execute(db);
    facade['handlers'][JobName.AssetVideoEditGeneration] = {
      jobName: JobName.AssetVideoEditGeneration,
      queueName: QueueName.VideoConversion,
      label: 'video fixture',
      handler: vi.fn(),
    };
    const dispatcher = new EditOperationTracker(fixture.operations, facade, logger as never);
    expect(await dispatcher.dispatch()).toBe(1);
    const [retry] = await fixture.store.claim(fixture.claim.queue, fixture.claim.workerId);
    expect(retry.id).not.toBe(fixture.claim.id);
    expect(retry).toMatchObject({ attempt: 1, data: { operationId: fixture.operation.id } });
    emit.mockImplementationOnce(async () => {
      await fixture.render();
    });
    await facade['execute'](retry, new AbortController());
    expect(await fixture.operations.getForWorker(fixture.operation.id)).toMatchObject({
      status: MediaOperationStatus.Completed,
      autoRetries: 1,
      attempt: 2,
    });
    expect(await fixture.store.counts(fixture.claim.queue)).toEqual({
      active: 0,
      completed: 1,
      failed: 0,
      delayed: 0,
      waiting: 0,
      paused: 0,
    });
    expect(await fixture.store.hasUnfinishedWork(fixture.claim.queue)).toBe(false);
    expect(await facade.searchJobs(QueueName.VideoConversion, { status: [QueueJobStatus.Failed] })).toEqual([]);
    expect(await facade.searchJobs(QueueName.VideoConversion, { status: [QueueJobStatus.Complete] })).toEqual([
      expect.objectContaining({ id: retry.id, attemptsMade: 1 }),
    ]);
    expect((await sql`select state,attempt from job where id = ${fixture.claim.id}::uuid`.execute(db)).rows).toEqual([
      { state: 'needs_attention', attempt: 1 },
    ]);
    expect(
      (await sql`select outcome from job_attempt where "jobId" = ${fixture.claim.id}::uuid
        and token = ${fixture.claim.token}::uuid`.execute(db)).rows,
    ).toEqual([{ outcome: 'needs_attention' }]);
    expect(
      (await sql`select count(*)::int count from job_run_item where "jobId"=any(${[fixture.claim.id, retry.id]}::uuid[])`
        .execute(db)).rows,
    ).toEqual([{ count: 0 }]);
    expect(await fixture.store.fail(fixture.claim, 'stale failure')).toBe(false);
  });

  it('requires matching stopped proof and rolls back owner failure together with the queue outcome', async () => {
    const fixture = await prepare();
    const changed = vi.fn();
    fixture.operations.onChange(changed);
    const settlements = fixture.context.failureSettlements!;
    const fail = () =>
      fixture.store.fail(fixture.claim, 'Publication lease expired before commit', undefined, { settlements });
    expect(settlements).toHaveLength(1);
    expect(await fail()).toBe(false);
    await recordStoppedAttempt(db, randomUUID(), fixture.claim.token);
    expect(await fail()).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(await fixture.operations.getForWorker(fixture.operation.id)).toMatchObject({
      status: MediaOperationStatus.Validating,
      claimToken: fixture.run!.claimToken,
      autoRetries: 0,
    });
    await sql`delete from system_metadata where key = ${ATTEMPT_EVIDENCE_PREFIX + fixture.claim.token}`.execute(db);
    await recordStoppedAttempt(db, fixture.claim.id, fixture.claim.token);
    settlements.push(async (tx) => {
      expect(changed).not.toHaveBeenCalled();
      await sql`select 1 / 0`.execute(tx);
    });
    await expect(fail()).rejects.toThrow('division by zero');
    expect(changed).not.toHaveBeenCalled();
    expect(fixture.run!.done).toBe(false);
    expect(await fixture.operations.getForWorker(fixture.operation.id)).toMatchObject({
      status: MediaOperationStatus.Validating,
      claimToken: fixture.run!.claimToken,
      autoRetries: 0,
    });
    expect((await sql`select state,token from job where id = ${fixture.claim.id}::uuid`.execute(db)).rows).toEqual([
      { state: 'active', token: fixture.claim.token },
    ]);
    settlements.pop();
    expect(await fail()).toBe(true);
    // Direct store callers have no observer delivery owner. A durable refresh supplies the outcome.
    expect(changed).not.toHaveBeenCalled();
    expect(await fixture.operations.getForWorker(fixture.operation.id)).toMatchObject({
      status: MediaOperationStatus.Queued,
      claimToken: null,
      autoRetries: 1,
      attempt: 1,
    });
    expect(await fail()).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect((await fixture.operations.getForWorker(fixture.operation.id))?.autoRetries).toBe(1);
    expect(await fixture.files()).toEqual([{ path: fixture.result('previous').files[0].path }]);
  });

  it.each(['expired operation', 'expired queue', 'superseded version'] as const)(
    'preserves every prior reference when publication meets an %s',
    async (fault) => {
      const fixture = await prepare();
      switch (fault) {
        case 'expired operation': {
          await sql`update media_operation set "claimExpiresAt" = now() - interval '1 second'
        where id = ${fixture.operation.id}::uuid`.execute(db);
          break;
        }
        case 'expired queue': {
          await sql`update job set "leaseExpiresAt" = now() - interval '1 second'
        where id = ${fixture.claim.id}::uuid`.execute(db);
          break;
        }
        case 'superseded version': {
          await fixture.edits.replaceAll(fixture.asset.id, []);
          // No default
          break;
        }
      }
      if (fault === 'expired queue') expect(await fixture.commit()).toBe(false);
      else
        await expect(fixture.commit()).rejects.toThrow(
          fault === 'expired operation' ? 'lost its claim' : 'changed before publication',
        );
      expect(await fixture.files()).toEqual([{ path: fixture.result('previous').files[0].path }]);
      expect((await fixture.edits.getVideoVersion(fixture.asset.id, fixture.candidate.id))?.masterPath).toBeNull();
      expect((await fixture.operations.getForWorker(fixture.operation.id))?.status).not.toBe(
        MediaOperationStatus.Completed,
      );
    },
  );
});
