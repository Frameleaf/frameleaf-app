import { Kysely } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(TagRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(TagRepository.name, () => {
  afterEach(async () => {
    const { ctx } = setup();
    await ctx.database.deleteFrom('tag_closure').execute();
    await ctx.database.deleteFrom('tag_asset').execute();
    await ctx.database.deleteFrom('tag').execute();
  });

  describe('create', () => {
    it('should create a top-level tag with proper closures', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const result = await sut.create({
        userId: user.id,
        value: 'tagA',
        color: '#000000',
      });

      await expect(
        ctx.database
          .selectFrom('tag')
          .select(['userId', 'value', 'color', 'parentId'])
          .where('id', '=', result.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ userId: user.id, value: 'tagA', color: '#000000', parentId: null });

      await expect(
        ctx.database
          .selectFrom('tag_closure')
          .select(['id_ancestor', 'id_descendant'])
          .where('id_ancestor', '=', result.id)
          .execute(),
      ).resolves.toEqual([{ id_ancestor: result.id, id_descendant: result.id }]);
    });
    it('should create a child tag with proper closures', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const resultParent = await sut.create({
        userId: user.id,
        value: 'tagA',
        color: '#000000',
      });
      const resultChild = await sut.create({
        userId: user.id,
        value: 'tagA/tagB',
        color: '#00FF00',
        parentId: resultParent.id,
      });

      await expect(
        ctx.database
          .selectFrom('tag')
          .select(['userId', 'value', 'color', 'parentId'])
          .where('id', '=', resultParent.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ userId: user.id, value: 'tagA', color: '#000000', parentId: null });

      await expect(
        ctx.database
          .selectFrom('tag')
          .select(['userId', 'value', 'color', 'parentId'])
          .where('id', '=', resultChild.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ userId: user.id, value: 'tagA/tagB', color: '#00FF00', parentId: resultParent.id });

      await expect(
        ctx.database
          .selectFrom('tag_closure')
          .select(['id_ancestor', 'id_descendant'])
          .where('id_ancestor', '=', resultParent.id)
          .execute(),
      ).resolves.toEqual([
        { id_ancestor: resultParent.id, id_descendant: resultParent.id },
        { id_ancestor: resultParent.id, id_descendant: resultChild.id },
      ]);

      await expect(
        ctx.database
          .selectFrom('tag_closure')
          .select(['id_ancestor', 'id_descendant'])
          .where('id_ancestor', '=', resultChild.id)
          .execute(),
      ).resolves.toEqual([{ id_ancestor: resultChild.id, id_descendant: resultChild.id }]);
    });
  });

  describe('update', () => {
    it('should update a tag color', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const { tag } = await ctx.newTag({
        userId: user.id,
        value: 'tagA',
        color: '#000000',
      });

      await sut.update(tag.id, { color: '#FFFFFF' });

      await expect(
        ctx.database
          .selectFrom('tag')
          .select(['userId', 'value', 'color', 'parentId'])
          .where('id', '=', tag.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ userId: user.id, value: 'tagA', color: '#FFFFFF', parentId: null });
    });
    it('should update a top-level tag value', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const { tag } = await ctx.newTag({
        userId: user.id,
        value: 'tagA',
        color: '#000000',
      });

      await sut.update(tag.id, { name: 'updatedTagA' });

      await expect(
        ctx.database
          .selectFrom('tag')
          .select(['userId', 'value', 'color', 'parentId'])
          .where('id', '=', tag.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ userId: user.id, value: 'updatedTagA', color: '#000000', parentId: null });
    });
  });

  describe('addAssetIds', () => {
    it('keeps a row that is already there instead of failing', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { tag } = await ctx.newTag({ userId: user.id, value: 'trip' });
      // metadata extraction added it first
      await sut.upsertAssetIds([{ tagId: tag.id, assetId: asset.id }]);

      await expect(sut.addAssetIds(tag.id, [asset.id])).resolves.toBeUndefined();
      await expect(
        ctx.database.selectFrom('tag_asset').select('tagId').where('assetId', '=', asset.id).execute(),
      ).resolves.toEqual([{ tagId: tag.id }]);
    });
  });

  describe('removeAssetTagValues', () => {
    it('removes only the named values of the owner from the asset', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { tag: fromFile } = await ctx.newTag({ userId: user.id, value: 'fromFile' });
      const { tag: addedLater } = await ctx.newTag({ userId: user.id, value: 'addedLater' });
      const { tag: othersTag } = await ctx.newTag({ userId: other.id, value: 'fromFile' });
      await sut.upsertAssetIds([
        { tagId: fromFile.id, assetId: asset.id },
        { tagId: addedLater.id, assetId: asset.id },
        { tagId: othersTag.id, assetId: asset.id },
      ]);

      await sut.removeAssetTagValues(asset.id, user.id, ['fromFile']);
      await sut.removeAssetTagValues(asset.id, user.id, []);

      const remaining = await ctx.database
        .selectFrom('tag_asset')
        .select('tagId')
        .where('assetId', '=', asset.id)
        .execute();
      expect(remaining.map(({ tagId }) => tagId).toSorted()).toEqual([addedLater.id, othersTag.id].toSorted());
    });
  });

  describe('delete', () => {
    it('should delete top-level tag without descendants', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const { tag } = await ctx.newTag({
        userId: user.id,
        value: 'tagA',
        color: '#000000',
      });

      await expect(
        ctx.database
          .selectFrom('tag')
          .select(['userId', 'value', 'color', 'parentId'])
          .where('id', '=', tag.id)
          .executeTakeFirst(),
      ).resolves.toEqual({ userId: user.id, value: 'tagA', color: '#000000', parentId: null });

      await sut.delete(tag.id);

      await expect(
        ctx.database.selectFrom('tag').selectAll().where('id', '=', tag.id).executeTakeFirst(),
      ).resolves.toBeUndefined();
    });

    it('should delete a parent tag and all its descendants', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const { tag: tag1 } = await ctx.newTag({
        userId: user.id,
        value: 'tagA',
        color: '#000000',
      });

      const { tag: tag2 } = await ctx.newTag({
        userId: user.id,
        value: 'tagA/tagB',
        color: '#00FF00',
        parentId: tag1.id,
      });

      const { tag: tag3 } = await ctx.newTag({
        userId: user.id,
        value: 'tagA/tagB/tagC',
        color: '#0000FF',
        parentId: tag2.id,
      });

      const { tag: tag4 } = await ctx.newTag({
        userId: user.id,
        value: 'tagA/tagD',
        color: '#FFFF00',
        parentId: tag1.id,
      });

      const { tag: tag5 } = await ctx.newTag({
        userId: user.id,
        value: 'tagA/tagD/tagE',
        color: '#FF00FF',
        parentId: tag4.id,
      });
      await expect(
        ctx.database
          .selectFrom('tag')
          .select(['userId', 'value', 'color', 'parentId'])
          .where('id', 'in', [tag1.id, tag2.id, tag3.id, tag4.id, tag5.id])
          .execute(),
      ).resolves.toEqual(
        expect.arrayContaining([
          { userId: user.id, value: 'tagA', color: '#000000', parentId: null },
          { userId: user.id, value: 'tagA/tagB', color: '#00FF00', parentId: tag1.id },
          { userId: user.id, value: 'tagA/tagB/tagC', color: '#0000FF', parentId: tag2.id },
          { userId: user.id, value: 'tagA/tagD', color: '#FFFF00', parentId: tag1.id },
          { userId: user.id, value: 'tagA/tagD/tagE', color: '#FF00FF', parentId: tag4.id },
        ]),
      );

      await sut.delete(tag1.id);

      await expect(
        ctx.database
          .selectFrom('tag')
          .where('id', 'in', [tag1.id, tag2.id, tag3.id, tag4.id, tag5.id])
          .executeTakeFirst(),
      ).resolves.toBeUndefined();
    });

    it('should not delete tags outside the hierarchy', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const { tag: tag1 } = await ctx.newTag({
        userId: user.id,
        value: 'tagA',
        color: '#000000',
      });

      const { tag: tag2 } = await ctx.newTag({
        userId: user.id,
        value: 'tagA/tagB',
        color: '#00FF00',
        parentId: tag1.id,
      });

      const { tag: tag3 } = await ctx.newTag({
        userId: user.id,
        value: 'tagC',
        color: '#0000FF',
      });

      await expect(
        ctx.database
          .selectFrom('tag')
          .select(['userId', 'value', 'color', 'parentId'])
          .where('id', 'in', [tag1.id, tag2.id, tag3.id])
          .execute(),
      ).resolves.toEqual(
        expect.arrayContaining([
          { userId: user.id, value: 'tagA', color: '#000000', parentId: null },
          { userId: user.id, value: 'tagA/tagB', color: '#00FF00', parentId: tag1.id },
          { userId: user.id, value: 'tagC', color: '#0000FF', parentId: null },
        ]),
      );

      await sut.delete(tag1.id);

      await expect(
        ctx.database.selectFrom('tag').select(['userId', 'value', 'color', 'parentId']).execute(),
      ).resolves.toEqual([{ userId: user.id, value: 'tagC', color: '#0000FF', parentId: null }]);
    });
  });
});
