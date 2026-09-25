import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AssetLockReason, AssetVisibility, JobStatus } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { TagService } from 'src/services/tag.service.js';
import { upsertTags } from 'src/utils/tag.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(TagService, {
    database: db || defaultDatabase,
    real: [AssetRepository, TagRepository, AccessRepository, SearchRepository],
    mock: [EventRepository, LoggingRepository],
  });
};

/** A tag owned by one user, plus another user's auth to attempt access with */
const newTagOfAnotherUser = async (ctx: ReturnType<typeof setup>['ctx']) => {
  const { user } = await ctx.newUser();
  const { user: otherUser } = await ctx.newUser();
  const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['tag-1'] });

  return { tag, auth: factory.auth({ user }), otherAuth: factory.auth({ user: otherUser }) };
};

/** A session that is not unlocked while its owner suppresses these tags (owner decision, September 22, 2026) */
const lockedAuth = (userId: string, tagIds: string[]) => {
  const auth = factory.auth({ user: { id: userId } });
  return {
    ...auth,
    hideNsfwAssets: true,
    hiddenContent: { userId, includeNsfw: false, tagIds, personIds: [], petIds: [], scope: 'owned' as const },
  };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(TagService.name, () => {
  describe('get', () => {
    it('should not return a tag of another user', async () => {
      const { sut, ctx } = setup();
      const { tag, otherAuth } = await newTagOfAnotherUser(ctx);

      await expect(sut.get(otherAuth, tag.id)).rejects.toThrow('Tag not found');
    });

    it('should answer a suppressed tag, and one nested under it, like a missing tag while locked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tags = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['private/nested', 'public'] });
      const byValue = new Map(tags.map((tag) => [tag.value, tag]));
      const parent = await ctx.get(TagRepository).getByValue(user.id, 'private');
      const auth = lockedAuth(user.id, [parent!.id]);

      await expect(sut.get(auth, parent!.id)).rejects.toThrow('Tag not found');
      await expect(sut.get(auth, byValue.get('private/nested')!.id)).rejects.toThrow('Tag not found');
      await expect(sut.get(auth, byValue.get('public')!.id)).resolves.toEqual(
        expect.objectContaining({ value: 'public' }),
      );
      await expect(sut.getAll(auth)).resolves.toEqual([expect.objectContaining({ value: 'public' })]);
    });

    it('should show a suppressed tag once the session is unlocked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['private'] });
      const { hiddenContent, ...unlocked } = lockedAuth(user.id, [tag.id]);
      const auth = { ...unlocked, hideNsfwAssets: undefined, suppressedContent: hiddenContent };

      await expect(sut.get(auth, tag.id)).resolves.toEqual(expect.objectContaining({ id: tag.id }));
      await expect(sut.getAll(auth)).resolves.toEqual([expect.objectContaining({ id: tag.id })]);
    });
  });

  describe('update', () => {
    it('should not update a tag of another user', async () => {
      const { sut, ctx } = setup();
      const { tag, otherAuth } = await newTagOfAnotherUser(ctx);

      await expect(sut.update(otherAuth, tag.id, { color: '#000000' })).rejects.toThrow('Tag not found');
    });

    it('should not update a suppressed tag while locked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['private'] });

      await expect(sut.update(lockedAuth(user.id, [tag.id]), tag.id, { color: '#000000' })).rejects.toThrow(
        'Tag not found',
      );
      await expect(ctx.get(TagRepository).get(tag.id)).resolves.toEqual(expect.objectContaining({ color: null }));
    });

    describe('moving a tag (FL-46)', () => {
      const closureOf = (ctx: ReturnType<typeof setup>['ctx'], ids: string[]) =>
        ctx.database
          .selectFrom('tag_closure')
          .select(['id_ancestor', 'id_descendant'])
          .where('id_descendant', 'in', ids)
          .execute()
          .then((rows) => rows.map((row) => `${row.id_ancestor}>${row.id_descendant}`).toSorted());

      const nestedTags = async (ctx: ReturnType<typeof setup>['ctx']) => {
        const { user } = await ctx.newUser();
        const [a, b, c, d] = await upsertTags(ctx.get(TagRepository), {
          userId: user.id,
          tags: ['A', 'A/B', 'A/B/C', 'A/B/C/D'],
        });
        const [x] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['X'] });
        return { auth: factory.auth({ user }), a, b, c, d, x };
      };

      it('moves a tag and its descendants to the top level', async () => {
        const { sut, ctx } = setup();
        const { auth, a, b, c, d } = await nestedTags(ctx);

        const moved = await sut.update(auth, c.id, { parentId: null });
        expect(moved).toEqual(expect.objectContaining({ id: c.id, value: 'C', name: 'C', parentId: undefined }));

        const tagRepository = ctx.get(TagRepository);
        await expect(tagRepository.get(d.id)).resolves.toEqual(
          expect.objectContaining({ value: 'C/D', parentId: c.id }),
        );
        await expect(tagRepository.get(b.id)).resolves.toEqual(expect.objectContaining({ value: 'A/B' }));
        await expect(closureOf(ctx, [c.id, d.id])).resolves.toEqual(
          [`${c.id}>${c.id}`, `${c.id}>${d.id}`, `${d.id}>${d.id}`].toSorted(),
        );
        await expect(closureOf(ctx, [a.id, b.id])).resolves.toEqual(
          [`${a.id}>${a.id}`, `${a.id}>${b.id}`, `${b.id}>${b.id}`].toSorted(),
        );
      });

      it('moves and renames a tag under another parent', async () => {
        const { sut, ctx } = setup();
        const { auth, b, c, d, x } = await nestedTags(ctx);

        await expect(sut.update(auth, b.id, { parentId: x.id, name: 'Bee' })).resolves.toEqual(
          expect.objectContaining({ value: 'X/Bee', parentId: x.id }),
        );
        await expect(ctx.get(TagRepository).get(d.id)).resolves.toEqual(
          expect.objectContaining({ value: 'X/Bee/C/D' }),
        );
        await expect(closureOf(ctx, [d.id])).resolves.toEqual(
          [`${x.id}>${d.id}`, `${b.id}>${d.id}`, `${c.id}>${d.id}`, `${d.id}>${d.id}`].toSorted(),
        );
      });

      it('rejects moving a tag under itself or its descendant', async () => {
        const { sut, ctx } = setup();
        const { auth, b, d } = await nestedTags(ctx);

        await expect(sut.update(auth, b.id, { parentId: b.id })).rejects.toThrow('cannot be moved under itself');
        await expect(sut.update(auth, b.id, { parentId: d.id })).rejects.toThrow('cannot be moved under itself');
        await expect(ctx.get(TagRepository).get(b.id)).resolves.toEqual(expect.objectContaining({ value: 'A/B' }));
      });

      it('rejects a move onto an existing tag path', async () => {
        const { sut, ctx } = setup();
        const { auth, d, x } = await nestedTags(ctx);
        await upsertTags(ctx.get(TagRepository), { userId: auth.user.id, tags: ['D'] });

        await expect(sut.update(auth, d.id, { parentId: null })).rejects.toThrow('already exists');
        await expect(sut.update(auth, x.id, { name: 'D' })).rejects.toThrow('already exists');
      });

      it('lets only one of two concurrent crossing moves through', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();
        const auth = factory.auth({ user });
        const [a, b] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['A', 'B'] });

        const results = await Promise.allSettled([
          sut.update(auth, a.id, { parentId: b.id }),
          sut.update(auth, b.id, { parentId: a.id }),
        ]);

        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        expect(rejected?.reason).toBeInstanceOf(BadRequestException);
        const values = await ctx.database
          .selectFrom('tag')
          .select('value')
          .where('id', 'in', [a.id, b.id])
          .execute()
          .then((rows) => rows.map(({ value }) => value).toSorted());
        // either B moved under A or A under B, never both
        expect([
          ['A', 'A/B'],
          ['B', 'B/A'],
        ]).toContainEqual(values);
      });

      it('answers a concurrent rename onto the same path with 400', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();
        const auth = factory.auth({ user });
        const [a, b] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['A', 'B'] });

        const results = await Promise.allSettled([
          sut.update(auth, a.id, { name: 'C' }),
          sut.update(auth, b.id, { name: 'C' }),
        ]);

        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        expect(rejected?.reason).toBeInstanceOf(BadRequestException);
      });

      it("rejects another user's tag as the new parent", async () => {
        const { sut, ctx } = setup();
        const { auth, c } = await nestedTags(ctx);
        const { tag: foreign } = await newTagOfAnotherUser(ctx);

        await expect(sut.update(auth, c.id, { parentId: foreign.id })).rejects.toThrow('Tag not found');
        await expect(ctx.get(TagRepository).get(c.id)).resolves.toEqual(expect.objectContaining({ value: 'A/B/C' }));
      });
    });
  });

  describe('remove', () => {
    it('should not remove a tag of another user', async () => {
      const { sut, ctx } = setup();
      const { tag, auth, otherAuth } = await newTagOfAnotherUser(ctx);

      await expect(sut.remove(otherAuth, tag.id)).rejects.toThrow('Tag not found');
      await expect(sut.get(auth, tag.id)).resolves.toEqual(expect.objectContaining({ id: tag.id }));
    });
  });

  describe('getStatistics (FL-46)', () => {
    it('counts Timeline items per tag with and without subtags, never an archived, trashed or Locked one', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tags = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['trips/rockies', 'family'] });
      const byValue = new Map(tags.map((tag) => [tag.value, tag]));
      const trips = (await ctx.get(TagRepository).getByValue(user.id, 'trips'))!;
      const rockies = byValue.get('trips/rockies')!;
      const family = byValue.get('family')!;

      const { asset: onTrip } = await ctx.newAsset({ ownerId: user.id });
      const { asset: onTripToo } = await ctx.newAsset({ ownerId: user.id });
      const { asset: tripsOnly } = await ctx.newAsset({ ownerId: user.id });
      const { asset: archived } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Archive });
      const { asset: trashed } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id });
      await ctx.database
        .insertInto('asset_lock')
        .values({ assetId: locked.id, reason: AssetLockReason.Marked, lockedBy: null })
        .execute();
      await ctx.newTagAsset({
        tagIds: [rockies.id],
        assetIds: [onTrip.id, onTripToo.id, archived.id, trashed.id, locked.id],
      });
      await ctx.newTagAsset({ tagIds: [trips.id], assetIds: [onTrip.id, tripsOnly.id] });

      const statistics = await sut.getStatistics(factory.auth({ user }));
      // the Locked item stays out even for a session unlocked to the Locked view
      const unlocked = await sut.getStatistics({
        ...factory.auth({ user }),
        session: { id: 'session-1', hasElevatedPermission: true },
      });

      for (const result of [statistics, unlocked]) {
        expect(result).toHaveLength(2);
        expect(result).toEqual(
          expect.arrayContaining([
            // trips: two items tagged "trips" itself; three distinct items with "trips/rockies"
            { id: trips.id, count: 2, total: 3 },
            { id: rockies.id, count: 2, total: 2 },
          ]),
        );
        expect(result.find(({ id }) => id === family.id)).toBeUndefined();
      }
    });

    it('leaves out a suppressed tag, the tags under it and hidden items while the session is locked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tags = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['private/nested', 'public'] });
      const byValue = new Map(tags.map((tag) => [tag.value, tag]));
      const parent = (await ctx.get(TagRepository).getByValue(user.id, 'private'))!;
      const { asset: privateAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: publicAsset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newTagAsset({ tagIds: [byValue.get('private/nested')!.id], assetIds: [privateAsset.id] });
      // an item that also carries the suppressed tag is hidden, so it never counts for "public"
      await ctx.newTagAsset({ tagIds: [byValue.get('public')!.id], assetIds: [privateAsset.id, publicAsset.id] });

      await expect(sut.getStatistics(lockedAuth(user.id, [parent.id]))).resolves.toEqual([
        { id: byValue.get('public')!.id, count: 1, total: 1 },
      ]);
    });
  });

  describe('addAssets', () => {
    it('should not add assets to a tag of another user', async () => {
      const { sut, ctx } = setup();
      const { tag, otherAuth } = await newTagOfAnotherUser(ctx);
      const { asset } = await ctx.newAsset({ ownerId: otherAuth.user.id });

      await expect(sut.addAssets(otherAuth, tag.id, { ids: [asset.id] })).rejects.toThrow('Tag not found');
    });

    it('should lock exif column', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['tag-1'] });
      const authDto = factory.auth({ user });

      await sut.addAssets(authDto, tag.id, { ids: [asset.id] });
      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select(['lockedProperties', 'tags'])
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        lockedProperties: ['tags'],
        tags: ['tag-1'],
      });
      await expect(ctx.get(TagRepository).getByValue(user.id, 'tag-1')).resolves.toEqual(
        expect.objectContaining({ id: tag.id }),
      );
      await expect(ctx.get(TagRepository).getAssetIds(tag.id, [asset.id])).resolves.toContain(asset.id);
    });

    it('should not tag a partner asset', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user: owner } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: owner.id, inTimeline: true });
      const { asset } = await ctx.newAsset({ ownerId: partner.id });
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: owner.id, tags: ['tag-1'] });
      const authDto = factory.auth({ user: owner });

      await expect(sut.addAssets(authDto, tag.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: false, error: BulkIdErrorReason.NO_PERMISSION },
      ]);
    });
  });

  describe('removeAssets', () => {
    it('should not remove assets from a tag of another user', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { tag, auth, otherAuth } = await newTagOfAnotherUser(ctx);
      const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
      await sut.addAssets(auth, tag.id, { ids: [asset.id] });

      await expect(sut.removeAssets(otherAuth, tag.id, { ids: [asset.id] })).rejects.toThrow('Tag not found');
      await expect(ctx.get(TagRepository).getAssetIds(tag.id, [asset.id])).resolves.toContain(asset.id);
    });
  });

  describe('deleteEmptyTags', () => {
    it('single tag exists, not connected to any assets, and is deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tagRepo = ctx.get(TagRepository);
      const [tag] = await upsertTags(tagRepo, { userId: user.id, tags: ['tag-1'] });

      await expect(tagRepo.getByValue(user.id, 'tag-1')).resolves.toEqual(expect.objectContaining({ id: tag.id }));
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'tag-1')).resolves.toBeUndefined();
    });

    it('single tag exists, connected to one asset, and is not deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const tagRepo = ctx.get(TagRepository);
      const [tag] = await upsertTags(tagRepo, { userId: user.id, tags: ['tag-1'] });

      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });

      await expect(tagRepo.getByValue(user.id, 'tag-1')).resolves.toEqual(expect.objectContaining({ id: tag.id }));
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'tag-1')).resolves.toEqual(expect.objectContaining({ id: tag.id }));
    });

    it('hierarchical tag exists, and the parent is connected to an asset, and the child is deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const tagRepo = ctx.get(TagRepository);
      const [parentTag, childTag] = await upsertTags(tagRepo, { userId: user.id, tags: ['parent', 'parent/child'] });

      await ctx.newTagAsset({ tagIds: [parentTag.id], assetIds: [asset.id] });

      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toEqual(
        expect.objectContaining({ id: childTag.id }),
      );
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toBeUndefined();
    });

    it('hierarchical tag exists, and only the child is connected to an asset, and nothing is deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const tagRepo = ctx.get(TagRepository);
      const [parentTag, childTag] = await upsertTags(tagRepo, { userId: user.id, tags: ['parent', 'parent/child'] });

      await ctx.newTagAsset({ tagIds: [childTag.id], assetIds: [asset.id] });

      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toEqual(
        expect.objectContaining({ id: childTag.id }),
      );
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toEqual(
        expect.objectContaining({ id: childTag.id }),
      );
    });

    it('hierarchical tag exists, and neither parent nor child is connected to an asset, and both are deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tagRepo = ctx.get(TagRepository);
      const [parentTag, childTag] = await upsertTags(tagRepo, { userId: user.id, tags: ['parent', 'parent/child'] });

      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toEqual(
        expect.objectContaining({ id: parentTag.id }),
      );
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toEqual(
        expect.objectContaining({ id: childTag.id }),
      );
      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);
      await expect(tagRepo.getByValue(user.id, 'parent/child')).resolves.toBeUndefined();
      await expect(tagRepo.getByValue(user.id, 'parent')).resolves.toBeUndefined();
    });
  });
});
