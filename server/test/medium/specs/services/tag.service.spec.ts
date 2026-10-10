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
    it('counts Timeline items per tag with and without subtags, never an archived, trashed or (while locked) Locked one', async () => {
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
      expect(statistics).toHaveLength(2);
      expect(statistics).toEqual(
        expect.arrayContaining([
          // trips: two items tagged "trips" itself; three distinct items with "trips/rockies"
          { id: trips.id, count: 2, total: 3 },
          { id: rockies.id, count: 2, total: 2 },
        ]),
      );
      expect(statistics.find(({ id }) => id === family.id)).toBeUndefined();

      // FL-195: an unlocked session counts the owner's own mark like any other Timeline item
      const unlocked = await sut.getStatistics({
        ...factory.auth({ user }),
        session: { id: 'session-1', hasElevatedPermission: true },
      });
      expect(unlocked).toHaveLength(2);
      expect(unlocked).toEqual(
        expect.arrayContaining([
          { id: trips.id, count: 2, total: 4 },
          { id: rockies.id, count: 3, total: 3 },
        ]),
      );
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

  /**
   * Owner decisions, September 27, 2026 (FL-46 / FL-34):
   * - "Use the existing tag regardless": creating or applying a tag by the name of one the session
   *   cannot see (a Locked-rule tag, or one only on hidden items) reuses that tag and succeeds, so no
   *   "already exists" error gives it away, and nothing about its hidden items is returned.
   * - While the session is not unlocked, a tag carried only by hidden items (locked for any reason,
   *   or matched by a Locked rule) is hidden itself: out of the list and answered like a missing id.
   *   One visible item brings it back. An unlocked session sees every tag.
   */
  describe('hidden tags (owner decisions, September 27, 2026)', () => {
    const lock = async (ctx: ReturnType<typeof setup>['ctx'], assetId: string, reason = AssetLockReason.Marked) => {
      await ctx.database.insertInto('asset_lock').values({ assetId, reason, lockedBy: null }).execute();
    };
    const unlockedAuth = (userId: string) => ({
      ...factory.auth({ user: { id: userId } }),
      session: { id: 'session-1', hasElevatedPermission: true },
    });
    /** Not unlocked, and nothing suppressed: only locks hide anything. */
    const plainLockedAuth = (userId: string) => factory.auth({ user: { id: userId } });

    it('reuses a Locked-rule tag when a locked session creates one by its name, without revealing its items', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      const [hidden] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['Alice'] });
      const { asset: secret } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newTagAsset({ tagIds: [hidden.id], assetIds: [secret.id] });
      const auth = lockedAuth(user.id, [hidden.id]);

      const created = await sut.create(auth, { name: 'Alice' });
      expect(created.id).toBe(hidden.id);
      // only the tag itself: no items, no counts
      expect(Object.keys(created).toSorted()).toEqual(
        ['color', 'createdAt', 'id', 'name', 'parentId', 'updatedAt', 'value'].toSorted(),
      );
      expect(JSON.stringify(created)).not.toContain(secret.id);

      // applying it ties items to the same tag; the tag still follows the Locked rules
      const { asset: photo } = await ctx.newAsset({ ownerId: user.id });
      await expect(sut.bulkTagAssets(auth, { tagIds: [created.id], assetIds: [photo.id] })).resolves.toEqual({
        count: 1,
      });
      await expect(ctx.get(TagRepository).getAssetIds(hidden.id, [photo.id, secret.id])).resolves.toEqual(
        new Set([photo.id, secret.id]),
      );
      await expect(sut.getAll(auth)).resolves.toEqual([]);
      await expect(sut.get(auth, hidden.id)).rejects.toThrow('Tag not found');
      await expect(sut.getStatistics(auth)).resolves.toEqual([]);

      // the unlocked owner sees one tag with both items
      const owner = unlockedAuth(user.id);
      await expect(sut.getAll(owner)).resolves.toEqual([expect.objectContaining({ id: hidden.id, value: 'Alice' })]);
      await expect(sut.getStatistics(owner)).resolves.toEqual([{ id: hidden.id, count: 2, total: 2 }]);
    });

    it('reuses a tag that is only on locked items when a locked session creates or upserts it', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const [onlyLocked] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['Trips/Secret'] });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newTagAsset({ tagIds: [onlyLocked.id], assetIds: [asset.id] });
      await lock(ctx, asset.id);
      const auth = plainLockedAuth(user.id);

      await expect(sut.upsert(auth, { tags: ['Trips/Secret'] })).resolves.toEqual([
        expect.objectContaining({ id: onlyLocked.id, value: 'Trips/Secret' }),
      ]);
      const trips = (await ctx.get(TagRepository).getByValue(user.id, 'Trips'))!;
      // under a parent the session cannot see, the answer is the one for a missing parent
      const hiddenParent = await sut.create(auth, { name: 'Secret', parentId: trips.id }).catch((error) => error);
      const missingParent = await sut
        .create(auth, { name: 'Secret', parentId: '00000000-0000-4000-8000-000000000000' })
        .catch((error) => error);
      expect(hiddenParent).toBeInstanceOf(BadRequestException);
      expect(hiddenParent.getResponse()).toEqual(missingParent.getResponse());
      await expect(sut.create(unlockedAuth(user.id), { name: 'Secret', parentId: trips.id })).resolves.toEqual(
        expect.objectContaining({ id: onlyLocked.id }),
      );
    });

    it('answers a create by an existing visible name with that tag instead of an error', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const first = await sut.create(auth, { name: 'Family', color: '#ff0000' });

      await expect(sut.create(auth, { name: 'Family', color: '#00ff00' })).resolves.toEqual(
        expect.objectContaining({ id: first.id, color: '#ff0000' }),
      );
      await expect(sut.getAll(auth)).resolves.toHaveLength(1);
    });

    it('attaches imported (sidecar) tag names to the existing hidden tag, never a copy', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const [hidden] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['People/Alice'] });

      const imported = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['People/Alice', 'Beach'] });
      expect(imported.map(({ id }) => id)).toContain(hidden.id);
      const rows = await ctx.database.selectFrom('tag').select('value').where('userId', '=', user.id).execute();
      expect(rows.map(({ value }) => value).toSorted()).toEqual(['Beach', 'People', 'People/Alice']);
    });

    it('hides a tag carried only by locked items from a locked session, whatever the lock reason', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tags = await upsertTags(ctx.get(TagRepository), {
        userId: user.id,
        tags: ['marked', 'detected', 'moved', 'mixed', 'empty', 'parent/child'],
      });
      const byValue = new Map(tags.map((tag) => [tag.value, tag]));
      const parent = (await ctx.get(TagRepository).getByValue(user.id, 'parent'))!;
      const newLocked = async (reason: AssetLockReason) => {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await lock(ctx, asset.id, reason);
        return asset;
      };
      const marked = await newLocked(AssetLockReason.Marked);
      const detected = await newLocked(AssetLockReason.Detected);
      const moved = await newLocked(AssetLockReason.ImmichLockedFolder);
      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newTagAsset({ tagIds: [byValue.get('marked')!.id], assetIds: [marked.id] });
      await ctx.newTagAsset({ tagIds: [byValue.get('detected')!.id], assetIds: [detected.id] });
      await ctx.newTagAsset({ tagIds: [byValue.get('moved')!.id], assetIds: [moved.id] });
      await ctx.newTagAsset({ tagIds: [byValue.get('mixed')!.id], assetIds: [marked.id, visible.id] });
      await ctx.newTagAsset({ tagIds: [byValue.get('parent/child')!.id], assetIds: [detected.id] });

      const auth = plainLockedAuth(user.id);
      const listed = (await sut.getAll(auth)).map(({ value }) => value).toSorted();
      // a tag without items stays; one visible item brings a tag back, counted without the hidden one
      expect(listed).toEqual(['empty', 'mixed']);
      for (const value of ['marked', 'detected', 'moved', 'parent/child']) {
        await expect(sut.get(auth, byValue.get(value)!.id), value).rejects.toThrow('Tag not found');
      }
      await expect(sut.get(auth, parent.id)).rejects.toThrow('Tag not found');
      await expect(sut.getStatistics(auth)).resolves.toEqual([{ id: byValue.get('mixed')!.id, count: 1, total: 1 }]);

      const all = (await sut.getAll(unlockedAuth(user.id))).map(({ value }) => value).toSorted();
      expect(all).toEqual(['detected', 'empty', 'marked', 'mixed', 'moved', 'parent', 'parent/child']);
    });

    it('hides a tag carried only by items a Locked rule matches', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tags = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['rule', 'beside-rule', 'open'] });
      const byValue = new Map(tags.map((tag) => [tag.value, tag]));
      const { asset: matched } = await ctx.newAsset({ ownerId: user.id });
      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newTagAsset({
        tagIds: [byValue.get('rule')!.id, byValue.get('beside-rule')!.id],
        assetIds: [matched.id],
      });
      await ctx.newTagAsset({ tagIds: [byValue.get('open')!.id], assetIds: [visible.id] });
      const auth = lockedAuth(user.id, [byValue.get('rule')!.id]);

      await expect(sut.getAll(auth)).resolves.toEqual([expect.objectContaining({ value: 'open' })]);
      await expect(sut.get(auth, byValue.get('beside-rule')!.id)).rejects.toThrow('Tag not found');
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
