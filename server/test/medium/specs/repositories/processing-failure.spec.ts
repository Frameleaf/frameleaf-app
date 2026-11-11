import { sql } from 'kysely';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AssetType, JobName, QueueName } from 'src/enum.js';
import { clearProcessingFailure, recordProcessingFailure } from 'src/queue/processing-failure.js';
import { SharpProcessPool } from 'src/queue/sharp-pool.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

it('sets an asset aside on its third failed attempt and leaves other assets available', async () => {
  const db = await getKyselyDB();
  onTestFinished(() => db.destroy());
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset: corrupt } = await ctx.newAsset({ ownerId: user.id });
  const { asset: healthy } = await ctx.newAsset({ ownerId: user.id });
  const store = new SqlQueueStore(db);
  const queue = QueueName.ThumbnailGeneration;
  const worker = randomUUID();
  await store.initialize([queue], worker);
  await recordProcessingFailure(
    db,
    { name: JobName.AssetGenerateThumbnails, assetId: corrupt.id },
    'Prepared output source changed',
  );
  expect(await db.selectFrom('asset_processing_failure').select('assetId').execute()).toEqual([]);
  const enqueue = (id: string) =>
    store.enqueue([
      {
        queue,
        name: JobName.AssetGenerateThumbnails,
        data: { id },
        safeToRetry: true,
        sensitive: false,
        deadlineMs: 30_000,
      },
    ]);
  await enqueue(corrupt.id);
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt === 3) await enqueue(corrupt.id);
    const [claim] = await store.claim(queue, worker, 1);
    expect(claim.data.id).toBe(corrupt.id);
    expect(await store.fail(claim, 'bad data in /private/original.jpg')).toBe(true);
    await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
  }

  const { rows } = await sql`select * from asset_processing_failure where "assetId" = ${corrupt.id}::uuid`.execute(db);
  expect(rows).toEqual([
    expect.objectContaining({
      assetId: corrupt.id,
      step: JobName.AssetGenerateThumbnails,
      attempts: 3,
      lastError: 'unreadable',
      quarantinedAt: expect.any(Date),
    }),
  ]);
  expect(await enqueue(corrupt.id)).toBe(0);
  // FL-1356: a file no decoder can open is set aside on its first failure, not its third
  const unopened = { name: JobName.AssetGenerateThumbnails, assetId: healthy.id };
  expect(await recordProcessingFailure(db, unopened, 'Unsupported image: no decoder could open it')).toBe(true);
  expect(
    await sql`select attempts, "lastError" from asset_processing_failure where "assetId" = ${healthy.id}::uuid and "quarantinedAt" is not null`.execute(
      db,
    ),
  ).toMatchObject({ rows: [{ attempts: 1, lastError: 'unsupported' }] });
  await clearProcessingFailure(db, unopened.name, unopened.assetId);
  await enqueue(healthy.id);
  const [next] = await store.claim(queue, worker, 1);
  expect(next.data.id).toBe(healthy.id);
  expect(await store.complete(next, [])).toBe(true);

  const repository = ctx.get(AssetJobRepository);
  const auth = factory.auth({ user: { id: user.id, isAdmin: false } });
  const other = factory.auth({ user: { isAdmin: false } });
  const admin = factory.auth({ user: { isAdmin: true } });
  await db
    .insertInto('asset_processing_failure')
    .values({
      assetId: corrupt.id,
      step: 'UnknownLaterStep',
      attempts: 1,
      lastError: 'unreadable',
      lastFailedAt: new Date(Date.now() + 1000),
    })
    .execute();
  const query = { skip: 0, take: 1 };
  expect(await repository.getProcessingFailures(auth, query)).toMatchObject([
    { assetId: corrupt.id, cause: 'unreadable' },
  ]);
  expect(await repository.getProcessingFailures(other, { ...query, userId: user.id })).toEqual([]);
  expect(await repository.getProcessingFailures(admin, { ...query, userId: user.id })).toHaveLength(1);
  // FL-862: the count under the same rules, once per file, steps it doesn't know left out
  expect(await repository.countProcessingFailures(auth)).toEqual({ count: 1, setAside: 1 });
  expect(await repository.countProcessingFailures(other)).toEqual({ count: 0, setAside: 0 });
  expect(await repository.countProcessingFailures(admin)).toEqual({ count: 1, setAside: 1 });

  const action = { items: [{ assetId: corrupt.id, step: JobName.AssetGenerateThumbnails as const }] };
  await expect(repository.updateProcessingFailures(other, action)).rejects.toThrow('Processing failure not found');
  await repository.updateProcessingFailures(auth, action);
  expect(await repository.getProcessingFailures(auth, query)).toEqual([]);
  // FL-1409: a file kept as it is still can't be shown; the Library asks for it by step
  const thumbnails = { ...query, step: JobName.AssetGenerateThumbnails as const, includeDismissed: true };
  expect(await repository.getProcessingFailures(auth, thumbnails)).toMatchObject([{ assetId: corrupt.id }]);
  expect(await repository.getProcessingFailures(auth, { ...thumbnails, step: JobName.Ocr as const })).toEqual([]);
  expect(await repository.countProcessingFailures(auth)).toEqual({ count: 0, setAside: 0 });

  const jobs = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
  jobs['handlers'][JobName.AssetGenerateThumbnails] = { queueName: queue } as never;
  const selected = db.selectFrom('asset').select('id').where('id', '=', corrupt.id);
  expect((await jobs.queueSelection(JobName.AssetGenerateThumbnails, selected)).inserted).toBe(0);
  expect(
    (await jobs.queueSelection(JobName.AssetGenerateThumbnails, selected, { includeSetAside: true })).inserted,
  ).toBe(1);
  const [forced] = await store.claim(queue, worker, 1);
  expect(forced.data.id).toBe(corrupt.id);
  expect(await store.fail(forced, 'unsupported format')).toBe(true);
  expect(await repository.getProcessingFailures(auth, query)).toMatchObject([{ assetId: corrupt.id, attempts: 4 }]);

  const retry = () =>
    repository.updateProcessingFailures(auth, action, {
      queueName: (name) => jobs.getQueueName(name),
      enqueue: (tx, name, id) => jobs.queueInTransaction(tx, { name, data: { id } }),
    });
  await Promise.all([retry(), retry()]);
  const [claim] = await store.claim(queue, worker, 1);
  expect(claim.data.id).toBe(corrupt.id);
  expect(await store.complete(claim, [])).toBe(true);
  expect(await store.claim(queue, worker, 1)).toEqual([]);
  expect(await repository.getProcessingFailures(auth, query)).toEqual([]);
  await enqueue(healthy.id);
  const [stopping] = await store.claim(queue, worker, 1);
  expect(await store.fail(stopping, 'Worker stopped', undefined, { interrupted: true })).toBe(true);
  expect(await repository.getProcessingFailures(auth, query)).toEqual([]);
  expect(await db.selectFrom('asset').select('originalPath').where('id', '=', corrupt.id).executeTakeFirst()).toEqual({
    originalPath: corrupt.originalPath,
  });
});

it('retries an item even when a concurrent claim is about to block its pending job', async () => {
  const db = await getKyselyDB();
  onTestFinished(() => db.destroy());
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const queue = QueueName.ThumbnailGeneration;
  const step = JobName.AssetGenerateThumbnails;
  const worker = randomUUID();
  const store = new SqlQueueStore(db);
  const jobs = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
  jobs['handlers'][step] = { queueName: queue } as never;
  await store.initialize([queue], worker);
  await jobs.queue({ name: step, data: { id: asset.id } });
  const pending = await db.selectFrom('job').select('id').where('queue', '=', queue).executeTakeFirstOrThrow();
  await db
    .insertInto('asset_processing_failure')
    .values({
      assetId: asset.id,
      step,
      attempts: 3,
      lastError: 'unreadable',
      lastFailedAt: new Date(),
      quarantinedAt: new Date(),
    })
    .execute();

  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const claim = db.transaction().execute(async (tx) => {
    await tx.selectFrom('job_queue').select('name').where('name', '=', queue).forNoKeyUpdate().execute();
    await tx
      .updateTable('job')
      .set({ state: 'blocked', finishedAt: new Date(), error: 'Processing set aside' })
      .where('id', '=', pending.id)
      .execute();
    blocked.resolve();
    await release.promise;
  });
  await Promise.race([blocked.promise, claim]);
  const auth = factory.auth({ user: { id: user.id, isAdmin: false } });
  const retry = ctx.get(AssetJobRepository).updateProcessingFailures(
    auth,
    { items: [{ assetId: asset.id, step }] },
    {
      queueName: (name) => jobs.getQueueName(name),
      enqueue: (tx, name, id) => jobs.queueInTransaction(tx, { name, data: { id } }),
    },
  );
  try {
    await vi.waitFor(async () => {
      const {
        rows: [wait],
      } = await sql<{ waiting: boolean }>`select exists (
        select 1 from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
        and wait_event_type = 'Lock' and query like 'select "name" from "job_queue" %for no key update'
      ) as waiting`.execute(db);
      expect(wait.waiting).toBe(true);
    });
  } finally {
    release.resolve();
    await Promise.all([claim, retry]);
  }

  const [replacement] = await store.claim(queue, worker, 1);
  expect(replacement).toMatchObject({ data: { id: asset.id } });
  expect(replacement.id).not.toBe(pending.id);
  expect(await store.complete(replacement, [])).toBe(true);
  expect(await store.claim(queue, worker, 1)).toEqual([]);
});

it('sets aside an item after three Sharp child crashes and decodes another file', async () => {
  const db = await getKyselyDB();
  onTestFinished(() => db.destroy());
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-sharp-crash-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const corrupt = join(directory, 'corrupt.jpg');
  const original = Buffer.from('ffd8ffe000104a464946', 'hex');
  await writeFile(corrupt, original);
  const healthy = join(directory, 'healthy.jpg');
  await sharp({ create: { width: 3, height: 2, channels: 3, background: '#abcdef' } })
    .jpeg()
    .toFile(healthy);
  const pool = new SharpProcessPool({
    workers: 1,
    createChild: () => {
      const child = fork(new URL('../../../../src/queue/sharp-worker.ts', import.meta.url), [], {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: ['--import', 'tsx'],
      });
      const send = child.send.bind(child);
      child.send = ((...args: Parameters<typeof child.send>) => {
        const message = args[0] as { args: unknown[] };
        // Inject an abrupt exit for this fixture without relying on a particular decoder vulnerability.
        return message.args[0] === corrupt ? child.kill('SIGKILL') : (Reflect.apply(send, child, args) as boolean);
      }) as typeof child.send;
      return child;
    },
  });
  onTestFinished(() => pool.close());
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: corrupt });
  const store = new SqlQueueStore(db);
  const queue = QueueName.ThumbnailGeneration;
  const step = JobName.AssetGenerateThumbnails;
  const worker = randomUUID();
  await store.initialize([queue], worker);
  const enqueue = () =>
    store.enqueue([
      { queue, name: step, data: { id: asset.id }, safeToRetry: true, sensitive: false, deadlineMs: 30_000 },
    ]);
  await enqueue();
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt === 3) await enqueue();
    const [claim] = await store.claim(queue, worker, 1);
    const error: unknown = await pool.run('getImageMetadata', [corrupt]).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Sharp child closed (SIGKILL)');
    expect(await store.fail(claim, (error as Error).message)).toBe(true);
    await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
  }
  expect(
    await db.selectFrom('asset_processing_failure').selectAll().where('assetId', '=', asset.id).executeTakeFirst(),
  ).toMatchObject({ attempts: 3, lastError: 'crashed', quarantinedAt: expect.any(Date) });
  expect(await enqueue()).toBe(0);
  await expect(pool.run('getImageMetadata', [healthy])).resolves.toMatchObject({ width: 3, height: 2 });
  expect(await readFile(corrupt)).toEqual(original);
}, 20_000);

it('records real decoder failures and an expired worker claim without changing either original', async () => {
  const db = await getKyselyDB();
  onTestFinished(() => db.destroy());
  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-processing-failure-'));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const media = new MediaRepository(LoggingRepository.create());
  const image = Buffer.from('ffd8ffe000104a464946', 'hex');
  const video = Buffer.from('000000206674797069736f6d', 'hex');
  const imagePath = join(folder, 'corrupt.jpg');
  const videoPath = join(folder, 'truncated.mp4');
  await writeFile(imagePath, image);
  await writeFile(videoPath, video);
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset: photo } = await ctx.newAsset({ ownerId: user.id, originalPath: imagePath });
  const { asset: clip } = await ctx.newAsset({ ownerId: user.id, originalPath: videoPath, type: AssetType.Video });
  const store = new SqlQueueStore(db);
  const worker = randomUUID();
  await store.initialize([QueueName.ThumbnailGeneration, QueueName.VideoConversion], worker);
  const cases = [
    {
      id: photo.id,
      queue: QueueName.ThumbnailGeneration,
      step: JobName.AssetGenerateThumbnails,
      decode: () => media.getImageMetadata(imagePath),
    },
    {
      id: clip.id,
      queue: QueueName.VideoConversion,
      step: JobName.AssetEncodeVideo,
      decode: () => media.probe(videoPath),
    },
  ];
  for (const { id, queue, step, decode } of cases) {
    await store.enqueue([{ queue, name: step, data: { id }, safeToRetry: true, sensitive: false, deadlineMs: 30_000 }]);
    let [claim] = await store.claim(queue, worker, 1);
    const error: unknown = await decode().catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(Error);
    expect(await store.fail(claim, (error as Error).message)).toBe(true);
    await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
    [claim] = await store.claim(queue, worker, 1);
    await sql`update job set "leaseExpiresAt" = now() - interval '1 minute' where id = ${claim.id}::uuid`.execute(db);
    await store.recoverExpired();
    const status = await db
      .selectFrom('asset_processing_failure')
      .selectAll()
      .where('assetId', '=', id)
      .where('step', '=', step)
      .executeTakeFirst();
    expect(status).toMatchObject({ attempts: 2, lastError: 'crashed', quarantinedAt: null });
  }
  expect(await readFile(imagePath)).toEqual(image);
  expect(await readFile(videoPath)).toEqual(video);
}, 20_000);

it('Retry puts set-aside work back whatever set it aside, and re-arms it', async () => {
  const db = await getKyselyDB();
  onTestFinished(() => db.destroy());
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset: unsupported } = await ctx.newAsset({ ownerId: user.id });
  const { asset: stopped } = await ctx.newAsset({ ownerId: user.id });
  const store = new SqlQueueStore(db);
  const queue = QueueName.ThumbnailGeneration;
  const step = JobName.AssetGenerateThumbnails;
  const worker = randomUUID();
  await store.initialize([queue], worker);
  const enqueue = (id: string) =>
    store.enqueue([{ queue, name: step, data: { id }, safeToRetry: true, sensitive: false, deadlineMs: 30_000 }]);
  await enqueue(unsupported.id);
  await enqueue(stopped.id);
  // a file type no decoder opened then is set aside at once; the other was queued again, then set aside before its turn
  const [first] = await store.claim(queue, worker, 1);
  expect(first.data.id).toBe(unsupported.id);
  expect(await store.fail(first, 'Unsupported image: no decoder could open it')).toBe(true);
  await db
    .insertInto('asset_processing_failure')
    .values({
      assetId: stopped.id,
      step,
      attempts: 1,
      lastError: 'unreadable',
      lastFailedAt: new Date(),
      dismissedAt: new Date(),
    })
    .execute();
  expect(await store.claim(queue, worker, 1)).toEqual([]);
  const { rows: before } = await sql<{ id: string; state: string; error: string }>`select data->>'id' id, state, error
    from job where queue = ${queue} order by state`.execute(db);
  expect(before).toEqual([
    { id: stopped.id, state: 'blocked', error: 'Processing set aside' },
    { id: unsupported.id, state: 'failed', error: 'Unsupported image: no decoder could open it' },
  ]);

  expect(await store.retryFailed(queue)).toBe(2);
  expect(
    await db.selectFrom('asset_processing_failure').select(['attempts', 'quarantinedAt', 'dismissedAt']).execute(),
  ).toEqual([
    { attempts: 0, quarantinedAt: null, dismissedAt: null },
    { attempts: 0, quarantinedAt: null, dismissedAt: null },
  ]);
  await sql`update job set "availableAt" = now() where queue = ${queue}`.execute(db);
  const ran: unknown[] = [];
  for (let next = await store.claim(queue, worker, 1); next.length > 0; next = await store.claim(queue, worker, 1)) {
    ran.push(next[0].data.id);
    expect(await store.complete(next[0], [])).toBe(true);
  }
  expect(new Set(ran)).toEqual(new Set([unsupported.id, stopped.id]));
  expect(ran).toHaveLength(2);
});
