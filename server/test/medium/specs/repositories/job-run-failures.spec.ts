import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AssetVisibility,
  JobName,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
  QueueName,
} from 'src/enum.js';
import { type RunFailureInput, failureCauseSql, runFailureCause } from 'src/queue/run-failure-cause.js';
import { reviewRunFailures } from 'src/queue/run-failures.js';
import { getRun, listRuns, runFailureGroupsQuery, summarizeRunFailures } from 'src/queue/run-query.js';
import { finishRuns } from 'src/queue/run-summary.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
let db: Kysely<any>;
beforeAll(async () => {
  database = await getKyselyDB();
  db = database as unknown as Kysely<any>;
});
beforeEach(async () => {
  await sql`truncate job_attempt, job, job_run, job_worker, job_queue, asset_processing_failure cascade`.execute(db);
  await sql`insert into job_queue(name) values ('thumbnailGeneration'), ('faceDetection')`.execute(db);
  await sql`insert into job_worker(id) values (${randomUUID()}::uuid)`.execute(db);
});

const setup = () => newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] }).ctx;

const run = async (kind = 'test') => {
  const id = randomUUID();
  await sql`insert into job_run(id, kind, selection, "enumerationDone", "createdAt")
    values (${id}::uuid, ${kind}, '{}', true, now() - interval '5 minutes')`.execute(db);
  return id;
};
const failedJob = async (
  runId: string,
  root: string,
  name: string,
  error: string | null,
  options: { state?: string; queue?: string; sensitive?: boolean; dataId?: string } = {},
) => {
  await sql`insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "runId", "itemKey",
      "rootItemKey", state, error, "finishedAt")
    values (${randomUUID()}::uuid, ${options.queue ?? 'thumbnailGeneration'}, ${name},
      ${JSON.stringify({ id: options.dataId ?? root })}::text::jsonb, true, ${options.sensitive ?? false}, 1000, ${runId}::uuid,
      ${`${root}:${name}`}, ${root}, ${options.state ?? 'failed'}, ${error},
      case when ${options.state ?? 'failed'} in ('pending','waiting','active') then null else now() end)`.execute(db);
};
const finding = async (assetId: string, category: MediaHealthCategory, evidence: object = {}, resolved = false) => {
  await sql`insert into asset_health("assetId", category, status, severity, "originalPath", "originalFileName",
      evidence, resolution, "checkedAt", "resolvedAt")
    values (${assetId}::uuid, ${category}, ${category === MediaHealthCategory.Missing ? MediaHealthStatus.Missing : MediaHealthStatus.CorruptConfirmed},
      ${MediaHealthSeverity.Critical}, '/p', 'p.jpg', ${JSON.stringify(evidence)}::text::jsonb, '{}', now(),
      case when ${resolved}::boolean then now() end)`.execute(db);
};

/** Every read of `job` in a plan: how it reads it, and the index condition it reads by. */
const jobReads = (plan: unknown) => {
  const reads: Array<{ type: string; index?: string; cond: string }> = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node['Relation Name'] === 'job' || (node['Index Name'] ?? '').startsWith('job_')) {
      reads.push({
        type: node['Node Type'],
        index: node['Index Name'],
        cond: node['Index Cond'] ?? node['Recheck Cond'] ?? '',
      });
    }
    for (const child of node.Plans ?? []) walk(child);
    if (node.Plan) walk(node.Plan);
  };
  for (const entry of plan as any[]) walk(entry);
  return reads;
};

describe('summarizeRunFailures', () => {
  it("groups 20k photos' failures from the progress index", async () => {
    const id = await run();
    // earlier nights left the same kind of failures behind: the kept history holds many more than this run
    const earlier = [await run(), await run()];
    for (const runId of [id, ...earlier]) {
      const every = runId === id ? 7 : 1;
      await sql`insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "runId", "itemKey",
          "rootItemKey", state, error)
        select gen_random_uuid(), 'thumbnailGeneration', stage, '{}', true, false, 1000, ${runId}::uuid,
          root || ':' || stage, root,
          case when n % ${every}::int = 0 and (${runId !== id}::boolean or stage = 'AssetGenerateThumbnails') then 'failed'
            else 'completed' end,
          case when n % 14 = 0 then 'VipsJpeg: premature end of JPEG image' when n % 7 = 0 then 'Timed out' end
        from generate_series(1, 20000) n, lateral (select md5(${runId}::text || n::text)::uuid::text root) r,
          unnest(array['AssetGenerateThumbnails','AssetDetectFaces','SmartSearch']) stage`.execute(db);
    }
    // and many smaller runs since: one run is a small part of the kept history, as on a real server
    await sql`with runs as (insert into job_run(id, kind, selection, "enumerationDone")
        select gen_random_uuid(), 'test', '{}', true from generate_series(1, 300) returning id)
      insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "runId", "itemKey", "rootItemKey", state)
      select gen_random_uuid(), 'thumbnailGeneration', 'AssetGenerateThumbnails', '{}', true, false, 1000, r.id,
        n::text, n::text, 'completed' from runs r, generate_series(1, 1000) n`.execute(db);
    await sql`vacuum (analyze) job`.execute(db);
    const { rows } = await sql<{
      'QUERY PLAN': unknown;
    }>`explain (format json) ${runFailureGroupsQuery(id, true)}`.execute(db);
    const reads = jobReads(rows[0]['QUERY PLAN']);
    expect(reads.map(({ type }) => type)).not.toContain('Seq Scan');
    // every index read of job is by this run: never every failed job of the server
    const indexReads = reads.filter(({ index }) => index);
    expect(indexReads.length).toBeGreaterThan(0);
    expect(indexReads).toEqual(
      indexReads.map(() =>
        expect.objectContaining({
          index: expect.stringMatching(/^job_run_(progress|stage)$/),
          cond: expect.stringContaining('"runId" ='),
        }),
      ),
    );

    // FL-1430: counting out the photos newer runs left over again probes each newer run by its own index
    const { rows: superseding } = await sql<{
      'QUERY PLAN': unknown;
    }>`explain (format json) ${runFailureGroupsQuery({ runs: [{ id, countsPhotos: true }], supersede: true })}`.execute(
      db,
    );
    // job_run itself (its primary key) is read too; what matters is how job is read
    const supersedingReads = jobReads(superseding[0]['QUERY PLAN']).filter(({ index }) => index !== 'job_run_pkey');
    expect(supersedingReads.map(({ type }) => type)).not.toContain('Seq Scan');
    expect(supersedingReads.filter(({ index }) => index)).toEqual(
      supersedingReads
        .filter(({ index }) => index)
        .map(() =>
          expect.objectContaining({
            index: expect.stringMatching(/^job_run_(progress|stage)$/),
            cond: expect.stringContaining('"runId" ='),
          }),
        ),
    );

    const groups = await summarizeRunFailures(db, id);
    // the roots are no photos here, so every one is other
    expect(groups.map(({ cause, count }) => ({ cause, count }))).toEqual([{ cause: 'other', count: 2857 }]);
    expect(groups[0]).toMatchObject({ stopped: 0, repaired: 0, queues: ['thumbnailGeneration'], libraries: [] });
  }, 120_000);

  it('a photo with two failed tasks counts once, under its most telling cause', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { asset: second } = await ctx.newAsset({ ownerId: user.id });
    const id = await run();
    await failedJob(id, asset.id, JobName.AssetGenerateThumbnails, 'Timed out');
    await failedJob(id, asset.id, JobName.AssetDetectFaces, 'unsupported image format', { queue: 'faceDetection' });
    await failedJob(id, second.id, JobName.AssetGenerateThumbnails, 'Timed out', { state: 'needs_attention' });
    await failedJob(id, randomUUID(), JobName.AssetGenerateThumbnails, null, { state: 'completed' });

    expect(await summarizeRunFailures(db, id)).toEqual([
      {
        cause: 'unsupported',
        count: 1,
        stopped: 0,
        repaired: 0,
        superseded: 0,
        queues: ['faceDetection', 'thumbnailGeneration'],
        libraries: [],
      },
      {
        cause: 'other',
        count: 1,
        stopped: 0,
        repaired: 0,
        superseded: 0,
        queues: ['thumbnailGeneration'],
        libraries: [],
      },
    ]);
    expect(await getRun(db, id)).toMatchObject({
      failed: 1,
      needsAttention: 1,
      failureCauses: [
        { cause: 'unsupported', count: 1 },
        { cause: 'other', count: 1 },
      ],
    });
  });

  it('names a drive problem by its external library, and counts repaired damaged files', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const libraryId = randomUUID();
    await sql`insert into library(id, name, "ownerId", "importPaths", "exclusionPatterns")
      values (${libraryId}::uuid, 'Holiday drive', ${user.id}::uuid, '{/mnt/a}', '{}')`.execute(db);
    const { asset: offline } = await ctx.newAsset({ ownerId: user.id, libraryId, isOffline: true });
    const { asset: gone } = await ctx.newAsset({ ownerId: user.id, libraryId });
    const { asset: damaged } = await ctx.newAsset({ ownerId: user.id });
    const { asset: lost } = await ctx.newAsset({ ownerId: user.id });
    await finding(damaged.id, MediaHealthCategory.Corrupt, { fixState: 'repaired' });
    // fixed and closed: still damaged, so "repaired N of these" counts it
    const { asset: fixed } = await ctx.newAsset({ ownerId: user.id });
    await finding(fixed.id, MediaHealthCategory.Corrupt, { fixState: 'found-again' }, true);
    await finding(lost.id, MediaHealthCategory.Missing);
    const id = await run();
    await failedJob(id, offline.id, JobName.AssetGenerateThumbnails, 'Timed out');
    await failedJob(id, gone.id, JobName.AssetGenerateThumbnails, 'ENOENT: no such file or directory');
    await failedJob(id, damaged.id, JobName.AssetGenerateThumbnails, 'Something odd');
    await failedJob(id, lost.id, JobName.AssetGenerateThumbnails, 'Something odd');
    await failedJob(id, fixed.id, JobName.AssetGenerateThumbnails, 'Something odd');
    // a root that is no photo is other, whatever its message
    await failedJob(id, 'not-a-photo', JobName.AssetGenerateThumbnails, 'ENOENT: no such file');

    expect(await summarizeRunFailures(db, id)).toEqual([
      expect.objectContaining({ cause: 'drive', count: 2, libraries: ['Holiday drive'] }),
      expect.objectContaining({ cause: 'missing', count: 1, libraries: [] }),
      expect.objectContaining({ cause: 'damaged', count: 2, repaired: 2 }),
      expect.objectContaining({ cause: 'other', count: 1, repaired: 0 }),
    ]);
  });

  it('stopped pairs are counted as stopped, not as needing a look', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { asset: partly } = await ctx.newAsset({ ownerId: user.id });
    const id = await run();
    await failedJob(id, asset.id, JobName.AssetGenerateThumbnails, 'unsupported image format');
    await failedJob(id, partly.id, JobName.AssetGenerateThumbnails, 'unsupported image format');
    await failedJob(id, partly.id, JobName.AssetDetectFaces, 'Timed out', { queue: 'faceDetection' });
    await sql`insert into asset_processing_failure("assetId", step, attempts, "lastError", "lastFailedAt", "dismissedAt")
      values (${asset.id}::uuid, ${JobName.AssetGenerateThumbnails}, 1, 'unsupported', now(), now()),
        (${partly.id}::uuid, ${JobName.AssetGenerateThumbnails}, 1, 'unsupported', now(), now())`.execute(db);

    expect(await summarizeRunFailures(db, id)).toEqual([
      expect.objectContaining({ cause: 'unsupported', count: 0, stopped: 1 }),
      // the part not stopped still needs a look, under its own cause
      expect.objectContaining({ cause: 'other', count: 1, stopped: 0 }),
    ]);
  });

  it('finishRuns stores failureCauses in the summary', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const id = await run();
    await failedJob(id, asset.id, JobName.AssetGenerateThumbnails, 'premature end of JPEG image');
    await failedJob(id, randomUUID(), JobName.AssetGenerateThumbnails, null, { state: 'completed' });
    const clean = await run();
    await failedJob(clean, randomUUID(), JobName.AssetGenerateThumbnails, null, { state: 'completed' });
    expect(await finishRuns(db, 10)).toBe(2);

    const { rows } = await sql<{ id: string; causes: unknown }>`select id, summary->'failureCauses' causes
      from job_run`.execute(db);
    expect(Object.fromEntries(rows.map((row) => [row.id, row.causes]))).toEqual({
      [id]: [{ cause: 'damaged', count: 1 }],
      [clean]: null,
    });
    // read back from the summary once history is pruned
    await sql`delete from job where "runId" = ${id}::uuid`.execute(db);
    expect(await getRun(db, id)).toMatchObject({ failureCauses: [{ cause: 'damaged', count: 1 }], leftOver: 1 });
    expect((await getRun(db, clean))?.failureCauses).toBeUndefined();
    expect((await getRun(db, clean))?.leftOver).toBeUndefined();
  });

  it("a finished run's causes follow what Library care found since, as its review does (FL-1430)", async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { asset: other } = await ctx.newAsset({ ownerId: user.id });
    const id = await run();
    await failedJob(id, asset.id, JobName.AssetExtractMetadata, 'Timed out');
    await failedJob(id, other.id, JobName.AssetExtractMetadata, 'Timed out');
    expect(await finishRuns(db, 10)).toBe(1);
    expect(await getRun(db, id)).toMatchObject({ failureCauses: [{ cause: 'other', count: 2 }], leftOver: 2 });

    await finding(asset.id, MediaHealthCategory.Corrupt);
    expect(await getRun(db, id)).toMatchObject({
      failureCauses: [
        { cause: 'damaged', count: 1 },
        { cause: 'other', count: 1 },
      ],
      leftOver: 2,
    });
    const review = (await reviewRunFailures(database, id, {}))!;
    expect(review.causes.map(({ cause, count }) => ({ cause, count }))).toEqual([
      { cause: 'damaged', count: 1 },
      { cause: 'other', count: 1 },
    ]);
  });

  it('a photo newer work left over again is counted on that work only (FL-1430)', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset: again } = await ctx.newAsset({ ownerId: user.id });
    const { asset: once } = await ctx.newAsset({ ownerId: user.id });
    const first = await run();
    await failedJob(first, again.id, JobName.AssetExtractMetadata, 'Timed out');
    await failedJob(first, once.id, JobName.AssetExtractMetadata, 'Timed out');
    const second = await run();
    await failedJob(second, again.id, JobName.AssetExtractMetadata, 'Timed out');
    const newest = await run();
    await failedJob(newest, again.id, JobName.AssetExtractMetadata, 'Timed out');
    expect(await finishRuns(db, 10)).toBe(3);

    const page = await listRuns(db, 25, 0, true);
    const card = (id: string) => page.find((read) => read.id === id)!;
    expect(card(newest)).toMatchObject({ leftOver: 1, failureCauses: [{ cause: 'other', count: 1 }] });
    expect(card(first)).toMatchObject({ leftOver: 1, failureCauses: [{ cause: 'other', count: 1 }] });
    // every photo it left over is counted on newer work: nothing needs a look here
    expect(card(second)).toMatchObject({ leftOver: 0, failureCauses: [], state: 'completed_with_errors' });

    // its review says where they went, and acting on it leaves them to the newer work
    const review = (await reviewRunFailures(database, second, {}, true))!;
    expect(review).toMatchObject({ superseded: 1, causes: [expect.objectContaining({ count: 0, superseded: 1 })] });
    expect(review.causes[0].samples).toEqual([]);
    const store = new SqlQueueStore(database);
    expect(await store.retryRunFailures(second, 'other', true)).toBe(0);
    // the run alone, as other callers read it, still has its photo
    expect(await getRun(db, second)).toMatchObject({ leftOver: 1 });
    expect((await reviewRunFailures(database, second, {}))!.causes[0]).toMatchObject({ count: 1, superseded: 0 });
  });

  it('classifies in SQL exactly as the TypeScript mirror does', async () => {
    const errors = [
      null,
      'VipsJpeg: premature end of JPEG image',
      'Input buffer contains unsupported image format',
      'Sharp child closed (code 1)',
      "ENOENT: no such file or directory, open '/a.jpg'",
      'EACCES: permission denied',
      'Original file not found',
      'VipsJpeg: Invalid SOI parameters',
      'poisoned cache',
      'APP1 segment too short',
      'no decode delegate for this image format',
      'Huffman table broken',
      'Request failed: 404 Not Found',
      'model not found',
      'File format error; File format error',
      'Entire file is binary zeros',
    ];
    const inputs: RunFailureInput[] = [];
    for (const error of errors) {
      for (const asset of [true, false]) {
        for (const external of [false, true]) {
          for (const offline of [false, true]) {
            for (const found of [null, 'missing', 'corrupt'] as const) {
              inputs.push({ asset, error, external, offline, finding: found });
            }
          }
        }
      }
    }
    for (const input of inputs) {
      const {
        rows: [row],
      } = await sql<{ cause: string }>`select ${failureCauseSql({
        asset: sql`${input.asset}::boolean`,
        error: sql`${input.error}::text`,
        external: sql`${input.external}::boolean`,
        offline: sql`${input.offline}::boolean`,
        finding: sql`${input.finding}::text`,
      })} cause`.execute(db);
      expect({ ...input, cause: row.cause }).toEqual({ ...input, cause: runFailureCause(input) });
    }
  });
});

describe('reviewing and acting on a run’s left-over photos', () => {
  const arrange = async () => {
    const ctx = setup();
    const { user: admin } = await ctx.newUser({ isAdmin: true });
    const { user: other } = await ctx.newUser({ name: 'Other person' });
    const { asset: mine } = await ctx.newAsset({ ownerId: admin.id, originalFileName: 'mine.heic' });
    const { asset: theirs } = await ctx.newAsset({ ownerId: other.id, originalFileName: 'theirs.heic' });
    const { asset: locked } = await ctx.newAsset({
      ownerId: other.id,
      originalFileName: 'locked.heic',
      visibility: AssetVisibility.Locked,
    });
    const { asset: nsfw } = await ctx.newAsset({ ownerId: other.id, originalFileName: 'nsfw.heic', is_nsfw: true });
    const id = await run();
    for (const asset of [mine, theirs, locked, nsfw]) {
      await failedJob(
        id,
        asset.id,
        JobName.AssetGenerateThumbnails,
        `unsupported image format in ${asset.originalFileName}`,
        {
          sensitive: asset.id !== locked.id && asset.id !== mine.id ? false : true,
        },
      );
    }
    return { ctx, admin, other, mine, theirs, locked, nsfw, id };
  };

  it("an admin never sees another account's Locked photo among the samples", async () => {
    const { admin, other, locked, mine, theirs, nsfw, id } = await arrange();
    const review = (await reviewRunFailures(database, id, { othersRulesViewerId: admin.id }))!;
    expect(review).toMatchObject({ photos: 4, countsPhotos: true });
    const [unsupported] = review.causes;
    // counts are the run's work and include every account's photos
    expect(unsupported).toMatchObject({ cause: 'unsupported', count: 4, stopped: 0 });
    const ids = unsupported.samples.map(({ assetId }) => assetId);
    expect(ids).not.toContain(locked.id);
    expect(ids.toSorted()).toEqual([mine.id, theirs.id, nsfw.id].toSorted());

    // hidden content of the reader's settings stays out too
    const hiding = (await reviewRunFailures(database, id, { excludeNsfw: true, othersRulesViewerId: admin.id }))!;
    expect(hiding.causes[0].samples.map(({ assetId }) => assetId)).not.toContain(nsfw.id);

    // the owner's own elevated session sees their Locked photo
    const owner = (await reviewRunFailures(database, id, { lockedOwnerId: other.id }))!;
    expect(owner.causes[0].samples.map(({ assetId }) => assetId)).toContain(locked.id);
  });

  it("another account's photo is listed without its picture", async () => {
    const { admin, other, theirs, id } = await arrange();
    const review = (await reviewRunFailures(database, id, { othersRulesViewerId: admin.id }))!;
    expect(review.causes[0].samples).toContainEqual({
      assetId: theirs.id,
      fileName: 'theirs.heic',
      ownerId: other.id,
      ownerName: 'Other person',
    });
  });

  it('no raw message from a sensitive job', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const id = await run();
    await failedJob(id, asset.id, JobName.AssetGenerateThumbnails, 'unsupported format of /private/path.heic', {
      sensitive: true,
    });
    const hidden = (await reviewRunFailures(database, id, { othersRulesViewerId: user.id }))!;
    expect(hidden.causes[0]).toMatchObject({ cause: 'unsupported', message: null });

    const shown = await arrange();
    const review = (await reviewRunFailures(database, shown.id, { othersRulesViewerId: shown.admin.id }))!;
    // only the visible photos' non-sensitive jobs can give the message: theirs or nsfw, never mine or locked
    expect(review.causes[0].message).toMatch(/unsupported image format in (theirs|nsfw)\.heic/);
    expect(await reviewRunFailures(database, randomUUID(), {})).toBeUndefined();
  });

  it('stop keeps the photo out of the next nightly selection', async () => {
    const { ctx, admin, theirs, mine, id } = await arrange();
    const { asset: fresh } = await ctx.newAsset({ ownerId: admin.id });
    // read and without previews: what the overnight thumbnail step picks
    for (const asset of [theirs, mine, fresh]) {
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newExif({ assetId: asset.id, exifImageWidth: 100 });
    }
    const store = new SqlQueueStore(database);
    expect(await store.stopRunFailures(id, 'unsupported')).toBe(4);
    expect(await store.stopRunFailures(randomUUID(), 'unsupported')).toBeUndefined();
    expect(await summarizeRunFailures(db, id)).toEqual([
      expect.objectContaining({ cause: 'unsupported', count: 0, stopped: 4 }),
    ]);
    // the job rows stay as they were: history and the per-photo list are intact
    const { rows: states } = await sql<{
      state: string;
    }>`select distinct state from job where "runId" = ${id}::uuid`.execute(db);
    expect(states).toEqual([{ state: 'failed' }]);

    const nightly = await run();
    const selection = new AssetJobRepository(database)
      .selectionForUnfinished(JobName.AssetGenerateThumbnails, {
        queue: QueueName.ThumbnailGeneration,
        fullsizeEnabled: false,
        videoPolicy: 'current-policy',
      })
      .where('asset.id', 'in', [theirs.id, mine.id, fresh.id]);
    const { inserted } = await database.transaction().execute((tx) =>
      store.insertSelectionPage(
        {
          queue: QueueName.ThumbnailGeneration,
          name: JobName.AssetGenerateThumbnails,
          data: {},
          runId: nightly,
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 1000,
        },
        selection,
        null,
        100,
        tx,
      ),
    );
    // only the photo nobody stopped is picked
    expect(inserted).toBe(1);
    const { rows: picked } = await sql<{ root: string }>`select "rootItemKey" root from job
      where "runId" = ${nightly}::uuid`.execute(db);
    expect(picked).toEqual([{ root: fresh.id }]);
  });

  it('retry re-arms quarantined photos and reopens the run', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { asset: unsupported } = await ctx.newAsset({ ownerId: user.id });
    const id = await run();
    await failedJob(id, asset.id, JobName.AssetGenerateThumbnails, 'Timed out');
    await failedJob(id, unsupported.id, JobName.AssetGenerateThumbnails, 'unsupported image format');
    await sql`insert into asset_processing_failure("assetId", step, attempts, "lastError", "lastFailedAt", "quarantinedAt")
      values (${asset.id}::uuid, ${JobName.AssetGenerateThumbnails}, 3, 'timed-out', now(), now())`.execute(db);
    expect(await finishRuns(db, 10)).toBe(1);

    const store = new SqlQueueStore(database);
    expect(await store.retryRunFailures(id, 'other')).toBe(1);
    const { rows: jobs } = await sql<{ root: string; state: string }>`select "rootItemKey" root, state from job
      where "runId" = ${id}::uuid order by state`.execute(db);
    expect(jobs).toEqual([
      { root: unsupported.id, state: 'failed' },
      { root: asset.id, state: 'pending' },
    ]);
    const { rows: failures } = await sql<{ quarantinedAt: Date | null; attempts: number }>`select "quarantinedAt",
      attempts from asset_processing_failure where "assetId" = ${asset.id}::uuid`.execute(db);
    expect(failures).toEqual([{ quarantinedAt: null, attempts: 0 }]);
    const { rows: runs } = await sql<{ finishedAt: Date | null; causes: unknown }>`select "finishedAt",
      summary->'failureCauses' causes from job_run where id = ${id}::uuid`.execute(db);
    expect(runs).toEqual([{ finishedAt: null, causes: [{ cause: 'unsupported', count: 1 }] }]);
    expect(await getRun(db, id)).toMatchObject({
      finishedAt: null,
      failureCauses: [{ cause: 'unsupported', count: 1 }],
    });
  });
});

describe('the task names the photo it works on (review)', () => {
  const motionPair = async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset: still } = await ctx.newAsset({ ownerId: user.id });
    const { asset: motion } = await ctx.newAsset({ ownerId: user.id });
    for (const asset of [still, motion]) {
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newExif({ assetId: asset.id, exifImageWidth: 100 });
    }
    return { still, motion };
  };
  const nightlyPicks = async (ids: string[]) => {
    const nightly = await run();
    const store = new SqlQueueStore(database);
    const selection = new AssetJobRepository(database)
      .selectionForUnfinished(JobName.AssetGenerateThumbnails, {
        queue: QueueName.ThumbnailGeneration,
        fullsizeEnabled: false,
        videoPolicy: 'current-policy',
      })
      .where('asset.id', 'in', ids);
    await database.transaction().execute((tx) =>
      store.insertSelectionPage(
        {
          queue: QueueName.ThumbnailGeneration,
          name: JobName.AssetGenerateThumbnails,
          data: {},
          runId: nightly,
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 1000,
        },
        selection,
        null,
        100,
        tx,
      ),
    );
    const { rows } = await sql<{ id: string }>`select data->>'id' id from job where "runId" = ${nightly}::uuid`.execute(
      db,
    );
    return rows.map(({ id }) => id);
  };

  it("stop sets aside the motion part a still's follow-up task works on", async () => {
    const { still, motion } = await motionPair();
    const id = await run();
    await failedJob(id, still.id, JobName.AssetGenerateThumbnails, 'unsupported image format', { dataId: motion.id });
    expect(await new SqlQueueStore(database).stopRunFailures(id, 'unsupported')).toBe(1);
    const { rows } = await sql<{ assetId: string }>`select "assetId" from asset_processing_failure`.execute(db);
    expect(rows).toEqual([{ assetId: motion.id }]);
    expect(await summarizeRunFailures(db, id)).toEqual([
      expect.objectContaining({ cause: 'unsupported', count: 0, stopped: 1 }),
    ]);
    expect(await nightlyPicks([still.id, motion.id])).toEqual([still.id]);
  });

  it('retry re-arms the motion part and puts back its job', async () => {
    const { still, motion } = await motionPair();
    const id = await run();
    await failedJob(id, still.id, JobName.AssetGenerateThumbnails, 'Timed out', { dataId: motion.id });
    await sql`insert into asset_processing_failure("assetId", step, attempts, "lastError", "lastFailedAt", "quarantinedAt")
      values (${motion.id}::uuid, ${JobName.AssetGenerateThumbnails}, 3, 'timed-out', now(), now()),
        (${still.id}::uuid, ${JobName.AssetGenerateThumbnails}, 3, 'timed-out', now(), now())`.execute(db);
    expect(await new SqlQueueStore(database).retryRunFailures(id, 'other')).toBe(1);
    const { rows: failures } = await sql<{ assetId: string; quarantinedAt: Date | null }>`select "assetId",
      "quarantinedAt" from asset_processing_failure order by "assetId" = ${motion.id}::uuid desc`.execute(db);
    // only the pair the job names is re-armed
    expect(failures).toEqual([
      { assetId: motion.id, quarantinedAt: null },
      { assetId: still.id, quarantinedAt: expect.any(Date) },
    ]);
    const { rows: jobs } = await sql<{ id: string; state: string }>`select data->>'id' id, state from job
      where "runId" = ${id}::uuid`.execute(db);
    expect(jobs).toEqual([{ id: motion.id, state: 'pending' }]);
  });
});

describe('left-over count (review)', () => {
  it('adds up with the causes after Stop trying, on a finished run', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const id = await run();
    await failedJob(id, asset.id, JobName.AssetGenerateThumbnails, 'unsupported image format');
    expect(await finishRuns(db, 10)).toBe(1);
    expect(await getRun(db, id)).toMatchObject({ failed: 1, leftOver: 1 });
    await new SqlQueueStore(database).stopRunFailures(id, 'unsupported');
    // the run keeps its history (one failed photo) and says nothing is left to look at
    expect(await getRun(db, id)).toMatchObject({
      state: 'completed_with_errors',
      failed: 1,
      failureCauses: [],
      leftOver: 0,
    });
  });

  it('a live run leaves out photos still being worked on', async () => {
    const id = await run();
    await failedJob(id, 'a', JobName.AssetGenerateThumbnails, null);
    await failedJob(id, 'a', JobName.AssetDetectFaces, null, { state: 'pending', queue: 'faceDetection' });
    await failedJob(id, 'b', JobName.AssetGenerateThumbnails, null);
    const live = (await getRun(db, id))!;
    expect(live).toMatchObject({ failed: 1, leftOver: 1, failureCauses: [{ cause: 'other', count: 1 }] });
    expect(live.leftOver).toBeLessThanOrEqual(live.failed + live.needsAttention);
  });
});

describe('a run that counts tasks (review)', () => {
  it('Try again now puts its failed tasks back', async () => {
    const id = await run();
    const ids: string[] = [];
    for (const error of ['Timed out', 'unsupported format']) {
      const jobId = randomUUID();
      ids.push(jobId);
      await sql`insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "runId", state, error,
          "finishedAt")
        values (${jobId}::uuid, 'thumbnailGeneration', 'Cleanup', '{}', true, false, 1000, ${id}::uuid, 'failed',
          ${error}, now())`.execute(db);
    }
    // without photos every task is other
    expect(await summarizeRunFailures(db, id, false)).toEqual([expect.objectContaining({ cause: 'other', count: 2 })]);
    expect(await new SqlQueueStore(database).retryRunFailures(id, 'other')).toBe(2);
    const { rows } = await sql<{ id: string; state: string }>`select id, state from job where "runId" = ${id}::uuid
      order by id`.execute(db);
    expect(rows).toEqual(ids.toSorted().map((jobId) => ({ id: jobId, state: 'pending' })));
  });
});
