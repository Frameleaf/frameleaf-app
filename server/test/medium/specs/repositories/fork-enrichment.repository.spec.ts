import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetMetadataKey } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
const key = AssetMetadataKey.MlEnrichment;
const setup = () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new AssetRepository(database) };
};

beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => database?.destroy());

describe('canonical enrichment metadata', () => {
  it('stores generated provenance separately from manual EXIF text and tags', async () => {
    const { ctx, sut } = setup();
    await expectCanonicalTables(database, ['asset', 'asset_metadata', 'asset_exif']);
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newExif({ assetId: asset.id, description: 'My own words' });
    const { tag } = await ctx.newTag({ userId: user.id, value: 'my-tag' });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
    const value = {
      description: {
        status: 'success',
        result: { description: 'A generated scene', tags: ['generated-tag'] },
        appliedTagValues: ['previously-applied'],
        provenance: { destinationId: 'local-model' },
      },
    };
    await sut.upsertMetadata(asset.id, [{ key, value }]);
    await expect(sut.getMetadataByKey(asset.id, key)).resolves.toMatchObject({ key, value });
    await expect(
      database.selectFrom('asset_exif').select('description').where('assetId', '=', asset.id).executeTakeFirst(),
    ).resolves.toEqual({ description: 'My own words' });
    await expect(
      database.selectFrom('tag_asset').select('tagId').where('assetId', '=', asset.id).execute(),
    ).resolves.toEqual([{ tagId: tag.id }]);
  });

  it('updates only the requested asset and metadata key without creating duplicate rows', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { asset: foreign } = await ctx.newAsset({ ownerId: other.id });
    await sut.upsertMetadata(asset.id, [
      { key: 'owner-note', value: { text: 'kept' } },
      { key, value: { version: 1 } },
    ]);
    await sut.upsertMetadata(foreign.id, [{ key, value: { version: 7 } }]);
    await sut.upsertMetadata(asset.id, [{ key, value: { version: 2 } }]);
    await expect(sut.getMetadataByKey(asset.id, key)).resolves.toMatchObject({ value: { version: 2 } });
    await expect(sut.getMetadataByKey(asset.id, 'owner-note')).resolves.toMatchObject({ value: { text: 'kept' } });
    await expect(sut.getMetadataByKey(foreign.id, key)).resolves.toMatchObject({ value: { version: 7 } });
    expect((await sut.getMetadata(asset.id)).filter((row) => row.key === key)).toHaveLength(1);
  });

  it('persists the manual privacy review and applies it ahead of the model result', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const value = { nsfwDetection: { status: 'success', result: { isNsfw: true }, review: { isNsfw: false } } };
    await sut.upsertMetadata(asset.id, [{ key, value }]);
    await expect(sut.getMetadataByKey(asset.id, key)).resolves.toMatchObject({ value });
    await expect(
      database.selectFrom('asset').select('is_nsfw').where('id', '=', asset.id).executeTakeFirst(),
    ).resolves.toEqual({ is_nsfw: false });
  });

  it('rolls back provenance and its privacy projection together', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const original = { description: { status: 'success', result: { description: 'kept' } } };
    await sut.upsertMetadata(asset.id, [{ key, value: original }]);
    await expect(
      database.transaction().execute(async (tx) => {
        await sut.upsertMetadata(
          asset.id,
          [{ key, value: { nsfwDetection: { status: 'success', result: { isNsfw: true } } } }],
          tx,
        );
        expect(await tx.selectFrom('asset').select('is_nsfw').where('id', '=', asset.id).executeTakeFirst()).toEqual({
          is_nsfw: true,
        });
        throw new Error('rollback fixture');
      }),
    ).rejects.toThrow('rollback fixture');
    await expect(sut.getMetadataByKey(asset.id, key)).resolves.toMatchObject({ value: original });
    await expect(
      database.selectFrom('asset').select('is_nsfw').where('id', '=', asset.id).executeTakeFirst(),
    ).resolves.toEqual({ is_nsfw: false });
  });

  it('deletes enrichment and clears its projection while retaining unrelated metadata', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await sut.upsertMetadata(asset.id, [
      { key, value: { nsfwDetection: { status: 'success', result: { isNsfw: true } } } },
      { key: 'owner-note', value: { text: 'kept' } },
    ]);
    await sut.deleteMetadataByKey(asset.id, key);
    await expect(sut.getMetadataByKey(asset.id, key)).resolves.toBeUndefined();
    await expect(sut.getMetadataByKey(asset.id, 'owner-note')).resolves.toMatchObject({ value: { text: 'kept' } });
    await expect(
      database.selectFrom('asset').select('is_nsfw').where('id', '=', asset.id).executeTakeFirst(),
    ).resolves.toEqual({ is_nsfw: false });
  });

  it('rejects orphan enrichment rather than retaining a detached sidecar', async () => {
    const { sut } = setup();
    const missing = randomUUID();
    await expect(sut.upsertMetadata(missing, [{ key, value: { source: 'missing' } }])).rejects.toMatchObject({
      code: '23503',
    });
    await expect(sut.getMetadataByKey(missing, key)).resolves.toBeUndefined();
  });
});
