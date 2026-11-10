import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, MediaHealthCategory, MediaHealthSeverity, MediaHealthStatus } from 'src/enum.js';
import { type RunFailureInput, failureCauseSql, runFailureCause } from 'src/queue/run-failure-cause.js';
import { getRun, runFailureGroupsQuery, summarizeRunFailures } from 'src/queue/run-query.js';
import { finishRuns } from 'src/queue/run-summary.js';
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
  await sql`truncate job_attempt, job, job_run, job_worker, job_queue cascade`.execute(db);
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
  options: { state?: string; queue?: string; sensitive?: boolean } = {},
) => {
  await sql`insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "runId", "itemKey",
      "rootItemKey", state, error, "finishedAt")
    values (${randomUUID()}::uuid, ${options.queue ?? 'thumbnailGeneration'}, ${name},
      ${JSON.stringify({ id: root })}::text::jsonb, true, ${options.sensitive ?? false}, 1000, ${runId}::uuid,
      ${`${root}:${name}`}, ${root}, ${options.state ?? 'failed'}, ${error},
      case when ${options.state ?? 'failed'} in ('pending','waiting','active') then null else now() end)`.execute(db);
};
const finding = async (assetId: string, category: MediaHealthCategory, evidence: object = {}) => {
  await sql`insert into asset_health("assetId", category, status, severity, "originalPath", "originalFileName",
      evidence, resolution, "checkedAt")
    values (${assetId}::uuid, ${category}, ${category === MediaHealthCategory.Missing ? MediaHealthStatus.Missing : MediaHealthStatus.CorruptConfirmed},
      ${MediaHealthSeverity.Critical}, '/p', 'p.jpg', ${JSON.stringify(evidence)}::text::jsonb, '{}', now())`.execute(
    db,
  );
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

    const groups = await summarizeRunFailures(db, id);
    expect(groups.map(({ cause, count }) => ({ cause, count }))).toEqual([
      { cause: 'damaged', count: 1428 },
      { cause: 'other', count: 1429 },
    ]);
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
        queues: ['faceDetection', 'thumbnailGeneration'],
        libraries: [],
      },
      { cause: 'other', count: 1, stopped: 0, repaired: 0, queues: ['thumbnailGeneration'], libraries: [] },
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
    await finding(lost.id, MediaHealthCategory.Missing);
    const id = await run();
    await failedJob(id, offline.id, JobName.AssetGenerateThumbnails, 'Timed out');
    await failedJob(id, gone.id, JobName.AssetGenerateThumbnails, 'ENOENT: no such file or directory');
    await failedJob(id, damaged.id, JobName.AssetGenerateThumbnails, 'Something odd');
    await failedJob(id, lost.id, JobName.AssetGenerateThumbnails, 'Something odd');

    expect(await summarizeRunFailures(db, id)).toEqual([
      expect.objectContaining({ cause: 'drive', count: 2, libraries: ['Holiday drive'] }),
      expect.objectContaining({ cause: 'missing', count: 1, libraries: [] }),
      expect.objectContaining({ cause: 'damaged', count: 1, repaired: 1 }),
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
    const id = await run();
    await failedJob(id, randomUUID(), JobName.AssetGenerateThumbnails, 'premature end of JPEG image');
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
    expect(await getRun(db, id)).toMatchObject({ failureCauses: [{ cause: 'damaged', count: 1 }] });
    expect((await getRun(db, clean))?.failureCauses).toBeUndefined();
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
    ];
    const inputs: RunFailureInput[] = [];
    for (const error of errors) {
      for (const external of [false, true]) {
        for (const offline of [false, true]) {
          for (const found of [null, 'missing', 'corrupt'] as const) {
            inputs.push({ error, external, offline, finding: found });
          }
        }
      }
    }
    for (const input of inputs) {
      const {
        rows: [row],
      } = await sql<{ cause: string }>`select ${failureCauseSql({
        error: sql`${input.error}::text`,
        external: sql`${input.external}::boolean`,
        offline: sql`${input.offline}::boolean`,
        finding: sql`${input.finding}::text`,
      })} cause`.execute(db);
      expect({ ...input, cause: row.cause }).toEqual({ ...input, cause: runFailureCause(input) });
    }
  });
});
