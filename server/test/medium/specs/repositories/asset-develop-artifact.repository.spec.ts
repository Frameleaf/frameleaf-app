import { Kysely, sql } from 'kysely';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as artifacts from 'src/fork-schema/migrations/0000000000212-AssetDevelopArtifacts.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
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
  await expect(sut.getArtifactUsage(asset.id, user.id)).resolves.toEqual({ assetCount: 2, ownerBytes: 2000 });

  // a saved version references `a`; `b` is unused
  await sut.create({
    assetId: asset.id,
    ownerId: user.id,
    recipe: { ...defaultDevelopRecipe(), masks: [{ id: 's', kind: 'subject', artifact: sha('a') }] } as never,
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
  await expect(sut.getArtifactUsage(asset.id, user.id)).resolves.toEqual({ assetCount: 1, ownerBytes: 1000 });

  // a removed photo takes its artifacts with it
  await sql`DELETE FROM public.asset WHERE id = ${asset.id}::uuid`.execute(db);
  await expect(sut.releaseArtifacts(queue, { assetId: asset.id })).resolves.toEqual([row(sha('a')).path]);
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
