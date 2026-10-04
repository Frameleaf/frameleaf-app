import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { QueueClaim, QueueExecution } from 'src/queue/types.js';
import type { JobItem } from 'src/types.js';
import {
  AssetFileType,
  AssetMetadataKey,
  AssetType,
  AssetVisibility,
  JobName,
  MlDestinationKind,
  MlWorkload,
  QueueName,
} from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { freezeSelection } from 'src/queue/manifest.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { SmartAlbumService } from 'src/services/smart-album.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

// Match the immutable canonical smart_search embedding column.
const unitVector = `[${Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)).join(',')}]`;

const executionFor = (claim: QueueClaim): QueueExecution => ({
  claim,
  signal: new AbortController().signal,
  progress: vi.fn(),
  progressUnits: 0,
  adoptions: [],
  followups: [],
  buffering: false,
});

/** Real canonical baseline, queue facade/executor, manifest feeder and membership repositories. */
const durableFixture = async (db: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(SmartAlbumService, {
    database: db,
    real: [
      AssetJobRepository,
      ConfigRepository,
      SearchRepository,
      SmartAlbumRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [JobRepository, LoggingRepository, MachineLearningRepository, MlDestinationRepository],
  });
  const config = await ctx.getConfig({ withCache: false });
  config.smartAlbums.enabled = true;
  config.machineLearning.clip.enabled = false;
  await ctx.updateConfig(config);
  clearConfigCache();
  const { user } = await ctx.newUser();
  await ctx.get(SmartAlbumRepository).ensureForUser(user.id, [
    { kind: 'travel', name: 'Travel' },
    { kind: 'food', name: 'Food' },
  ]);
  const albums = await ctx.get(SmartAlbumRepository).getAllSmartAlbumIdsForOwner(user.id);
  const queue = `smart-album-${randomUUID()}`;
  let worker = randomUUID();
  let repository: JobRepository;
  let store = new SqlQueueStore(db);
  const restart = async () => {
    worker = randomUUID();
    store = new SqlQueueStore(db);
    await store.initialize([queue], worker);
    await store.setConcurrency(queue, 1);
    repository = new JobRepository(
      {} as never,
      ctx.get(ConfigRepository),
      {
        emit: async (_event: string, _queue: string, item: JobItem) => {
          await repository.run(item);
        },
      } as never,
      ctx.getMock(LoggingRepository),
      db,
    );
    repository['handlers'][JobName.SmartAlbumReevaluateAll] = {
      jobName: JobName.SmartAlbumReevaluateAll,
      queueName: queue as QueueName,
      label: 'producer',
      handler: sut.handleReevaluateAll.bind(sut),
    };
    repository['handlers'][JobName.SmartAlbumReevaluate] = {
      jobName: JobName.SmartAlbumReevaluate,
      queueName: queue as QueueName,
      label: 'item',
      handler: sut.handleReevaluate.bind(sut),
    };
    Object.assign(sut, { jobRepository: repository });
  };
  await restart();
  const selectedAsset = async (
    tags: unknown = ['beach'],
    options: { type?: AssetType; visibility?: AssetVisibility } = {},
  ) => {
    const { asset } = await ctx.newAsset({ ownerId: user.id, ...options });
    await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: `/previews/${asset.id}.jpg` });
    await ctx.newMetadata({
      assetId: asset.id,
      key: AssetMetadataKey.MlEnrichment,
      value: { description: { status: 'success', result: { tags } } },
    });
    return asset;
  };
  const start = async (kind?: 'travel' | 'food') => {
    const runId = await repository.createRun('SmartAlbumReevaluateAll', {}, () =>
      repository.queue({ name: JobName.SmartAlbumReevaluateAll, data: { ...(kind && { kind }) } }),
    );
    const [claim] = await store.claim(queue, worker);
    expect(claim.name).toBe(JobName.SmartAlbumReevaluateAll);
    await repository['execute'](claim, new AbortController());
    return runId;
  };
  const run = async (runId: string) => (await store.listRuns(100, 0)).find((row) => row.id === runId)!;
  const next = async () => {
    const claims = await store.claim(queue, worker);
    expect(claims).toHaveLength(1);
    expect(await store.claim(queue, worker)).toEqual([]); // concurrency 1 while this claim is live
    await repository['execute'](claims[0], new AbortController());
    return claims[0];
  };
  const memberships = () => db.selectFrom('smart_album_asset').selectAll().execute();
  return {
    ctx,
    sut,
    user,
    albums,
    queue,
    selectedAsset,
    start,
    run,
    next,
    restart,
    memberships,
    get store() {
      return store;
    },
    get repository() {
      return repository;
    },
    get worker() {
      return worker;
    },
  };
};

describe('durable smart-album reevaluation', () => {
  let db: Kysely<DB>;
  beforeEach(async () => {
    clearConfigCache();
    db = await getKyselyDB();
  });
  afterEach(async () => {
    clearConfigCache();
    await db.destroy();
  });

  it('freezes a large selection before execution and feeds only 250 up to the existing 1000 watermark', async () => {
    const f = await durableFixture(db);
    const assets = Array.from({ length: 1001 }, () => mediumFactory.assetInsert({ ownerId: f.user.id }));
    await db.insertInto('asset').values(assets).execute();
    await db
      .insertInto('asset_file')
      .values(assets.map(({ id }) => ({ assetId: id, type: AssetFileType.Preview, path: `/previews/${id}.jpg` })))
      .execute();
    await db
      .insertInto('asset_metadata')
      .values(
        assets.map(({ id }) => ({
          assetId: id,
          key: AssetMetadataKey.MlEnrichment,
          value: { description: { status: 'success', result: { tags: ['beach'] } } },
        })),
      )
      .execute();
    const runId = await f.start('travel');
    expect(await f.run(runId)).toMatchObject({ total: 1001, completed: 0, waiting: 1001, enumerationDone: true });
    const before = await sql<{ count: number; executions: number }>`select count(*)::int count,
      count("jobId")::int executions from job_run_item where "runId" = ${runId}::uuid and stage = ${JobName.SmartAlbumReevaluate}`.execute(
      db,
    );
    expect(before.rows[0]).toEqual({ count: 1001, executions: 0 });
    expect(await f.memberships()).toEqual([]);
    await f.selectedAsset(); // created after the snapshot; must not enter this run
    await f.restart();
    for (let batch = 0; batch < 4; batch++) expect(await f.store.feedManifest(f.queue)).toBe(250);
    expect(await f.store.feedManifest(f.queue)).toBe(0);
    expect(await f.run(runId)).toMatchObject({ total: 1001, completed: 0 });
    const after = await sql<{ count: number; executions: number }>`select count(*)::int count,
      count("jobId")::int executions from job_run_item where "runId" = ${runId}::uuid and stage = ${JobName.SmartAlbumReevaluate}`.execute(
      db,
    );
    expect(after.rows[0]).toEqual({ count: 1001, executions: 1000 });
  });

  it('accounts for one corrupt item after one safe retry while unrelated items resume at concurrency 1', async () => {
    const f = await durableFixture(db);
    const good = [await f.selectedAsset(), await f.selectedAsset()];
    const corrupt = await f.selectedAsset({ invalid: 'not an array' });
    const runId = await f.start('travel');
    const repeated = await f.start('travel');
    expect(await f.store.feedManifest(f.queue)).toBe(3);
    await f.next();
    await f.restart();
    await f.next();
    await f.next();
    for (const id of [runId, repeated])
      expect(await f.run(id)).toMatchObject({ total: 3, completed: 2, retrying: 1, failed: 0, finishedAt: null });
    expect((await f.memberships()).map((row) => row.assetId).sort()).toEqual(good.map(({ id }) => id).sort());
    await sql`update job set "availableAt" = now() where queue = ${f.queue} and data->>'id' = ${corrupt.id}`.execute(
      db,
    );
    const retry = await f.next();
    expect(retry.data.id).toBe(corrupt.id);
    expect(retry.attempt).toBe(2);
    expect(await f.store.claim(f.queue, f.worker)).toEqual([]);
    for (const id of [runId, repeated])
      expect(await f.run(id)).toMatchObject({
        total: 3,
        completed: 2,
        failed: 1,
        retrying: 0,
        state: 'completed_with_errors',
      });
    const { rows } = await sql<{
      outcome: string;
    }>`select outcome from job_attempt where "jobId" = ${retry.id}::uuid order by attempt`.execute(db);
    expect(rows.map(({ outcome }) => outcome)).toEqual(['pending', 'failed']);
  });

  it('preserves exact described/preview eligibility, includes video and locked media, and skips a deleted selected asset', async () => {
    const f = await durableFixture(db);
    const eligible = [
      await f.selectedAsset(),
      await f.selectedAsset(['beach'], { visibility: AssetVisibility.Archive }),
      await f.selectedAsset(['beach'], { type: AssetType.Video }),
      await f.selectedAsset(['beach'], { visibility: AssetVisibility.Locked }),
    ];
    const hidden = await f.selectedAsset(['beach'], { visibility: AssetVisibility.Hidden });
    const failed = await f.selectedAsset();
    await db
      .updateTable('asset_metadata')
      .set({ value: { description: { status: 'failed' } } })
      .where('assetId', '=', failed.id)
      .execute();
    const missingPreview = await f.selectedAsset();
    await db.deleteFrom('asset_file').where('assetId', '=', missingPreview.id).execute();
    const deleted = await f.selectedAsset();
    await f.ctx.softDeleteAsset(deleted.id);
    const selection = await f.ctx.get(AssetJobRepository).selectionForSmartAlbumReevaluation().execute();
    expect(selection.map(({ id }) => id).sort()).toEqual(eligible.map(({ id }) => id).sort());
    for (const id of [hidden.id, failed.id, missingPreview.id, deleted.id])
      expect(selection.map((row) => row.id)).not.toContain(id);
    const runId = await f.start('travel');
    await f.ctx.softDeleteAsset(eligible[0].id);
    expect(await f.store.feedManifest(f.queue)).toBe(4);
    for (let item = 0; item < 4; item++) await f.next();
    expect(await f.run(runId)).toMatchObject({ total: 4, completed: 4, failed: 0, state: 'completed' });
    expect((await f.memberships()).map(({ assetId }) => assetId).sort()).toEqual(
      eligible
        .slice(1)
        .map(({ id }) => id)
        .sort(),
    );
  });

  it('coalesces overlapping same-kind manifests while keeping assets, different kinds and all-kinds independent', async () => {
    const f = await durableFixture(db);
    const first = await f.selectedAsset(['beach', 'food']);
    const second = await f.selectedAsset(['beach', 'food']);
    const travel = await f.start('travel');
    const repeatedTravel = await f.start('travel'); // first producer completed; its selected work is still live
    const food = await f.start('food');
    const all = await f.start();
    expect(await f.store.feedManifest(f.queue)).toBe(6); // eight ledger items share six execution slots
    for (const id of [first.id, second.id]) {
      await f.repository.queue({ name: JobName.SmartAlbumReevaluate, data: { id, kind: 'travel' } });
      await f.repository.queue({ name: JobName.SmartAlbumReevaluate, data: { id, kind: 'food' } });
      await f.repository.queue({ name: JobName.SmartAlbumReevaluate, data: { id } });
    }
    const { rows } = await sql<{ key: string; safe: boolean }>`select "dedupKey" key, "safeToRetry" safe
      from job where queue = ${f.queue} and state = 'pending'`.execute(db);
    expect(rows).toHaveLength(6);
    expect(rows.every(({ safe }) => safe)).toBe(true);
    expect(rows.map(({ key }) => key).sort()).toEqual(
      [first.id, second.id]
        .flatMap((id) => ['travel', 'food', 'all'].map((kind) => `${JobName.SmartAlbumReevaluate}:${id}:${kind}`))
        .sort(),
    );
    const memberships = await sql<{ runId: string; itemKey: string; jobId: string }>`select "runId", "itemKey", "jobId"
      from job_run_item where "runId" = any(${[travel, repeatedTravel]}::uuid[]) and stage = ${JobName.SmartAlbumReevaluate}`.execute(
      db,
    );
    expect(memberships.rows).toHaveLength(4);
    for (const id of [first.id, second.id]) {
      const aliases = memberships.rows.filter((row) => row.itemKey === id);
      expect(aliases).toHaveLength(2);
      expect(new Set(aliases.map((row) => row.jobId)).size).toBe(1);
      expect(aliases[0].jobId).not.toBeNull();
    }
    await f.restart();
    for (let item = 0; item < 6; item++) await f.next();
    expect(await f.store.claim(f.queue, f.worker)).toEqual([]);
    for (const runId of [travel, repeatedTravel, food, all]) {
      expect(await f.run(runId)).toMatchObject({
        total: 2,
        completed: 2,
        failed: 0,
        state: 'completed',
        enumerationDone: true,
      });
      const {
        rows: [settled],
      } = await sql<{ finished: boolean; pending: number }>`select r."finishedAt" is not null finished,
        count(*) filter (where i.state in ('pending','waiting','active'))::int pending
        from job_run r join job_run_item i on i."runId" = r.id where r.id = ${runId}::uuid group by r.id`.execute(db);
      expect(settled).toEqual({ finished: true, pending: 0 });
    }
    const {
      rows: [attempts],
    } = await sql<{ count: number }>`select count(*)::int count from job_attempt a
      join job j on j.id = a."jobId" where j.queue = ${f.queue} and j.name = ${JobName.SmartAlbumReevaluate}`.execute(
      db,
    );
    expect(attempts.count).toBe(6);
    expect(
      (await f.memberships())
        .filter(({ smartAlbumId }) => [f.albums.get('travel'), f.albums.get('food')].includes(smartAlbumId))
        .map(({ smartAlbumId, assetId }) => `${smartAlbumId}/${assetId}`)
        .sort(),
    ).toEqual(
      [first.id, second.id].flatMap((id) => ['travel', 'food'].map((kind) => `${f.albums.get(kind)}/${id}`)).sort(),
    );
  });

  it('attaches a later manifest to an already-active item and settles both runs on its accepted publication', async () => {
    const f = await durableFixture(db);
    const asset = await f.selectedAsset();
    const original = await f.start('travel');
    expect(await f.store.feedManifest(f.queue)).toBe(1);
    const [claim] = await f.store.claim(f.queue, f.worker);
    expect(claim.data.id).toBe(asset.id);
    const later = await f.store.createRun('SmartAlbumReevaluateAll', {});
    await freezeSelection(
      db,
      f.repository['intent']({ name: JobName.SmartAlbumReevaluate, data: { kind: 'travel', id: asset.id } }),
      f.ctx.get(AssetJobRepository).selectionForSmartAlbumReevaluation(),
      undefined,
      later,
    );
    await f.store.finishEnumeration(later);
    expect(await f.store.feedManifest(f.queue)).toBe(0); // attaches to the live execution rather than adding another
    expect(await f.run(later)).toMatchObject({ total: 1, active: 1, completed: 0, finishedAt: null });
    const { rows: aliases } = await sql<{ jobId: string; state: string }>`select "jobId", state from job_run_item
      where "runId" = any(${[original, later]}::uuid[]) and stage = ${JobName.SmartAlbumReevaluate}`.execute(db);
    expect(aliases).toEqual([
      { jobId: claim.id, state: 'active' },
      { jobId: claim.id, state: 'active' },
    ]);
    await f.repository['execute'](claim, new AbortController());
    for (const runId of [original, later])
      expect(await f.run(runId)).toMatchObject({ total: 1, completed: 1, state: 'completed' });
    expect(await f.store.claim(f.queue, f.worker)).toEqual([]);
  });

  it.each(['cancelled', 'expired', 'tags-changed'] as const)(
    'rejects %s publication without changing membership',
    async (reason) => {
      const f = await durableFixture(db);
      const asset = await f.selectedAsset();
      await f.start('travel');
      await f.store.feedManifest(f.queue);
      const [claim] = await f.store.claim(f.queue, f.worker);
      const execution = executionFor(claim);
      await queueExecution.run(execution, () => f.sut.handleReevaluate({ id: asset.id, kind: 'travel' }));
      expect(await f.memberships()).toEqual([]);
      switch (reason) {
        case 'cancelled': {
          await sql`update job set "cancelRequestedAt" = now() where id = ${claim.id}::uuid`.execute(db);
          break;
        }
        case 'expired': {
          await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${claim.id}::uuid`.execute(
            db,
          );
          break;
        }
        case 'tags-changed': {
          await f.ctx.newMetadata({
            assetId: asset.id,
            key: AssetMetadataKey.MlEnrichment,
            value: { description: { status: 'success', result: { tags: ['changed'] } } },
          });
          // No default
          break;
        }
      }
      const acceptance = f.store.complete(claim, [], (tx) =>
        publicationTransaction.run(tx, async () => {
          for (const adopt of execution.adoptions) await adopt(tx);
        }),
      );
      if (reason === 'tags-changed') await expect(acceptance).rejects.toThrow('inputs changed before publication');
      else await expect(acceptance).resolves.toBe(false);
      expect(await f.memberships()).toEqual([]);
      expect(await db.selectFrom('album_asset').selectAll().execute()).toEqual([]);
    },
  );

  it('keeps transport refusal pinned and blocked, then unblocks the same destination without retry-budget loss', async () => {
    const f = await durableFixture(db);
    const config = await f.ctx.getConfig({ withCache: false });
    config.machineLearning.clip.enabled = true;
    await f.ctx.updateConfig(config);
    clearConfigCache();
    const asset = await f.selectedAsset();
    const vector = unitVector;
    await f.ctx.get(SearchRepository).upsert(asset.id, vector);
    const ml = f.ctx.getMock(MachineLearningRepository);
    const destinations = f.ctx.getMock(MlDestinationRepository);
    const route = await destinations.getRoute(MlWorkload.Clip);
    const original = await destinations.getById(route!.destinationId);
    ml.encodeText.mockRejectedValue(
      new Error('request failed', { cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }) }),
    );
    const runId = await f.start('travel');
    await f.store.feedManifest(f.queue);
    const claim = await f.next();
    expect(await f.run(runId)).toMatchObject({
      total: 1,
      blocked: 1,
      completed: 0,
      failed: 0,
      state: 'blocked',
      finishedAt: null,
    });
    const deferred = await sql<{ base: number; reason: string; destination: string }>`select "retryBaseAttempt" base,
      "dependencyReason" reason, data->'_queueDestinations'->>'clip' destination from job where id = ${claim.id}::uuid`.execute(
      db,
    );
    expect(deferred.rows[0]).toEqual({ base: 1, reason: 'destination-unavailable', destination: original!.id });
    destinations.getRoute.mockResolvedValue({ ...route!, destinationId: randomUUID() });
    destinations.getById.mockImplementation((id) => Promise.resolve(id === original!.id ? original : undefined));
    ml.encodeText.mockResolvedValue(vector);
    await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
    const resumed = await f.next();
    expect(resumed.id).toBe(claim.id);
    expect(ml.encodeText.mock.lastCall?.[0].destinationId).toBe(original!.id);
    expect(await f.run(runId)).toMatchObject({ total: 1, completed: 1, failed: 0, state: 'completed' });
    expect(await f.memberships()).toHaveLength(1);
  });

  it.each(['malformed', '[0,0]', '[1,0]'])(
    'records healthy malformed query result %s as failed after the single safe retry, never a dependency wait',
    async (result) => {
      const f = await durableFixture(db);
      const config = await f.ctx.getConfig({ withCache: false });
      config.machineLearning.clip.enabled = true;
      await f.ctx.updateConfig(config);
      clearConfigCache();
      const asset = await f.selectedAsset();
      await f.ctx.get(SearchRepository).upsert(asset.id, unitVector);
      f.ctx.getMock(MachineLearningRepository).encodeText.mockResolvedValue(result);
      const runId = await f.start('travel');
      await f.store.feedManifest(f.queue);
      const claim = await f.next();
      expect(await f.run(runId)).toMatchObject({ retrying: 1, blocked: 0, failed: 0 });
      await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
      await f.next();
      expect(await f.run(runId)).toMatchObject({ total: 1, failed: 1, blocked: 0, state: 'completed_with_errors' });
      expect(await f.memberships()).toEqual([]);
    },
  );

  it.each(['disabled', 'missing', 'cloud'] as const)(
    'keeps %s CLIP admission blocked without replay, fallback or membership loss',
    async (refusal) => {
      const f = await durableFixture(db);
      const asset = await f.selectedAsset();
      await f.sut.evaluate({ assetId: asset.id, ownerId: f.user.id, tags: ['beach'], onlyKind: 'travel' });
      const before = await f.memberships();
      expect(before).toHaveLength(1);
      const vector = unitVector;
      await f.ctx.get(SearchRepository).upsert(asset.id, vector);
      const config = await f.ctx.getConfig({ withCache: false });
      config.machineLearning.clip.enabled = true;
      await f.ctx.updateConfig(config);
      clearConfigCache();
      const destinations = f.ctx.getMock(MlDestinationRepository);
      const route = await destinations.getRoute(MlWorkload.Clip);
      const original = (await destinations.getById(route!.destinationId))!;
      destinations.getById.mockResolvedValue(
        refusal === 'missing'
          ? undefined
          : {
              ...original,
              ...(refusal === 'disabled' && { enabled: false }),
              ...(refusal === 'cloud' && { kind: MlDestinationKind.FrameleafCloud, url: null }),
            },
      );
      const runId = await f.start('travel');
      await f.store.feedManifest(f.queue);
      const claim = await f.next();
      expect(await f.run(runId)).toMatchObject({
        total: 1,
        blocked: 1,
        completed: 0,
        failed: 0,
        state: 'blocked',
        finishedAt: null,
      });
      expect(f.ctx.getMock(MachineLearningRepository).encodeText).not.toHaveBeenCalled();
      expect(await f.memberships()).toEqual(before);
      const { rows } = await sql<{
        destination: string;
        base: number;
      }>`select data->'_queueDestinations'->>'clip' destination,
      "retryBaseAttempt" base from job where id = ${claim.id}::uuid`.execute(db);
      expect(rows[0]).toEqual({ destination: original.id, base: 1 });
    },
  );
});
