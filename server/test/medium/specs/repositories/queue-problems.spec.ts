import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AssetType,
  AssetVisibility,
  JobName,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
  QueueName,
} from 'src/enum.js';
import { listQueueProblems, queueHolds, queueProblemJobs } from 'src/queue/queue-problems.js';
import {
  type QueueProblemInput,
  problemRank,
  queueProblemCause,
  queueProblemRank,
} from 'src/queue/run-failure-cause.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-1486: Background work › Advanced: failures by what went wrong across every task, and why a task is not running. */
let database: Kysely<DB>;
let db: Kysely<any>;
beforeAll(async () => {
  database = await getKyselyDB();
  db = database as unknown as Kysely<any>;
});
beforeEach(async () => {
  await sql`truncate job_attempt, job, job_run, job_worker, job_queue, asset_processing_failure cascade`.execute(db);
  await sql`insert into job_queue(name) values ('thumbnailGeneration'), ('faceDetection'), ('videoConversion'),
    ('backupDatabase'), ('smartSearch'), ('storageTemplateMigration'), ('metadataExtraction')`.execute(db);
});

const setup = () => newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] }).ctx;

const ML =
  "Machine learning request '{}' to http://frameleaf-machine-learning:3003 failed with status 503: Service Unavailable";
const DEADLINE = 'Job deadline or cancellation requested';

type JobOptions = {
  state?: string;
  sensitive?: boolean;
  cancelReason?: string;
  parentId?: string;
  root?: string | null;
};
const job = async (
  queue: string,
  name: string,
  root: string | null,
  error: string | null,
  options: JobOptions = {},
) => {
  const id = randomUUID();
  const state = options.state ?? 'failed';
  await sql`insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "rootItemKey", state, error,
      "cancelReason", "parentId", token, "finishedAt")
    values (${id}::uuid, ${queue}, ${name}, ${JSON.stringify(root ? { id: root } : {})}::text::jsonb, true,
      ${options.sensitive ?? false}, 1000, ${root}, ${state}, ${error}, ${options.cancelReason ?? null},
      ${options.parentId ?? null}::uuid, case when ${state} = 'active' then gen_random_uuid() end,
      case when ${state} in ('pending','waiting','active') then null else now() end)`.execute(db);
  return id;
};
const finding = async (assetId: string, category: MediaHealthCategory) => {
  await sql`insert into asset_health("assetId", category, status, severity, "originalPath", "originalFileName",
      evidence, resolution, "checkedAt")
    values (${assetId}::uuid, ${category}, ${category === MediaHealthCategory.Missing ? MediaHealthStatus.Missing : MediaHealthStatus.CorruptConfirmed},
      ${MediaHealthSeverity.Critical}, '/p', 'p.jpg', '{}', '{}', now())`.execute(db);
};

describe('listQueueProblems', () => {
  it('groups failures of every task by what went wrong, most photos first', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const photos = await Promise.all(
      [1, 2, 3].map(() => ctx.newAsset({ ownerId: user.id }).then(({ asset }) => asset)),
    );
    const { asset: video } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
    const { asset: gone } = await ctx.newAsset({ ownerId: user.id });
    await finding(gone.id, MediaHealthCategory.Missing);

    // the helper did not answer: three photos, in two tasks; one photo failed in both and counts once
    for (const photo of photos) await job('faceDetection', JobName.AssetDetectFaces, photo.id, ML);
    await job('smartSearch', JobName.SmartSearch, photos[0].id, ML);
    // a video ran past its deadline
    await job('videoConversion', JobName.AssetEncodeVideo, video.id, DEADLINE, { cancelReason: 'deadline' });
    // a missing file: the helper's message on it does not make it the helper's problem
    await job('thumbnailGeneration', JobName.AssetGenerateThumbnails, gone.id, 'ENOENT: no such file or directory');
    await job('faceDetection', JobName.AssetDetectFaces, gone.id, null);
    // work that is no photo's
    await job('backupDatabase', JobName.DatabaseBackup, null, 'duplicate key value violates unique constraint "x"');
    // finished and waiting work is not a problem
    await job('thumbnailGeneration', JobName.AssetGenerateThumbnails, photos[1].id, null, { state: 'completed' });

    expect(await listQueueProblems(database, {})).toEqual([
      { cause: 'mlUnavailable', count: 3, unit: 'photos', queues: ['faceDetection', 'smartSearch'], message: ML },
      {
        cause: 'missing',
        count: 1,
        unit: 'photos',
        // both of its failed tasks are the missing file's
        queues: ['faceDetection', 'thumbnailGeneration'],
        message: 'ENOENT: no such file or directory',
      },
      { cause: 'tooLong', count: 1, unit: 'videos', queues: ['videoConversion'], message: DEADLINE },
      {
        cause: 'other',
        count: 1,
        unit: 'jobs',
        queues: ['backupDatabase'],
        message: 'duplicate key value violates unique constraint "x"',
      },
    ]);
  });

  it('counts a refused write apart from other failures', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const message = "EACCES: permission denied, mkdir '/library/library/admin/2019'";
    await job('storageTemplateMigration', JobName.StorageTemplateMigrationSingle, asset.id, message);
    expect(await listQueueProblems(database, {})).toEqual([
      { cause: 'writeDenied', count: 1, unit: 'photos', queues: ['storageTemplateMigration'], message },
    ]);
  });

  it('leaves out what was stopped', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { asset: stopped } = await ctx.newAsset({ ownerId: user.id });
    for (const { id } of [asset, stopped]) {
      await job(
        'thumbnailGeneration',
        JobName.AssetGenerateThumbnails,
        id,
        'Input file contains unsupported image format',
      );
    }
    await sql`insert into asset_processing_failure("assetId", step, attempts, "lastError", "lastFailedAt", "dismissedAt")
      values (${stopped.id}::uuid, ${JobName.AssetGenerateThumbnails}, 1, 'unsupported', now(), now())`.execute(db);
    expect(await listQueueProblems(database, {})).toMatchObject([{ cause: 'unsupported', count: 1 }]);
  });

  it("never quotes a message from another account's Locked photo, a hidden one or a sensitive job", async () => {
    const ctx = setup();
    const { user: admin } = await ctx.newUser({ isAdmin: true });
    const { user: other } = await ctx.newUser();
    const { asset: locked } = await ctx.newAsset({ ownerId: other.id, visibility: AssetVisibility.Locked });
    const { asset: nsfw } = await ctx.newAsset({ ownerId: other.id, is_nsfw: true });
    const { asset: mine } = await ctx.newAsset({ ownerId: admin.id });
    await job('thumbnailGeneration', JobName.AssetGenerateThumbnails, locked.id, 'unsupported format: /locked.heic');
    await job('thumbnailGeneration', JobName.AssetGenerateThumbnails, mine.id, 'unsupported format: /sensitive.heic', {
      sensitive: true,
    });
    const privacy = { othersRulesViewerId: admin.id, excludeNsfw: true };
    // counted, but nothing may speak for it
    expect(await listQueueProblems(database, privacy)).toEqual([
      { cause: 'unsupported', count: 2, unit: 'photos', queues: ['thumbnailGeneration'], message: null },
    ]);

    // the owner's own elevated session may read their Locked photo's message
    expect((await listQueueProblems(database, { lockedOwnerId: other.id }))[0].message).toBe(
      'unsupported format: /locked.heic',
    );

    await job('thumbnailGeneration', JobName.AssetGenerateThumbnails, nsfw.id, 'unsupported format: /nsfw.heic');
    expect((await listQueueProblems(database, privacy))[0]).toMatchObject({ count: 3, message: null });
  });

  it('counts with the same rule the code names causes with', async () => {
    const inputs: QueueProblemInput[] = [];
    for (const error of [ML, DEADLINE, "EACCES: permission denied, mkdir '/a'", 'premature end', 'ENOENT', 'x', null]) {
      for (const asset of [true, false]) {
        for (const deadline of [true, false]) {
          for (const finding of [null, 'missing', 'corrupt'] as const) {
            for (const [external, offline] of [
              [false, false],
              [true, false],
              [true, true],
            ]) {
              inputs.push({ asset, error, external, offline, finding, deadline });
            }
          }
        }
      }
    }
    for (const input of inputs) {
      const {
        rows: [row],
      } = await sql<{ rank: number }>`select ${queueProblemRank({
        asset: sql`${input.asset}::boolean`,
        error: sql`${input.error}::text`,
        external: sql`${input.external}::boolean`,
        offline: sql`${input.offline}::boolean`,
        finding: sql`${input.finding}::text`,
        deadline: sql`${input.deadline}::boolean`,
      })} rank`.execute(db);
      expect({ ...input, rank: row.rank }).toEqual({ ...input, rank: problemRank(queueProblemCause(input)) });
    }
  });
});

describe('acting on a problem', () => {
  const repository = () => new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);

  it('Try again puts back the failed jobs with that problem, in every task, and no others', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { asset: second } = await ctx.newAsset({ ownerId: user.id });
    const faces = await job('faceDetection', JobName.AssetDetectFaces, asset.id, ML);
    const search = await job('smartSearch', JobName.SmartSearch, second.id, ML);
    const { asset: third } = await ctx.newAsset({ ownerId: user.id });
    const damaged = await job('thumbnailGeneration', JobName.AssetGenerateThumbnails, third.id, 'premature end');

    expect(await repository().actOnQueueProblem('mlUnavailable', 'retry')).toBe(2);
    const { rows } = await sql<{ id: string; state: string }>`select id, state from job`.execute(db);
    expect(Object.fromEntries(rows.map(({ id, state }) => [id, state]))).toEqual({
      [faces]: 'pending',
      [search]: 'pending',
      [damaged]: 'failed',
    });
    expect(await listQueueProblems(database, {})).toMatchObject([{ cause: 'damaged', count: 1 }]);
  });

  it('Stop trying leaves the jobs failed and the photos out of the count', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const id = await job('thumbnailGeneration', JobName.AssetGenerateThumbnails, asset.id, 'unsupported image format');

    expect(await queueProblemJobs(database, 'unsupported')).toEqual([
      { queue: 'thumbnailGeneration', ids: [id], roots: 1 },
    ]);
    expect(await repository().actOnQueueProblem('unsupported', 'stop')).toBe(1);
    expect(await listQueueProblems(database, {})).toEqual([]);
    const { rows } = await sql<{ state: string }>`select state from job where id = ${id}::uuid`.execute(db);
    expect(rows[0].state).toBe('failed');
  });
});

describe('queueHolds', () => {
  const holdOf = async (name: string) => (await queueHolds(database)).find((hold) => hold.name === name);

  it('tells a pause from quiet hours', async () => {
    const store = new SqlQueueStore(db);
    await store.pause('faceDetection', true);
    const until = new Date(Date.now() + 3_600_000);
    await store.setSchedule('smartSearch', until);
    await store.setSchedule('videoConversion', new Date(Date.now() - 1000));

    expect(await holdOf('faceDetection')).toEqual({
      name: 'faceDetection',
      paused: true,
      closedUntil: null,
      waitingFor: null,
    });
    expect(await holdOf('smartSearch')).toMatchObject({ paused: false, closedUntil: until, waitingFor: null });
    // quiet hours that are over hold nothing
    expect(await holdOf('videoConversion')).toMatchObject({ paused: false, closedUntil: null });
  });

  it('names the task whose jobs a task waits for', async () => {
    const parent = await job('metadataExtraction', JobName.AssetExtractMetadata, 'a', null, { state: 'active' });
    await job('storageTemplateMigration', JobName.StorageTemplateMigrationSingle, 'a', null, {
      state: 'pending',
      parentId: parent,
    });
    expect(await holdOf('storageTemplateMigration')).toMatchObject({ waitingFor: 'metadataExtraction' });

    // a job of its own that can run now: it is next in line, not waiting for anything
    await job('storageTemplateMigration', JobName.StorageTemplateMigrationSingle, 'b', null, { state: 'pending' });
    expect(await holdOf('storageTemplateMigration')).toMatchObject({ waitingFor: null });
    expect(await holdOf('metadataExtraction')).toMatchObject({ waitingFor: null });
  });

  it('lists a job quiet hours hold as scheduled, and one somebody paused as paused', async () => {
    const jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    await new SqlQueueStore(db).setSchedule('smartSearch', new Date(Date.now() + 3_600_000));
    await new SqlQueueStore(db).pause('faceDetection', true);
    await job('smartSearch', JobName.SmartSearch, 'a', null, { state: 'pending' });
    await job('faceDetection', JobName.AssetDetectFaces, 'a', null, { state: 'pending' });

    expect((await jobs.searchJobs(QueueName.SmartSearch, {})).map(({ status }) => status)).toEqual(['delayed']);
    expect((await jobs.searchJobs(QueueName.FaceDetection, {})).map(({ status }) => status)).toEqual(['paused']);
  });
});
