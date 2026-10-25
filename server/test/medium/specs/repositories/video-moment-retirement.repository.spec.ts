import { Kysely, type Transaction, sql } from 'kysely';
import { AssetFileType, AssetType, JobName, QueueName, VideoMomentSource } from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { VideoMomentRepository } from 'src/repositories/video-moment.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { readAssetSource } from 'src/utils/asset-source-authority.js';
import { bindSourceReference } from 'test/fixtures/source-reference.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db?.destroy());

async function setup(reference = false) {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
  if (reference) await bindSourceReference(db, asset);
  const source = (await readAssetSource(db, asset.id, false))!;
  await db
    .insertInto('video_moment_index')
    .values({
      assetId: asset.id,
      sourceFingerprint: 'old',
      extractorVersion: 'fixture',
      frameCount: 1,
      framesExtractedAt: new Date(),
      indexedAt: new Date(),
      captionedAt: new Date(),
      embeddingModel: 'fixture',
      captionModel: 'fixture',
      coverTimestampMs: 100,
    })
    .execute();
  const frame = await db
    .insertInto('video_moment_frame')
    .values({
      assetId: asset.id,
      frameIndex: 0,
      timestampMs: 100,
      path: `/synthetic/${asset.id}-frame.jpeg`,
      score: 1,
      rank: 1,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto('video_moment')
    .values([
      {
        assetId: asset.id,
        source: VideoMomentSource.Generated,
        frameId: frame.id,
        timestampMs: 100,
        caption: 'Generated old caption',
      },
      {
        assetId: asset.id,
        source: VideoMomentSource.Manual,
        frameId: frame.id,
        timestampMs: 100,
        caption: 'Owner title',
        transcript: 'Owner transcript',
        createdById: user.id,
      },
    ])
    .execute();
  const admit = vi.fn(async (tx: Transaction<DB>, paths: string[]) => {
    if (paths.length > 0)
      await new SqlQueueStore(tx).enqueue([
        {
          name: JobName.FileDelete,
          queue: QueueName.BackgroundTask,
          data: { files: paths },
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 60_000,
        },
      ]);
  });
  return { ctx, user, asset, source, frame, admit, sut: new VideoMomentRepository(db) };
}

it('joins a caller transaction and admits guarded deletion while retaining manual content and owned file references', async () => {
  const f = await setup();
  const { asset: saved } = await f.ctx.newAsset({ ownerId: f.user.id });
  await db
    .insertInto('asset_file')
    .values({ assetId: saved.id, type: AssetFileType.Thumbnail, path: f.frame.path })
    .execute();
  const paths = await db
    .transaction()
    .execute((tx) => new VideoMomentRepository(tx).invalidateGenerated(f.asset.id, 'new', f.source, 'old', f.admit));
  expect(paths).toEqual([f.frame.path]);
  expect(await db.selectFrom('video_moment_frame').select('id').where('assetId', '=', f.asset.id).execute()).toEqual(
    [],
  );
  expect(
    await db
      .selectFrom('video_moment')
      .select(['source', 'caption', 'transcript', 'frameId'])
      .where('assetId', '=', f.asset.id)
      .execute(),
  ).toEqual([
    { source: VideoMomentSource.Manual, caption: 'Owner title', transcript: 'Owner transcript', frameId: null },
  ]);
  expect(
    await db
      .selectFrom('video_moment_index')
      .select(['sourceFingerprint', 'frameCount', 'framesExtractedAt', 'indexedAt', 'captionedAt', 'coverTimestampMs'])
      .where('assetId', '=', f.asset.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({
    sourceFingerprint: 'new',
    frameCount: 0,
    framesExtractedAt: null,
    indexedAt: null,
    captionedAt: null,
    coverTimestampMs: 100,
  });
  expect(await db.selectFrom('asset_file').select('path').where('assetId', '=', saved.id).execute()).toEqual([
    { path: f.frame.path },
  ]);
  expect(
    await db
      .selectFrom('job')
      .select('data')
      .where('name', '=', JobName.FileDelete)
      .where(sql<boolean>`data->'files' @> ${JSON.stringify([f.frame.path])}::text::jsonb`)
      .execute(),
  ).toEqual([{ data: { files: [f.frame.path] } }]);
  const unlink = vi.fn();
  const deletion = await f.ctx.get(PhysicalFileRepository).deleteUnreferencedPath(f.frame.path, unlink);
  expect(deletion.deleted).toBe(false);
  expect(deletion.references).toBeGreaterThan(0);
  expect(unlink).not.toHaveBeenCalled();
});

it('keeps old frame rows and index state when deletion admission fails', async () => {
  const f = await setup();
  const original = f.admit.getMockImplementation()!;
  f.admit.mockImplementationOnce(async (tx, paths) => {
    await original(tx, paths);
    throw new Error('synthetic admission failure');
  });
  await expect(f.sut.invalidateGenerated(f.asset.id, 'new', f.source, 'old', f.admit)).rejects.toThrow(
    'synthetic admission failure',
  );
  expect(await db.selectFrom('video_moment_frame').select('id').where('assetId', '=', f.asset.id).execute()).toEqual([
    { id: f.frame.id },
  ]);
  expect(
    (
      await db
        .selectFrom('video_moment_index')
        .select('sourceFingerprint')
        .where('assetId', '=', f.asset.id)
        .executeTakeFirstOrThrow()
    ).sourceFingerprint,
  ).toBe('old');
  expect(await db.selectFrom('video_moment').select('id').where('assetId', '=', f.asset.id).execute()).toHaveLength(2);
  expect(
    await db
      .selectFrom('job')
      .select('id')
      .where('name', '=', JobName.FileDelete)
      .where(sql<boolean>`data->'files' @> ${JSON.stringify([f.frame.path])}::text::jsonb`)
      .execute(),
  ).toEqual([]);
});

it('refuses a changed original and does not retire a newer index on stale event replay', async () => {
  const f = await setup();
  await db
    .updateTable('asset')
    .set({ fileModifiedAt: new Date(Date.now() + 60_000) })
    .where('id', '=', f.asset.id)
    .execute();
  await expect(f.sut.invalidateGenerated(f.asset.id, 'new', f.source, 'old', f.admit)).rejects.toThrow(
    'Asset inputs changed before publication',
  );
  const current = (await readAssetSource(db, f.asset.id, false))!;
  await db
    .updateTable('video_moment_index')
    .set({ sourceFingerprint: 'newer' })
    .where('assetId', '=', f.asset.id)
    .execute();
  expect(await f.sut.invalidateGenerated(f.asset.id, 'new', current, 'old', f.admit)).toEqual([]);
  expect(f.admit).not.toHaveBeenCalled();
  expect(await db.selectFrom('video_moment_frame').select('id').where('assetId', '=', f.asset.id).execute()).toEqual([
    { id: f.frame.id },
  ]);
});

it('can retire cached reference frames after the provider session ends without acquiring original-read authority', async () => {
  const f = await setup(true);
  const {
    rows: [source],
  } = await sql<{ photoSessionId: string }>`SELECT s."photoSessionId" FROM source_original b
    JOIN photo_source_resource r ON r.id=b."resourceId" JOIN photo_source_run run ON run.id=r."runId"
    JOIN photo_source s ON s.id=run."sourceId" WHERE b."assetId"=${f.asset.id}::uuid`.execute(db);
  await db.deleteFrom('session').where('id', '=', source.photoSessionId).execute();
  expect(await f.sut.invalidateGenerated(f.asset.id, 'new', f.source, 'old', f.admit)).toEqual([f.frame.path]);
});

it('rolls retirement and deletion admission back with its caller', async () => {
  const f = await setup();
  await expect(
    db.transaction().execute(async (tx) => {
      await new VideoMomentRepository(tx).invalidateGenerated(f.asset.id, 'new', f.source, 'old', f.admit);
      throw new Error('caller rollback');
    }),
  ).rejects.toThrow('caller rollback');
  expect(await db.selectFrom('video_moment_frame').select('id').where('assetId', '=', f.asset.id).execute()).toEqual([
    { id: f.frame.id },
  ]);
  expect(
    (
      await db
        .selectFrom('video_moment_index')
        .select('sourceFingerprint')
        .where('assetId', '=', f.asset.id)
        .executeTakeFirstOrThrow()
    ).sourceFingerprint,
  ).toBe('old');
  expect(
    await db
      .selectFrom('job')
      .select('id')
      .where('name', '=', JobName.FileDelete)
      .where(sql<boolean>`data->'files' @> ${JSON.stringify([f.frame.path])}::text::jsonb`)
      .execute(),
  ).toEqual([]);
});
