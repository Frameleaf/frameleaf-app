import { BadRequestException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as artifacts from 'src/fork-schema/migrations/0000000000212-AssetDevelopArtifacts.js';
import { AssetDevelopRepository, DEVELOP_ARTIFACT_PER_ASSET } from 'src/repositories/asset-develop.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-233: develop artifacts are tracked, counted and released (fork migration 0212). */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
  await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new AssetDevelopRepository(db) };
};

const isOurs = (entry: { identity: string }) => entry.identity.startsWith('immich_fork.asset_develop_artifact');
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
        SELECT count(*) AS count FROM immich_fork.asset_develop_artifact WHERE "assetId" = ${assetId}::uuid
      `.execute(db)
    ).rows[0].count,
  );
const refusals = (results: PromiseSettledResult<boolean>[]) =>
  results.flatMap((result) =>
    result.status === 'rejected' ? [(result.reason as BadRequestException).getResponse() as { code: string }] : [],
  );

it('matches the private catalog and rolls back without modifying the official catalog', async () => {
  const before = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
    const ours = before[kind].filter((entry) => isOurs(entry));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours).toEqual(manifest[kind].filter((entry) => isOurs(entry)));
  }
  await artifacts.down(db);
  await artifacts.up(db);
  const after = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
    expect(after[kind].filter((entry) => entry.identity.startsWith('public.'))).toEqual(
      before[kind].filter((entry) => entry.identity.startsWith('public.')),
    );
    expect(after[kind].filter((entry) => isOurs(entry))).toEqual(before[kind].filter((entry) => isOurs(entry)));
  }
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
      }>`SELECT "createdAt" FROM immich_fork.asset_develop_artifact WHERE id = ${sha('e')}`.execute(db)
    ).rows[0]?.createdAt;
  await sql`UPDATE immich_fork.asset_develop_artifact SET "createdAt" = now() - interval '30 days' WHERE id = ${sha('e')}`.execute(
    db,
  );
  // uploading it again restarts its grace period
  await expect(sut.addArtifact(artifact)).resolves.toBe(false);
  expect((await age())!.getTime()).toBeGreaterThan(Date.now() - 60_000);

  // saving a version that uses it does too, and a render needs it
  await sql`UPDATE immich_fork.asset_develop_artifact SET "createdAt" = now() - interval '30 days' WHERE id = ${sha('e')}`.execute(
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
  await sql`DELETE FROM immich_fork.asset_develop_revision WHERE "assetId" = ${asset.id}::uuid`.execute(db);
  const queue = vi.fn().mockResolvedValue(undefined);
  await sut.releaseArtifacts(queue, { unreferencedBefore: new Date(Date.now() + 60_000) });
  expect(queue).toHaveBeenCalledWith([artifact.path]);
  await sut.addArtifact(artifact);
  const unlink = vi.fn().mockResolvedValue(undefined);
  const physical = new PhysicalFileRepository(db);
  await expect(physical.deleteUnreferencedPath(artifact.path, unlink)).resolves.toMatchObject({ deleted: false });
  expect(unlink).not.toHaveBeenCalled();
});

it('refuses writes while the server is being handed over', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  await sql`UPDATE immich_fork.state SET phase='inactive' WHERE id=1`.execute(db);
  try {
    await expect(
      sut.addArtifact({
        assetId: asset.id,
        id: sha('d'),
        ownerId: user.id,
        kind: 'fill',
        path: '/thumbs/d.png',
        bytes: 1,
        width: 1,
        height: 1,
      }),
    ).rejects.toThrow(/handed over/);
    await expect(sut.releaseArtifacts(vi.fn(), { assetId: asset.id })).resolves.toEqual([]);
  } finally {
    await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
  }
});

it('holds the per-photo limit when more uploads than it allows arrive at once (FL-304)', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const results = await Promise.allSettled(
    Array.from({ length: DEVELOP_ARTIFACT_PER_ASSET + 16 }, (_, index) => {
      const id = index.toString(16).padStart(64, '0');
      return sut.addArtifact({
        assetId: asset.id,
        id,
        ownerId: user.id,
        kind: 'mask',
        path: `/thumbs/${asset.id}_develop_artifact_${id}.png`,
        bytes: 100,
        width: 10,
        height: 10,
      });
    }),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(DEVELOP_ARTIFACT_PER_ASSET);
  expect(refusals(results)).toHaveLength(16);
  expect(refusals(results).every(({ code }) => code === 'develop_artifact_limit')).toBe(true);
  await expect(stored(asset.id)).resolves.toBe(DEVELOP_ARTIFACT_PER_ASSET);
  // a refused upload is not charged
  await expect(usage(user.id)).resolves.toBe(DEVELOP_ARTIFACT_PER_ASSET * 100);
});

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
  await users.syncUsage(user.id);
  await expect(usage(user.id)).resolves.toBe(5300);

  // released artifacts leave the usage again
  const before = new Date(Date.now() + 60_000);
  await sut.releaseArtifacts(vi.fn().mockResolvedValue(void 0), { unreferencedBefore: before });
  await expect(usage(user.id)).resolves.toBe(300);
});
