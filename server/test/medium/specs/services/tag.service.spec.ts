import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import {
  AssetLockReason,
  AssetVisibility,
  ClassificationMatchDecision,
  ClassificationRuleAction,
  JobStatus,
  SyncEntityType,
  SyncRequestType,
  UserMetadataKey,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetOriginField, PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { TagService } from 'src/services/tag.service.js';
import { asDateTimeString } from 'src/utils/date.js';
import { getPreferences } from 'src/utils/preferences.js';
import { upsertTags } from 'src/utils/tag.js';
import { SyncTestContext, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(TagService, {
    database: db || defaultDatabase,
    // a merge also writes the account's preferences, under their lock, and may ask sessions to sync again
    real: [
      AssetRepository,
      TagRepository,
      AccessRepository,
      SearchRepository,
      DatabaseRepository,
      UserRepository,
      SessionRepository,
    ],
    mock: [EventRepository, LoggingRepository],
  });
};

/** Every closure row that ends at one of these tags, as `ancestor>descendant`. */
const closureOf = (ctx: ReturnType<typeof setup>['ctx'], ids: string[]) =>
  ctx.database
    .selectFrom('tag_closure')
    .select(['id_ancestor', 'id_descendant'])
    .where('id_descendant', 'in', ids)
    .execute()
    .then((rows) => rows.map((row) => `${row.id_ancestor}>${row.id_descendant}`).toSorted());

/** A tag owned by one user, plus another user's auth to attempt access with */
const newTagOfAnotherUser = async (ctx: ReturnType<typeof setup>['ctx']) => {
  const { user } = await ctx.newUser();
  const { user: otherUser } = await ctx.newUser();
  const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['tag-1'] });

  return { tag, auth: factory.auth({ user }), otherAuth: factory.auth({ user: otherUser }) };
};

/** An item captured at this local date and time */
const capturedAt = (dateTime: string) => {
  const date = new Date(dateTime);
  return { localDateTime: date, fileCreatedAt: date };
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
  it.each(['rename', 'merge', 'delete'] as const)(
    'rolls a partner copy’s tag %s back when its override marker cannot be recorded',
    async (action) => {
      const { sut, ctx } = setup();
      const { user: sharer } = await ctx.newUser();
      const { user: recipient } = await ctx.newUser();
      const { asset: original } = await ctx.newAsset({ ownerId: sharer.id });
      const { asset: copy } = await ctx.newAsset({
        ownerId: recipient.id,
        checksum: original.checksum,
        originalPath: original.originalPath,
      });
      const origins = ctx.get(PartnerOriginRepository);
      await origins.createAssetOrigin({
        id: copy.id,
        sourceId: original.id,
        ownerId: recipient.id,
        rootOwnerId: sharer.id,
        partnerSharedById: sharer.id,
      });
      const [tag, target] = await upsertTags(ctx.get(TagRepository), {
        userId: recipient.id,
        tags: ['Choice', 'Target'],
      });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [copy.id] });
      await ctx.newExif({ assetId: copy.id, tags: ['Choice'] });
      const beforeTags = await defaultDatabase
        .selectFrom('tag')
        .select(['id', 'value', 'parentId'])
        .where('userId', '=', recipient.id)
        .orderBy('id')
        .execute();
      const marker = vi.spyOn(origins, 'markOverridden').mockRejectedValueOnce(new Error('override unavailable'));
      ctx.getMock(EventRepository).emit.mockClear();
      const auth = factory.auth({ user: recipient });
      try {
        await expect(
          action === 'rename'
            ? sut.update(auth, tag.id, { name: 'Recipient choice' })
            : action === 'merge'
              ? sut.merge(auth, tag.id, { targetId: target.id })
              : sut.remove(auth, tag.id),
        ).rejects.toThrow('override unavailable');
      } finally {
        marker.mockRestore();
      }
      expect(
        await defaultDatabase
          .selectFrom('tag')
          .select(['id', 'value', 'parentId'])
          .where('userId', '=', recipient.id)
          .orderBy('id')
          .execute(),
      ).toEqual(beforeTags);
      expect(
        await defaultDatabase.selectFrom('tag_asset').select('tagId').where('assetId', '=', copy.id).execute(),
      ).toEqual([{ tagId: tag.id }]);
      expect(
        (
          await defaultDatabase
            .selectFrom('asset_exif')
            .select('tags')
            .where('assetId', '=', copy.id)
            .executeTakeFirstOrThrow()
        ).tags,
      ).toEqual(['Choice']);
      expect((await origins.getOrigin('asset', copy.id))?.overriddenFields).not.toContain(AssetOriginField.Tags);
      expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalled();
    },
  );

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

  describe('merge', () => {
    type Context = ReturnType<typeof setup>['ctx'];

    const newOwner = async (ctx: Context) => {
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      return { user, auth: factory.auth({ user }) };
    };
    /** The tags at these paths, in the order given. */
    const newTags = async (ctx: Context, userId: string, paths: string[]) => {
      await upsertTags(ctx.get(TagRepository), { userId, tags: paths });
      const tags = [];
      for (const path of paths) {
        tags.push((await ctx.get(TagRepository).getByValue(userId, path))!);
      }
      return tags;
    };
    const newAssets = async (ctx: Context, ownerId: string, count: number) => {
      const ids: string[] = [];
      for (let index = 0; index < count; index++) {
        ids.push((await ctx.newAsset({ ownerId })).asset.id);
      }
      return ids;
    };
    const pathsOf = (ctx: Context, userId: string) =>
      ctx.database
        .selectFrom('tag')
        .select(['id', 'value', 'parentId'])
        .where('userId', '=', userId)
        .orderBy('value')
        .execute();
    const itemsOf = (ctx: Context, tagId: string) =>
      ctx.database
        .selectFrom('tag_asset')
        .select('assetId')
        .where('tagId', '=', tagId)
        .execute()
        .then((rows) => rows.map(({ assetId }) => assetId).toSorted());
    const exifOf = (ctx: Context, assetId: string) =>
      ctx.database
        .selectFrom('asset_exif')
        .select(['tags', 'lockedProperties'])
        .where('assetId', '=', assetId)
        .executeTakeFirst();
    const auditedTags = (ctx: Context, ids: string[]) =>
      ctx.database
        .selectFrom('tag_audit')
        .select('tagId')
        .where('tagId', 'in', ids)
        .execute()
        .then((rows) => rows.map(({ tagId }) => tagId).toSorted());
    const auditedItems = (ctx: Context, tagId: string) =>
      ctx.database
        .selectFrom('tag_asset_audit')
        .select('assetId')
        .where('tagId', '=', tagId)
        .execute()
        .then((rows) => rows.map(({ assetId }) => assetId).toSorted());
    /** Everything a merge may touch for one account, to compare before and after a refusal. */
    const snapshot = async (ctx: Context, userId: string) => {
      const tags = await ctx.database
        .selectFrom('tag')
        .select(['id', 'value', 'parentId', 'color', 'updateId'])
        .where('userId', '=', userId)
        .orderBy('id')
        .execute();
      const ids = tags.map(({ id }) => id);
      const items = await ctx.database
        .selectFrom('tag_asset')
        .select(['tagId', 'assetId', 'updateId'])
        .where('tagId', 'in', ids)
        .orderBy('tagId')
        .orderBy('assetId')
        .execute();
      const exif = await ctx.database
        .selectFrom('asset_exif')
        .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
        .select(['asset_exif.assetId', 'asset_exif.tags'])
        .where('asset.ownerId', '=', userId)
        .orderBy('asset_exif.assetId')
        .execute();
      const preferences = await ctx.get(UserRepository).getMetadata(userId);
      return {
        tags,
        items,
        closure: await closureOf(ctx, ids),
        audited: await auditedTags(ctx, ids),
        exif,
        preferences,
      };
    };
    const savePreferences = (ctx: Context, userId: string, value: object) =>
      ctx.get(UserRepository).upsertMetadata(userId, { key: UserMetadataKey.Preferences, value });
    const storedPreferences = async (ctx: Context, userId: string) =>
      getPreferences(await ctx.get(UserRepository).getMetadata(userId));
    const emitted = (ctx: Context) => ctx.getMock(EventRepository).emit.mock.calls.map(([name, data]) => [name, data]);

    it('gives every item the other tag once, whatever its state, and removes the merged tag', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const [hike, outdoors, hiking] = await newTags(ctx, user.id, ['Hike', 'Outdoors', 'Outdoors/Hiking']);
      await ctx.get(TagRepository).update(hiking.id, { color: '#3fb46a' });
      const [onlyHike, both, onlyHiking] = await newAssets(ctx, user.id, 3);
      const { asset: archived } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Archive });
      const { asset: trashed } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const carried = [onlyHike, both, archived.id, trashed.id, locked.id];
      await ctx.newTagAsset({ tagIds: [hike.id], assetIds: carried });
      await ctx.newTagAsset({ tagIds: [hiking.id], assetIds: [both, onlyHiking] });

      // the session that merges cannot see the archived, trashed and Locked items; they move all the same
      await expect(sut.merge(auth, hike.id, { targetId: hiking.id })).resolves.toEqual(
        expect.objectContaining({
          id: hiking.id,
          name: 'Hiking',
          value: 'Outdoors/Hiking',
          parentId: outdoors.id,
          color: '#3fb46a',
        }),
      );

      await expect(pathsOf(ctx, user.id)).resolves.toEqual([
        { id: outdoors.id, value: 'Outdoors', parentId: null },
        { id: hiking.id, value: 'Outdoors/Hiking', parentId: outdoors.id },
      ]);
      await expect(itemsOf(ctx, hiking.id)).resolves.toEqual([...carried, onlyHiking].toSorted());
      await expect(itemsOf(ctx, hike.id)).resolves.toEqual([]);
      await expect(sut.getAll(auth)).resolves.toEqual([
        expect.objectContaining({ id: outdoors.id }),
        expect.objectContaining({ id: hiking.id }),
      ]);
      // Timeline items only, as the Tags screen counts them
      expect((await sut.getStatistics(auth)).find(({ id }) => id === hiking.id)).toMatchObject({ count: 3, total: 3 });

      // what deleting the tag and untagging its items by hand would have recorded
      await expect(auditedTags(ctx, [hike.id])).resolves.toEqual([hike.id]);
      await expect(auditedItems(ctx, hike.id)).resolves.toEqual(carried.toSorted());
      // and what tagging gives an item: its tag list, kept locked so a metadata read cannot bring "Hike" back
      for (const assetId of carried) {
        await expect(exifOf(ctx, assetId), assetId).resolves.toEqual({
          tags: ['Outdoors/Hiking'],
          lockedProperties: ['tags'],
        });
      }
      await expect(exifOf(ctx, onlyHiking)).resolves.toBeUndefined();
      // "tagged" for an item that gained the tag, and only a sidecar write for the one that had both
      expect(emitted(ctx)).toEqual(
        expect.arrayContaining([
          ...[onlyHike, archived.id, trashed.id, locked.id].map((assetId) => [
            'AssetTag',
            { assetId, userId: user.id },
          ]),
          ['AssetUntag', { assetId: both }],
        ]),
      );
      expect(emitted(ctx)).toHaveLength(5);
    });

    it('moves the tags inside under the other tag with their items, paths and closure', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const [trips, rockies, banff, travel, norway] = await newTags(ctx, user.id, [
        'Trips',
        'Trips/Rockies',
        'Trips/Rockies/Banff',
        'Travel',
        'Travel/Norway',
      ]);
      const [onTrips, onRockies, onBanff, onNorway] = await newAssets(ctx, user.id, 4);
      await ctx.newTagAsset({ tagIds: [trips.id], assetIds: [onTrips] });
      await ctx.newTagAsset({ tagIds: [rockies.id], assetIds: [onRockies] });
      await ctx.newTagAsset({ tagIds: [banff.id], assetIds: [onBanff] });
      await ctx.newTagAsset({ tagIds: [norway.id], assetIds: [onNorway] });

      await sut.merge(auth, trips.id, { targetId: travel.id });

      // the same tags, by id, at their new paths
      await expect(pathsOf(ctx, user.id)).resolves.toEqual([
        { id: travel.id, value: 'Travel', parentId: null },
        { id: norway.id, value: 'Travel/Norway', parentId: travel.id },
        { id: rockies.id, value: 'Travel/Rockies', parentId: travel.id },
        { id: banff.id, value: 'Travel/Rockies/Banff', parentId: rockies.id },
      ]);
      await expect(closureOf(ctx, [travel.id, rockies.id, banff.id])).resolves.toEqual(
        [
          `${travel.id}>${travel.id}`,
          `${travel.id}>${rockies.id}`,
          `${rockies.id}>${rockies.id}`,
          `${travel.id}>${banff.id}`,
          `${rockies.id}>${banff.id}`,
          `${banff.id}>${banff.id}`,
        ].toSorted(),
      );
      await expect(
        ctx.database.selectFrom('tag_closure').select('id_ancestor').where('id_ancestor', '=', trips.id).execute(),
      ).resolves.toEqual([]);
      await expect(itemsOf(ctx, travel.id)).resolves.toEqual([onTrips]);
      await expect(itemsOf(ctx, rockies.id)).resolves.toEqual([onRockies]);
      await expect(itemsOf(ctx, banff.id)).resolves.toEqual([onBanff]);

      // as the Tags screen reads them
      expect((await sut.getAll(auth)).map(({ value, parentId }) => [value, parentId])).toEqual([
        ['Travel', undefined],
        ['Travel/Norway', travel.id],
        ['Travel/Rockies', travel.id],
        ['Travel/Rockies/Banff', rockies.id],
      ]);
      const statistics = new Map((await sut.getStatistics(auth)).map((row) => [row.id, row]));
      expect(statistics.size).toBe(4);
      expect(statistics.get(travel.id)).toMatchObject({ count: 1, total: 4 });
      expect(statistics.get(rockies.id)).toMatchObject({ count: 1, total: 2 });
      expect(statistics.get(banff.id)).toMatchObject({ count: 1, total: 1 });
      expect(statistics.get(norway.id)).toMatchObject({ count: 1, total: 1 });

      // an item whose tag only took a new path has its tag list and sidecar brought up to date too
      await expect(exifOf(ctx, onRockies)).resolves.toEqual({ tags: ['Travel/Rockies'], lockedProperties: ['tags'] });
      await expect(exifOf(ctx, onBanff)).resolves.toEqual({
        tags: ['Travel/Rockies/Banff'],
        lockedProperties: ['tags'],
      });
      expect(emitted(ctx)).toEqual(
        expect.arrayContaining([
          ['AssetTag', { assetId: onTrips, userId: user.id }],
          ['AssetUntag', { assetId: onRockies }],
          ['AssetUntag', { assetId: onBanff }],
        ]),
      );
      expect(emitted(ctx)).toHaveLength(3);
      await expect(auditedTags(ctx, [trips.id, rockies.id, banff.id])).resolves.toEqual([trips.id]);
    });

    it('merges a tag that meets one of its own name there, all the way down', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const [old, oldCanada, oldBanff, oldJasper, oldJapan] = await newTags(ctx, user.id, [
        'Old',
        'Old/Canada',
        'Old/Canada/Banff',
        'Old/Canada/Jasper',
        'Old/Japan',
      ]);
      const [fresh, canada, banff, yoho] = await newTags(ctx, user.id, [
        'New',
        'New/Canada',
        'New/Canada/Banff',
        'New/Canada/Yoho',
      ]);
      const [inOldCanada, inOldBanff, inBothBanffs, inBanff, inOldJasper] = await newAssets(ctx, user.id, 5);
      await ctx.newTagAsset({ tagIds: [oldCanada.id], assetIds: [inOldCanada] });
      await ctx.newTagAsset({ tagIds: [oldBanff.id], assetIds: [inOldBanff, inBothBanffs] });
      await ctx.newTagAsset({ tagIds: [banff.id], assetIds: [inBothBanffs, inBanff] });
      await ctx.newTagAsset({ tagIds: [oldJasper.id], assetIds: [inOldJasper] });

      await sut.merge(auth, old.id, { targetId: fresh.id });

      // one Canada and one Banff: the ones that were there; Jasper and Japan moved in as they were
      await expect(pathsOf(ctx, user.id)).resolves.toEqual([
        { id: fresh.id, value: 'New', parentId: null },
        { id: canada.id, value: 'New/Canada', parentId: fresh.id },
        { id: banff.id, value: 'New/Canada/Banff', parentId: canada.id },
        { id: oldJasper.id, value: 'New/Canada/Jasper', parentId: canada.id },
        { id: yoho.id, value: 'New/Canada/Yoho', parentId: canada.id },
        { id: oldJapan.id, value: 'New/Japan', parentId: fresh.id },
      ]);
      await expect(itemsOf(ctx, canada.id)).resolves.toEqual([inOldCanada]);
      await expect(itemsOf(ctx, banff.id)).resolves.toEqual([inOldBanff, inBothBanffs, inBanff].toSorted());
      await expect(itemsOf(ctx, oldJasper.id)).resolves.toEqual([inOldJasper]);
      await expect(closureOf(ctx, [oldJasper.id, oldJapan.id])).resolves.toEqual(
        [
          `${fresh.id}>${oldJasper.id}`,
          `${canada.id}>${oldJasper.id}`,
          `${oldJasper.id}>${oldJasper.id}`,
          `${fresh.id}>${oldJapan.id}`,
          `${oldJapan.id}>${oldJapan.id}`,
        ].toSorted(),
      );
      await expect(auditedTags(ctx, [old.id, oldCanada.id, oldBanff.id, oldJasper.id, oldJapan.id])).resolves.toEqual(
        [old.id, oldCanada.id, oldBanff.id].toSorted(),
      );
      await expect(exifOf(ctx, inBothBanffs)).resolves.toEqual({
        tags: ['New/Canada/Banff'],
        lockedProperties: ['tags'],
      });
      expect((await sut.getStatistics(auth)).find(({ id }) => id === fresh.id)?.total).toBe(5);
    });

    it('merges a tag into a tag above it, even when a tag inside it takes over its path', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const [trips, year, sameName, summer, tripsSummer, deep] = await newTags(ctx, user.id, [
        'Trips',
        'Trips/2019',
        'Trips/2019/2019',
        'Trips/2019/Summer',
        'Trips/Summer',
        'Trips/2019/2019/Deep',
      ]);
      const [onYear, onSameName, onSummer, onTripsSummer] = await newAssets(ctx, user.id, 4);
      await ctx.newTagAsset({ tagIds: [year.id], assetIds: [onYear] });
      await ctx.newTagAsset({ tagIds: [sameName.id], assetIds: [onSameName] });
      await ctx.newTagAsset({ tagIds: [summer.id], assetIds: [onSummer] });
      await ctx.newTagAsset({ tagIds: [tripsSummer.id], assetIds: [onTripsSummer] });

      await expect(sut.merge(auth, year.id, { targetId: trips.id })).resolves.toEqual(
        expect.objectContaining({ id: trips.id, value: 'Trips' }),
      );

      // "Trips/2019" is now the tag that was inside it, with what it held; the two Summers are one
      await expect(pathsOf(ctx, user.id)).resolves.toEqual([
        { id: trips.id, value: 'Trips', parentId: null },
        { id: sameName.id, value: 'Trips/2019', parentId: trips.id },
        { id: deep.id, value: 'Trips/2019/Deep', parentId: sameName.id },
        { id: tripsSummer.id, value: 'Trips/Summer', parentId: trips.id },
      ]);
      await expect(itemsOf(ctx, trips.id)).resolves.toEqual([onYear]);
      await expect(itemsOf(ctx, sameName.id)).resolves.toEqual([onSameName]);
      await expect(itemsOf(ctx, tripsSummer.id)).resolves.toEqual([onSummer, onTripsSummer].toSorted());
      await expect(closureOf(ctx, [sameName.id, deep.id])).resolves.toEqual(
        [
          `${trips.id}>${sameName.id}`,
          `${sameName.id}>${sameName.id}`,
          `${trips.id}>${deep.id}`,
          `${sameName.id}>${deep.id}`,
          `${deep.id}>${deep.id}`,
        ].toSorted(),
      );
      await expect(exifOf(ctx, onSameName)).resolves.toEqual({ tags: ['Trips/2019'], lockedProperties: ['tags'] });
      await expect(exifOf(ctx, onYear)).resolves.toEqual({ tags: ['Trips'], lockedProperties: ['tags'] });
    });

    it("refuses a merge into the tag itself, a tag inside it, or anything but the caller's own tags, and changes nothing", async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const [parent, child, grandchild, other] = await newTags(ctx, user.id, [
        'Parent',
        'Parent/Child',
        'Parent/Child/Grandchild',
        'Other',
      ]);
      const [asset] = await newAssets(ctx, user.id, 1);
      await ctx.newTagAsset({ tagIds: [parent.id, grandchild.id], assetIds: [asset] });
      const { user: stranger } = await ctx.newUser();
      const strangerAuth = factory.auth({ user: stranger });
      const [theirs] = await newTags(ctx, stranger.id, ['Theirs']);
      const before = await snapshot(ctx, user.id);
      const theirsBefore = await snapshot(ctx, stranger.id);

      const refusal = (promise: Promise<unknown>) => promise.then(() => null).catch((error) => error);
      const own = 'A tag cannot be merged into itself or one of its descendants';
      for (const targetId of [parent.id, child.id, grandchild.id]) {
        const error = await refusal(sut.merge(auth, parent.id, { targetId }));
        expect(error, targetId).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe(own);
      }

      // somebody else's tag, in either place, answers exactly like an id that does not exist
      const missing = '00000000-0000-4000-8000-000000000000';
      const notFound = await refusal(sut.merge(auth, parent.id, { targetId: missing }));
      expect(notFound).toBeInstanceOf(NotFoundException);
      for (const attempt of [
        () => sut.merge(auth, parent.id, { targetId: theirs.id }),
        () => sut.merge(auth, theirs.id, { targetId: other.id }),
        () => sut.merge(auth, missing, { targetId: other.id }),
        () => sut.merge(strangerAuth, parent.id, { targetId: theirs.id }),
        () => sut.merge(strangerAuth, theirs.id, { targetId: other.id }),
      ]) {
        const error = await refusal(attempt());
        expect(error).toBeInstanceOf(NotFoundException);
        expect(error.getResponse()).toEqual(notFound.getResponse());
      }

      await expect(snapshot(ctx, user.id)).resolves.toEqual(before);
      await expect(snapshot(ctx, stranger.id)).resolves.toEqual(theirsBefore);
      expect(emitted(ctx)).toEqual([]);
    });

    it('rolls the whole merge back when a later step of the same transaction fails', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const [from, inside, into, twin] = await newTags(ctx, user.id, ['From', 'From/Inside', 'Into', 'Into/Inside']);
      const [first, second] = await newAssets(ctx, user.id, 2);
      await ctx.newTagAsset({ tagIds: [from.id], assetIds: [first] });
      await ctx.newTagAsset({ tagIds: [inside.id], assetIds: [second] });
      // a Locked rule on the merged tag, so the merge has preferences to write after the tags
      await savePreferences(ctx, user.id, { privacy: { suppression: { tagIds: [from.id] } } });
      const before = await snapshot(ctx, user.id);
      const write = vi.spyOn(ctx.get(UserRepository), 'upsertMetadata').mockRejectedValueOnce(new Error('disk full'));

      await expect(sut.merge(auth, from.id, { targetId: into.id })).rejects.toThrow('disk full');
      expect(write).toHaveBeenCalledTimes(1);
      write.mockRestore();

      await expect(snapshot(ctx, user.id)).resolves.toEqual(before);
      await expect(itemsOf(ctx, into.id)).resolves.toEqual([]);
      await expect(itemsOf(ctx, twin.id)).resolves.toEqual([]);
      await expect(auditedItems(ctx, from.id)).resolves.toEqual([]);
      expect(emitted(ctx)).toEqual([]);
    });

    it('moves a Locked rule and a saved search to the tag merged into, and has every session sync again', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const { session } = await ctx.newSession({ userId: user.id });
      const [secret, family, other] = await newTags(ctx, user.id, ['Private', 'Family', 'Other']);
      const [hidden, shown] = await newAssets(ctx, user.id, 2);
      await ctx.newTagAsset({ tagIds: [secret.id], assetIds: [hidden] });
      await ctx.newTagAsset({ tagIds: [family.id], assetIds: [shown] });
      await savePreferences(ctx, user.id, {
        tags: { sidebarWeb: false },
        privacy: { suppression: { tagIds: [secret.id, other.id], scope: 'visible' } },
        savedSearches: [
          { name: 'Both', query: { tagIds: [secret.id, family.id], isFavorite: true } },
          { name: 'Nested', query: { any: [{ tagIds: [secret.id.toUpperCase()] }, { city: 'Banff' }] } },
          { name: 'Untouched', query: { tagIds: [other.id] } },
        ],
      });

      await sut.merge(auth, secret.id, { targetId: family.id });

      const preferences = await storedPreferences(ctx, user.id);
      // the rule follows, so nothing it hid is shown because of the merge; the rest of the preferences stay
      expect(preferences.privacy.suppression).toEqual({
        tagIds: [family.id, other.id],
        personIds: [],
        petIds: [],
        scope: 'visible',
      });
      expect(preferences.tags.sidebarWeb).toBe(false);
      expect(preferences.savedSearches).toEqual([
        { name: 'Both', query: { tagIds: [family.id], isFavorite: true } },
        { name: 'Nested', query: { any: [{ tagIds: [family.id] }, { city: 'Banff' }] } },
        { name: 'Untouched', query: { tagIds: [other.id] } },
      ]);
      await expect(
        ctx.database.selectFrom('session').select('isPendingSyncReset').where('id', '=', session.id).execute(),
      ).resolves.toEqual([{ isPendingSyncReset: true }]);

      // a session that is not unlocked sees neither the tag nor the items, the one that was open before included
      const locked = lockedAuth(user.id, preferences.privacy.suppression.tagIds);
      await expect(sut.getAll(locked)).resolves.toEqual([]);
      await expect(sut.get(locked, family.id)).rejects.toThrow('Tag not found');
      await expect(sut.getStatistics(locked)).resolves.toEqual([]);
    });

    it('leaves the preferences and the sessions alone when nothing names a merged tag', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const { session } = await ctx.newSession({ userId: user.id });
      const [from, into, other] = await newTags(ctx, user.id, ['From', 'Into', 'Other']);
      await savePreferences(ctx, user.id, {
        privacy: { suppression: { tagIds: [other.id] } },
        savedSearches: [{ name: 'Into', query: { tagIds: [into.id] } }],
      });
      const stored = () =>
        ctx.database
          .selectFrom('user_metadata')
          .select(['value', 'updateId'])
          .where('userId', '=', user.id)
          .where('key', '=', UserMetadataKey.Preferences)
          .executeTakeFirstOrThrow();
      const before = await stored();

      await sut.merge(auth, from.id, { targetId: into.id });

      await expect(stored()).resolves.toEqual(before);
      await expect(
        ctx.database.selectFrom('session').select('isPendingSyncReset').where('id', '=', session.id).execute(),
      ).resolves.toEqual([{ isPendingSyncReset: false }]);
    });

    it('keeps what a Locked rule hid hidden when a session that is not unlocked merges around it', async () => {
      const { sut, ctx } = setup();
      const { user } = await newOwner(ctx);
      const [album, hiddenChild, shelf, twin] = await newTags(ctx, user.id, [
        'Album',
        'Album/Secret',
        'Shelf',
        'Shelf/Secret',
      ]);
      const [secretItem, openItem] = await newAssets(ctx, user.id, 2);
      await ctx.newTagAsset({ tagIds: [hiddenChild.id], assetIds: [secretItem] });
      await ctx.newTagAsset({ tagIds: [album.id], assetIds: [openItem] });
      await savePreferences(ctx, user.id, { privacy: { suppression: { tagIds: [hiddenChild.id] } } });
      const locked = lockedAuth(user.id, [hiddenChild.id]);
      // the session sees "Album" but not the tag inside it, and can make a tag of the same name elsewhere
      expect((await sut.getAll(locked)).map(({ value }) => value)).toEqual(['Album', 'Shelf', 'Shelf/Secret']);

      await sut.merge(locked, album.id, { targetId: shelf.id });

      // the hidden tag met the one of its name: its items are on that tag now, and so is its rule
      await expect(itemsOf(ctx, twin.id)).resolves.toEqual([secretItem]);
      const { suppression } = (await storedPreferences(ctx, user.id)).privacy;
      expect(suppression.tagIds).toEqual([twin.id]);
      const after = lockedAuth(user.id, suppression.tagIds);
      expect((await sut.getAll(after)).map(({ value }) => value)).toEqual(['Shelf']);
      expect(await sut.getStatistics(after)).toEqual([
        expect.objectContaining({ id: shelf.id, count: 1, total: 1, coverAssetIds: [openItem] }),
      ]);
    });

    it('points smart album rules at the tag merged into', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const [from, into, third, added] = await newTags(ctx, user.id, ['From', 'Into', 'Third', 'Added']);
      const [asset] = await newAssets(ctx, user.id, 1);
      const rules = ctx.get(ClassificationRepository);
      const newRule = async (values: { tagIds: string[]; tagId: string | null }) => {
        const { album } = await ctx.newAlbum({ ownerId: user.id });
        const rule = await rules.createRule({
          ownerId: user.id,
          albumId: album.id,
          action: values.tagId ? ClassificationRuleAction.Tag : ClassificationRuleAction.Review,
          ...values,
        });
        await ctx.database
          .insertInto('classification_match')
          .values({
            ruleId: rule.id,
            assetId: asset,
            decision: ClassificationMatchDecision.Matched,
            tagContributed: !!values.tagId,
          })
          .execute();
        return rule.id;
      };
      const matchesOn = await newRule({ tagIds: [from.id, third.id, into.id], tagId: null });
      const adds = await newRule({ tagIds: [third.id], tagId: from.id });
      const wouldFeedItself = await newRule({ tagIds: [into.id], tagId: from.id });
      const matchesOnAndAdds = await newRule({ tagIds: [from.id], tagId: into.id });
      const untouched = await newRule({ tagIds: [third.id], tagId: added.id });
      const read = async (id: string) => {
        const rule = await ctx.database
          .selectFrom('classification_rule')
          .select(['tagIds', 'tagId', 'updatedAt'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        const match = await ctx.database
          .selectFrom('classification_match')
          .select('tagContributed')
          .where('ruleId', '=', id)
          .executeTakeFirstOrThrow();
        return { ...rule, ...match };
      };
      const untouchedBefore = await read(untouched);

      await sut.merge(auth, from.id, { targetId: into.id });

      // a rule that matched on the merged tag matches on the other one, named once
      await expect(read(matchesOn)).resolves.toMatchObject({ tagIds: [into.id, third.id], tagId: null });
      // a rule that added it adds the other one, and no longer answers for the tags it added before
      await expect(read(adds)).resolves.toMatchObject({ tagIds: [third.id], tagId: into.id, tagContributed: false });
      // a rule may not add the tag it matches on: it stops adding one, as when its tag is deleted
      await expect(read(wouldFeedItself)).resolves.toMatchObject({
        tagIds: [into.id],
        tagId: null,
        tagContributed: false,
      });
      await expect(read(matchesOnAndAdds)).resolves.toMatchObject({
        tagIds: [into.id],
        tagId: null,
        tagContributed: false,
      });
      await expect(read(untouched)).resolves.toEqual(untouchedBefore);
    });

    it('reaches a device as the tag deleted, the tags inside it changed and its items retagged', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const sync = new SyncTestContext(defaultDatabase);
      const { auth, user } = await sync.newSyncAuthUser();
      const [old, kept, fresh] = await newTags(ctx, user.id, ['Old', 'Old/Kept', 'New']);
      const [onOld, onKept, onBoth] = await newAssets(ctx, user.id, 3);
      await ctx.newTagAsset({ tagIds: [old.id], assetIds: [onOld, onBoth] });
      await ctx.newTagAsset({ tagIds: [kept.id], assetIds: [onKept] });
      await ctx.newTagAsset({ tagIds: [fresh.id], assetIds: [onBoth] });
      const types = [SyncRequestType.TagsV1, SyncRequestType.AssetTagsV1];
      await sync.syncAckAll(auth, await sync.syncStream(auth, types));
      await sync.assertSyncIsComplete(auth, types);

      await sut.merge(auth, old.id, { targetId: fresh.id });

      const changes = (await sync.syncStream(auth, types))
        .filter(({ type }) => type !== SyncEntityType.SyncCompleteV1)
        .map(({ type, data }) => [type, data]);
      expect(changes).toEqual(
        expect.arrayContaining([
          [SyncEntityType.TagDeleteV1, { tagId: old.id }],
          [SyncEntityType.TagV1, expect.objectContaining({ id: kept.id, value: 'New/Kept', parentId: fresh.id })],
          [SyncEntityType.AssetTagDeleteV1, { tagId: old.id, assetId: onOld }],
          [SyncEntityType.AssetTagDeleteV1, { tagId: old.id, assetId: onBoth }],
          [SyncEntityType.AssetTagV1, { tagId: fresh.id, assetId: onOld }],
        ]),
      );
      // nothing else: the tag merged into and the items that stayed where they were are not sent again
      expect(changes).toHaveLength(5);
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

      const { asset: onTrip } = await ctx.newAsset({ ownerId: user.id, ...capturedAt('2024-06-01T10:00:00.000Z') });
      const { asset: onTripToo } = await ctx.newAsset({ ownerId: user.id, ...capturedAt('2025-01-15T08:00:00.000Z') });
      const { asset: tripsOnly } = await ctx.newAsset({ ownerId: user.id, ...capturedAt('2026-03-09T12:00:00.000Z') });
      // the newest and the oldest captures are the ones that never count: neither may lead a cover or move a date
      const { asset: archived } = await ctx.newAsset({
        ownerId: user.id,
        visibility: AssetVisibility.Archive,
        ...capturedAt('2030-01-01T00:00:00.000Z'),
      });
      const { asset: trashed } = await ctx.newAsset({
        ownerId: user.id,
        deletedAt: new Date(),
        ...capturedAt('2000-01-01T00:00:00.000Z'),
      });
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, ...capturedAt('2010-05-05T09:00:00.000Z') });
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
          // trips: two items tagged "trips" itself; three distinct items with "trips/rockies", and the
          // one carrying both tags is on the cover once
          {
            id: trips.id,
            count: 2,
            total: 3,
            coverAssetIds: [tripsOnly.id, onTripToo.id, onTrip.id],
            startDate: '2024-06-01T00:00:00.000Z',
            endDate: '2026-03-09T00:00:00.000Z',
          },
          {
            id: rockies.id,
            count: 2,
            total: 2,
            coverAssetIds: [onTripToo.id, onTrip.id],
            startDate: '2024-06-01T00:00:00.000Z',
            endDate: '2025-01-15T00:00:00.000Z',
          },
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
          {
            id: trips.id,
            count: 2,
            total: 4,
            coverAssetIds: [tripsOnly.id, onTripToo.id, onTrip.id, locked.id],
            startDate: '2010-05-05T00:00:00.000Z',
            endDate: '2026-03-09T00:00:00.000Z',
          },
          {
            id: rockies.id,
            count: 3,
            total: 3,
            coverAssetIds: [onTripToo.id, onTrip.id, locked.id],
            startDate: '2010-05-05T00:00:00.000Z',
            endDate: '2025-01-15T00:00:00.000Z',
          },
        ]),
      );
    });

    it('leaves out a suppressed tag, the tags under it and hidden items while the session is locked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tags = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['private/nested', 'public'] });
      const byValue = new Map(tags.map((tag) => [tag.value, tag]));
      const parent = (await ctx.get(TagRepository).getByValue(user.id, 'private'))!;
      // the hidden item is the newer capture, so it would lead the cover and end the dates if it counted
      const { asset: privateAsset } = await ctx.newAsset({
        ownerId: user.id,
        ...capturedAt('2026-03-09T12:00:00.000Z'),
      });
      const { asset: publicAsset } = await ctx.newAsset({
        ownerId: user.id,
        ...capturedAt('2024-06-01T10:00:00.000Z'),
      });
      await ctx.newTagAsset({ tagIds: [byValue.get('private/nested')!.id], assetIds: [privateAsset.id] });
      // an item that also carries the suppressed tag is hidden, so it never counts for "public"
      await ctx.newTagAsset({ tagIds: [byValue.get('public')!.id], assetIds: [privateAsset.id, publicAsset.id] });

      await expect(sut.getStatistics(lockedAuth(user.id, [parent.id]))).resolves.toEqual([
        {
          id: byValue.get('public')!.id,
          count: 1,
          total: 1,
          coverAssetIds: [publicAsset.id],
          startDate: '2024-06-01T00:00:00.000Z',
          endDate: '2024-06-01T00:00:00.000Z',
        },
      ]);
    });

    it("covers a tag with its four newest captures, its subtags' included, in a stable order", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const tags = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['travel/canada/banff'] });
      const banff = tags[0];
      const canada = (await ctx.get(TagRepository).getByValue(user.id, 'travel/canada'))!;
      const travel = (await ctx.get(TagRepository).getByValue(user.id, 'travel'))!;

      const newAssetAt = async (dateTime: string) => {
        const { asset } = await ctx.newAsset({ ownerId: user.id, ...capturedAt(dateTime) });
        return asset.id;
      };
      const oldest = await newAssetAt('2021-07-04T09:00:00.000Z');
      const old = await newAssetAt('2022-07-04T09:00:00.000Z');
      const middle = await newAssetAt('2023-07-04T09:00:00.000Z');
      // two captures in the same instant: the lower id comes first
      const [tiedFirst, tiedSecond] = [
        await newAssetAt('2024-07-04T09:00:00.000Z'),
        await newAssetAt('2024-07-04T09:00:00.000Z'),
      ].toSorted();
      const newest = await newAssetAt('2025-07-04T09:00:00.000Z');
      await ctx.newTagAsset({ tagIds: [banff.id], assetIds: [oldest, middle, tiedSecond, newest] });
      await ctx.newTagAsset({ tagIds: [canada.id], assetIds: [old, tiedFirst] });

      const statistics = await sut.getStatistics(factory.auth({ user }));
      const byId = new Map(statistics.map((row) => [row.id, row]));
      expect(statistics).toHaveLength(3);
      expect(byId.get(banff.id)).toEqual({
        id: banff.id,
        count: 4,
        total: 4,
        coverAssetIds: [newest, tiedSecond, middle, oldest],
        startDate: '2021-07-04T00:00:00.000Z',
        endDate: '2025-07-04T00:00:00.000Z',
      });
      // six items through the closure, four on the cover
      const nested = {
        total: 6,
        coverAssetIds: [newest, tiedFirst, tiedSecond, middle],
        startDate: '2021-07-04T00:00:00.000Z',
        endDate: '2025-07-04T00:00:00.000Z',
      };
      expect(byId.get(canada.id)).toEqual({ id: canada.id, count: 2, ...nested });
      expect(byId.get(travel.id)).toEqual({ id: travel.id, count: 0, ...nested });
    });

    it('dates a tag by the local capture day, exactly as an album of the same items is dated', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['evenings'] });
      // late evening where it was taken, already the next day in UTC
      const { asset: first } = await ctx.newAsset({
        ownerId: user.id,
        localDateTime: new Date('2024-06-01T23:30:00.000Z'),
        fileCreatedAt: new Date('2024-06-02T06:30:00.000Z'),
      });
      const { asset: last } = await ctx.newAsset({
        ownerId: user.id,
        localDateTime: new Date('2024-12-31T23:59:00.000Z'),
        fileCreatedAt: new Date('2025-01-01T04:59:00.000Z'),
      });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [first.id, last.id] });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [first.id, last.id]);

      const [statistics] = await sut.getStatistics(factory.auth({ user }));
      expect(statistics).toMatchObject({
        id: tag.id,
        coverAssetIds: [last.id, first.id],
        startDate: '2024-06-01T00:00:00.000Z',
        endDate: '2024-12-31T00:00:00.000Z',
      });

      const [metadata] = await ctx.get(AlbumRepository).getMetadataForIds([album.id]);
      expect(statistics.startDate).toBe(asDateTimeString(metadata.startDate));
      expect(statistics.endDate).toBe(asDateTimeString(metadata.endDate));
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
      const [statistics, ...others] = await sut.getStatistics(owner);
      expect(others).toEqual([]);
      expect(statistics).toMatchObject({ id: hidden.id, count: 2, total: 2 });
      expect(statistics.coverAssetIds.toSorted()).toEqual([photo.id, secret.id].toSorted());
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
      const moved = await newLocked(AssetLockReason.FrameleafLockedFolder);
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
      // its cover is the visible item alone, never the locked one beside it
      await expect(sut.getStatistics(auth)).resolves.toEqual([
        expect.objectContaining({ id: byValue.get('mixed')!.id, count: 1, total: 1, coverAssetIds: [visible.id] }),
      ]);

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
