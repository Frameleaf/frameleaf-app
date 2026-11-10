import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetType, JobName, QueueName } from 'src/enum.js';
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
    expect(await store.fail(claim, 'unsupported format in /private/original.jpg')).toBe(true);
    await sql`update job set "availableAt" = now() where id = ${claim.id}::uuid`.execute(db);
  }

  const { rows } = await sql`select * from asset_processing_failure where "assetId" = ${corrupt.id}::uuid`.execute(db);
  expect(rows).toEqual([
    expect.objectContaining({
      assetId: corrupt.id,
      step: JobName.AssetGenerateThumbnails,
      attempts: 3,
      lastError: 'unsupported',
      quarantinedAt: expect.any(Date),
    }),
  ]);
  expect(await enqueue(corrupt.id)).toBe(0);
  await enqueue(healthy.id);
  const [next] = await store.claim(queue, worker, 1);
  expect(next.data.id).toBe(healthy.id);
  expect(await store.complete(next, [])).toBe(true);

  const repository = ctx.get(AssetJobRepository);
  const auth = factory.auth({ user: { id: user.id, isAdmin: false } });
  const other = factory.auth({ user: { isAdmin: false } });
  const admin = factory.auth({ user: { isAdmin: true } });
  const query = { skip: 0, take: 20 };
  expect(await repository.getProcessingFailures(auth, query)).toMatchObject([
    { assetId: corrupt.id, cause: 'unsupported' },
  ]);
  expect(await repository.getProcessingFailures(other, { ...query, userId: user.id })).toEqual([]);
  expect(await repository.getProcessingFailures(admin, { ...query, userId: user.id })).toHaveLength(1);

  const action = { items: [{ assetId: corrupt.id, step: JobName.AssetGenerateThumbnails as const }] };
  await expect(repository.updateProcessingFailures(other, action)).rejects.toThrow('Processing failure not found');
  await repository.updateProcessingFailures(auth, action);
  expect(await repository.getProcessingFailures(auth, query)).toEqual([]);

  const jobs = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
  jobs['handlers'][JobName.AssetGenerateThumbnails] = { queueName: queue } as never;
  const retry = () =>
    repository.updateProcessingFailures(auth, action, (tx, name, id) =>
      jobs.queueInTransaction(tx, { name, data: { id } }),
    );
  await Promise.all([retry(), retry()]);
  const [claim] = await store.claim(queue, worker, 1);
  expect(claim.data.id).toBe(corrupt.id);
  expect(await store.complete(claim, [])).toBe(true);
  expect(await store.claim(queue, worker, 1)).toEqual([]);
  expect(await repository.getProcessingFailures(auth, query)).toEqual([]);
  expect(await db.selectFrom('asset').select('originalPath').where('id', '=', corrupt.id).executeTakeFirst()).toEqual({
    originalPath: corrupt.originalPath,
  });
});

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
