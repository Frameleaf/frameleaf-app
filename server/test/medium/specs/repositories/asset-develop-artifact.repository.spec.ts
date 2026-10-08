import { BadRequestException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetDevelopRepository, DEVELOP_ARTIFACT_PER_ASSET } from 'src/repositories/asset-develop.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoToolsRepository } from 'src/repositories/photo-tools.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetDevelopService } from 'src/services/asset-develop.service.js';
import { BaseService } from 'src/services/base.service.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB, getMocks } from 'test/utils.js';

/** FL-233: develop artifacts are tracked, counted and released (fork migration 0212). */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new AssetDevelopRepository(db) };
};

const sha = (character: string) => character.repeat(64);
/** The owner's storage usage as the quota checks read it. */
const usage = async (userId: string) =>
  Number(
    (
      await sql<{ bytes: string }>`SELECT "quotaUsageInBytes" AS bytes FROM "user" WHERE id = ${userId}::uuid`.execute(
        db,
      )
    ).rows[0].bytes,
  );
const stored = async (assetId: string) =>
  Number(
    (
      await sql<{ count: string }>`
        SELECT count(*) AS count FROM public.asset_develop_artifact WHERE "assetId" = ${assetId}::uuid
      `.execute(db)
    ).rows[0].count,
  );
const refusals = (results: PromiseSettledResult<boolean>[]) =>
  results.flatMap((result) => {
    if (result.status === 'fulfilled') {
      return [];
    }
    // Database/admission failures must surface themselves, never count as a quota refusal.
    if (!(result.reason instanceof BadRequestException)) {
      throw result.reason;
    }
    return [result.reason.getResponse() as { code: string }];
  });

it('installs feature tables in the real canonical baseline', async () => {
  await expectCanonicalTables(db, ['asset_develop_artifact', 'asset_develop_revision']);
});

it('records an artifact once, counts it, and releases unreferenced and removed ones', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const row = (id: string) => ({
    assetId: asset.id,
    id,
    ownerId: user.id,
    kind: 'mask' as const,
    path: `/thumbs/${asset.id}_develop_artifact_${id}.png`,
    bytes: 1000,
    width: 10,
    height: 10,
  });
  await expect(sut.addArtifact(row(sha('a')))).resolves.toBe(true);
  await expect(sut.addArtifact(row(sha('a')))).resolves.toBe(false);
  await expect(sut.addArtifact(row(sha('b')))).resolves.toBe(true);
  await expect(sut.addArtifact({ ...row('../escape'), path: '/elsewhere' })).rejects.toThrow(
    /asset_develop_artifact_id_check/,
  );
  await expect(sut.getArtifacts(asset.id, [sha('a'), sha('c')])).resolves.toEqual([
    expect.objectContaining({ id: sha('a'), bytes: 1000, kind: 'mask' }),
  ]);
  await expect(stored(asset.id)).resolves.toBe(2);
  // FL-304: each new artifact is charged to its owner once; the same one again is not
  await expect(usage(user.id)).resolves.toBe(2000);

  // a saved version references `a`; `b` is unused
  await sut.create({
    assetId: asset.id,
    ownerId: user.id,
    recipe: {
      ...defaultDevelopRecipe(),
      masks: [{ id: 's', kind: 'subject', x: 0.5, y: 0.5, artifact: sha('a') }],
    } as never,
    recipeVersion: 1,
    label: null,
    status: AssetDevelopRevisionStatus.Saved,
  });
  const queue = vi.fn().mockResolvedValue(undefined);
  // within the grace period nothing is released
  await expect(sut.releaseArtifacts(queue, { unreferencedBefore: new Date(Date.now() - 60_000) })).resolves.toEqual([]);
  await expect(sut.releaseArtifacts(queue, { unreferencedBefore: new Date(Date.now() + 60_000) })).resolves.toEqual([
    row(sha('b')).path,
  ]);
  expect(queue).toHaveBeenCalledWith([row(sha('b')).path]);
  await expect(stored(asset.id)).resolves.toBe(1);
  await expect(usage(user.id)).resolves.toBe(1000);

  // a removed photo takes its artifacts with it
  await sql`DELETE FROM public.asset WHERE id = ${asset.id}::uuid`.execute(db);
  await expect(sut.releaseArtifacts(queue, { assetId: asset.id })).resolves.toEqual([row(sha('a')).path]);
  await expect(usage(user.id)).resolves.toBe(0);
});

it('keeps a file recorded again before its queued deletion runs, and restarts the grace period on use', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const artifact = {
    assetId: asset.id,
    id: sha('e'),
    ownerId: user.id,
    kind: 'fill' as const,
    path: `/thumbs/${asset.id}_develop_artifact_${sha('e')}.png`,
    bytes: 10,
    width: 1,
    height: 1,
  };
  await sut.addArtifact(artifact);
  const age = async () =>
    (
      await sql<{
        createdAt: Date;
      }>`SELECT "createdAt" FROM public.asset_develop_artifact WHERE id = ${sha('e')}`.execute(db)
    ).rows[0]?.createdAt;
  await sql`UPDATE public.asset_develop_artifact SET "createdAt" = now() - interval '30 days' WHERE id = ${sha('e')}`.execute(
    db,
  );
  // uploading it again restarts its grace period
  await expect(sut.addArtifact(artifact)).resolves.toBe(false);
  expect((await age())!.getTime()).toBeGreaterThan(Date.now() - 60_000);

  // saving a version that uses it does too, and a render needs it
  await sql`UPDATE public.asset_develop_artifact SET "createdAt" = now() - interval '30 days' WHERE id = ${sha('e')}`.execute(
    db,
  );
  const recipe = {
    ...defaultDevelopRecipe(),
    cleanup: [{ id: 'x', method: 'remove', region: { x: 0, y: 0, w: 0.5, h: 0.5 }, fill: sha('e') }],
  } as never;
  await sut.create({
    assetId: asset.id,
    ownerId: user.id,
    recipe,
    recipeVersion: 1,
    label: null,
    status: AssetDevelopRevisionStatus.Saved,
  });
  expect((await age())!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  const renderable = (extra: object) =>
    sut.create({
      assetId: asset.id,
      ownerId: user.id,
      recipe: { ...defaultDevelopRecipe(), ...extra } as never,
      recipeVersion: 1,
      requireRenderable: true,
      label: null,
      status: AssetDevelopRevisionStatus.Saved,
    });
  const sky = (artifact: string, enabled = true) => ({
    id: 's',
    kind: 'sky',
    x: 0.5,
    y: 0.5,
    enabled,
    artifact,
    adjustments: { exposure: 1 },
  });
  await expect(renderable({ masks: [sky(sha('f'))] })).rejects.toThrow('not uploaded for this photo');
  // a fill never stands in for a mask bitmap
  await expect(renderable({ masks: [sky(sha('e'))] })).rejects.toThrow('not uploaded for this photo');
  // what a render never reads is kept without being required: a disabled mask or Clean Up
  await expect(
    renderable({
      masks: [sky(sha('f'), false)],
      cleanup: [{ id: 'y', method: 'remove', enabled: false, region: { x: 0, y: 0, w: 0.5, h: 0.5 }, fill: sha('9') }],
    }),
  ).resolves.toMatchObject({ assetId: asset.id });

  // released, then recorded again before the queued deletion runs: the file stays
  await sql`DELETE FROM public.asset_develop_revision WHERE "assetId" = ${asset.id}::uuid`.execute(db);
  const queue = vi.fn().mockResolvedValue(undefined);
  await sut.releaseArtifacts(queue, { unreferencedBefore: new Date(Date.now() + 60_000) });
  expect(queue).toHaveBeenCalledWith([artifact.path]);
  await sut.addArtifact(artifact);
  const unlink = vi.fn().mockResolvedValue(undefined);
  const physical = new PhysicalFileRepository(db);
  await expect(physical.deleteUnreferencedPath(artifact.path, unlink)).resolves.toMatchObject({ deleted: false });
  expect(unlink).not.toHaveBeenCalled();
});

it('holds the per-photo limit when concurrent uploads race for the remaining slots (FL-304)', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const artifact = (index: number) => {
    const id = index.toString(16).padStart(64, '0');
    return {
      assetId: asset.id,
      id,
      ownerId: user.id,
      kind: 'mask' as const,
      path: `/thumbs/${asset.id}_develop_artifact_${id}.png`,
      bytes: 100,
      width: 10,
      height: 10,
    };
  };
  // Exercise the quota race below the separate database admission cap. There are still 80 distinct
  // uploads in total, with 20 competing for four remaining slots and 16 exact business refusals.
  const remaining = 4;
  const existing = DEVELOP_ARTIFACT_PER_ASSET - remaining;
  for (let index = 0; index < existing; index++) {
    await expect(sut.addArtifact(artifact(index))).resolves.toBe(true);
  }
  const results = await Promise.allSettled(
    Array.from({ length: remaining + 16 }, (_, index) => sut.addArtifact(artifact(existing + index))),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toEqual(
    Array.from({ length: remaining }, () => ({ status: 'fulfilled', value: true })),
  );
  expect(refusals(results)).toHaveLength(16);
  expect(refusals(results).every(({ code }) => code === 'develop_artifact_limit')).toBe(true);
  await expect(stored(asset.id)).resolves.toBe(DEVELOP_ARTIFACT_PER_ASSET);
  // a refused upload is not charged
  await expect(usage(user.id)).resolves.toBe(DEVELOP_ARTIFACT_PER_ASSET * 100);
}, 30_000);

it('holds the owner’s quota when uploads for several photos arrive at once, and counts them for later uploads (FL-304)', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser({ quotaSizeInBytes: 5500 });
  const assets = await Promise.all(Array.from({ length: 12 }, () => ctx.newAsset({ ownerId: user.id })));
  const results = await Promise.allSettled(
    assets.map(({ asset }) =>
      sut.addArtifact({
        assetId: asset.id,
        id: sha('a'),
        ownerId: user.id,
        kind: 'fill',
        path: `/thumbs/${asset.id}_develop_artifact_${sha('a')}.png`,
        bytes: 1000,
        width: 10,
        height: 10,
      }),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
  expect(refusals(results)).toHaveLength(7);
  expect(refusals(results).every(({ code }) => code === 'develop_artifact_quota')).toBe(true);
  await expect(usage(user.id)).resolves.toBe(5000);
  const kept = await Promise.all(assets.map(({ asset }) => stored(asset.id)));
  expect(kept.filter((count) => count === 1)).toHaveLength(5);

  // the usage a photo upload is checked against includes them, and a recount keeps them: one
  // stored before FL-304 was never charged, and is from the next recount on
  const users = new UserRepository(db);
  await expect(users.get(user.id, {})).resolves.toMatchObject({ quotaUsageInBytes: 5000, quotaSizeInBytes: 5500 });
  await ctx.newExif({ assetId: assets[0].asset.id, fileSizeInByte: 300 });
  await sql`UPDATE "user" SET "quotaUsageInBytes" = 0 WHERE id = ${user.id}::uuid`.execute(db);
  await expect(sut.syncUsage(user.id)).resolves.toBe(true);
  await expect(usage(user.id)).resolves.toBe(5300);

  // released artifacts leave the usage again
  const before = new Date(Date.now() + 60_000);
  await sut.releaseArtifacts(vi.fn().mockResolvedValue(void 0), { unreferencedBefore: before });
  await expect(usage(user.id)).resolves.toBe(300);
}, 30_000);

it('preserves shared Live Photo originals through Develop save, cancellation, selection and reset', async () => {
  const { ctx, sut: revisions } = setup();
  const mocks = getMocks();
  mocks.mediaOperation.listActiveEditsOfRevision.mockResolvedValue([]);
  const service = new AssetDevelopService(
    mocks.logger as never,
    ctx.get(AccessRepository),
    ctx.get(AssetRepository),
    mocks.assetJob as never,
    revisions,
    mocks.config as never,
    mocks.crypto as never,
    mocks.job as never,
    mocks.media as never,
    {} as PhotoToolsRepository,
    mocks.storage as never,
    mocks.systemMetadata as never,
    mocks.mediaOperation as never,
    mocks.machineLearning as never,
  );
  const { user } = await ctx.newUser();
  const { user: stranger } = await ctx.newUser();
  const auth = factory.auth({ user: { id: user.id } });
  const foreign = factory.auth({ user: { id: stranger.id } });
  const { asset: motion } = await ctx.newAsset({
    ownerId: user.id,
    type: AssetType.Video,
    visibility: AssetVisibility.Hidden,
    originalFileName: 'motion.MOV',
  });
  const stills = await Promise.all(
    ['original.HEIC', 'related.HEIC'].map((originalFileName) =>
      ctx.newAsset({ ownerId: user.id, originalFileName, livePhotoVideoId: motion.id }),
    ),
  );
  const ids = [motion.id, ...stills.map(({ asset }) => asset.id)];
  for (const id of ids) await ctx.newExif({ assetId: id, livePhotoCID: 'same-original-pair' });
  const originals = await db.selectFrom('asset').selectAll().where('id', 'in', ids).orderBy('id').execute();
  const identifiers = await db
    .selectFrom('asset_exif')
    .selectAll()
    .where('assetId', 'in', ids)
    .orderBy('assetId')
    .execute();
  const preserved = async () => {
    expect(await db.selectFrom('asset').selectAll().where('id', 'in', ids).orderBy('id').execute()).toEqual(originals);
    expect(
      await db.selectFrom('asset_exif').selectAll().where('assetId', 'in', ids).orderBy('assetId').execute(),
    ).toEqual(identifiers);
    expect(mocks.job.queue).not.toHaveBeenCalled();
    expect(mocks.storage.createFile).not.toHaveBeenCalled();
    expect(mocks.storage.overwriteFile).not.toHaveBeenCalled();
    expect(mocks.storage.createOrOverwriteFile).not.toHaveBeenCalled();
    expect(mocks.storage.unlink).not.toHaveBeenCalled();
  };
  const id = stills[0].asset.id;
  const recipe = defaultDevelopRecipe();
  const first = await service.save(auth, id, { recipe, render: false });
  await preserved();
  // Codec acceptance is separate: seed its published result to exercise the real selection transaction.
  await revisions.update(first.id, {
    status: AssetDevelopRevisionStatus.Rendered,
    masterPath: '/develop/edited-still.jpg',
    previewPath: '/develop/edited-preview.jpg',
  });
  expect((await service.revert(auth, id, { revisionId: first.id })).currentRevisionId).toBe(first.id);
  await preserved();
  const second = await service.save(auth, id, { recipe: { ...recipe, exposure: 1 }, render: false });
  await revisions.update(second.id, { status: AssetDevelopRevisionStatus.Queued });
  expect((await service.cancel(auth, id, second.id)).status).toBe(AssetDevelopRevisionStatus.Cancelled);
  expect((await service.get(auth, id)).currentRevisionId).toBe(first.id);
  await preserved();
  await expect(service.save(foreign, id, { recipe, render: false })).rejects.toThrow();
  await expect(service.revert(foreign, id, {})).rejects.toThrow();
  expect((await service.revert(auth, id, {})).currentRevisionId).toBeNull();
  expect((await service.get(auth, id)).revisions.map((value) => value.id)).toEqual([second.id, first.id]);
  expect((await service.revert(auth, id, { revisionId: first.id })).currentRevisionId).toBe(first.id);
  expect((await service.get(auth, stills[1].asset.id)).currentRevisionId).toBeNull();
  await expect(service.revert(auth, stills[1].asset.id, { revisionId: first.id })).rejects.toThrow();
  await preserved();
});
