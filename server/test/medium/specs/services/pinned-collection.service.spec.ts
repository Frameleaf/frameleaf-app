import { ConflictException } from '@nestjs/common';
import type { StoredPinnedCollection } from 'src/dtos/pinned-collection.dto.js';
import type { MemoryService } from 'src/services/memory.service.js';
import type { PersonService } from 'src/services/person.service.js';
import type { PetService } from 'src/services/pet.service.js';
import { AssetVisibility, SyncEntityType, SyncRequestType, UserMetadataKey } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { PinnedCollectionService } from 'src/services/pinned-collection.service.js';
import { SearchService } from 'src/services/search.service.js';
import { UserService } from 'src/services/user.service.js';
import { SyncTestContext, newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

const setup = async () => {
  const database = await getActiveForkKyselyDB();
  const ctx = new SyncTestContext(database);
  const { auth, user } = await ctx.newSyncAuthUser();
  const albums = newMediumService(AlbumService, {
    database,
    real: [
      AccessRepository,
      AlbumRepository,
      AssetRepository,
      ClassificationRepository,
      MapRepository,
      PartnerRepository,
      SmartAlbumRepository,
      TagRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository],
  }).sut;
  const search = newMediumService(SearchService, {
    database,
    real: [
      AccessRepository,
      AssetRepository,
      DatabaseRepository,
      SearchRepository,
      PartnerRepository,
      PersonRepository,
      TagRepository,
    ],
    mock: [LoggingRepository],
  }).sut;
  const preferences = newMediumService(UserService, {
    database,
    real: [UserRepository, AccessRepository],
    mock: [LoggingRepository],
  }).sut;
  const users = ctx.get(UserRepository);
  const pins = new PinnedCollectionService(
    users,
    albums,
    {} as PersonService,
    {} as PetService,
    {} as MemoryService,
    search,
    preferences,
  );
  Object.assign(ctx.sut, { pins });
  return { ctx, auth, user, users, pins };
};

const ref = (kind: StoredPinnedCollection['kind'], targetId: string): StoredPinnedCollection => ({
  id: newUuid(),
  kind,
  targetId,
});

describe('FL-232 ordered pins and replacement sync', () => {
  it('counts only unstacked structured matches and returns zero with no cover when all matches are stacked', async () => {
    const { ctx, auth, user, users, pins } = await setup();
    const { asset: first } = await ctx.newAsset({ ownerId: user.id });
    const { asset: second } = await ctx.newAsset({ ownerId: user.id });
    const { asset: unstacked } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newStack({ ownerId: user.id }, [first.id, second.id]);
    await users.upsertMetadata(user.id, {
      key: UserMetadataKey.Preferences,
      value: { savedSearches: [{ name: 'Unstacked', query: { filter: {}, withStacked: false } }] },
    });
    const firstSnapshot = await pins.set(auth, {
      expectedRevision: null,
      pins: [ref('saved-search', 'Unstacked')],
    });
    expect(firstSnapshot.pins[0]).toMatchObject({ count: 1, coverAssetId: unstacked.id, unavailable: false });
    await ctx.database.deleteFrom('asset').where('id', '=', unstacked.id).execute();
    const empty = await pins.get(auth);
    expect(empty.revision).toBe(firstSnapshot.revision);
    expect(empty.pins[0]).toMatchObject({ count: 0, coverAssetId: null, unavailable: false });
  });

  it('clears Locked hydration on an acknowledged snapshot when the session loses elevation', async () => {
    const { ctx, auth, user, pins } = await setup();
    const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
    const unlocked = { ...auth, session: { ...auth.session!, hasElevatedPermission: true } };
    const pin = ref('builtin', 'locked');
    const first = await pins.set(unlocked, { expectedRevision: null, pins: [pin] });
    expect(first.pins[0]).toMatchObject({ count: 1, coverAssetId: asset.id, unavailable: false });
    const initial = await ctx.syncStream(unlocked, [SyncRequestType.PinnedCollectionsV1]);
    await ctx.syncAckAll(unlocked, initial);
    expect((await ctx.syncStream(auth, [SyncRequestType.PinnedCollectionsV1]))[0]).toMatchObject({
      data: {
        revision: first.revision,
        pins: [{ id: pin.id, unavailable: true, title: null, count: null, coverAssetId: null, targetId: null }],
      },
    });
    const cleared = await pins.set(auth, { expectedRevision: first.revision, pins: [] });
    const response = await ctx.syncStream(auth, [SyncRequestType.PinnedCollectionsV1]);
    expect(response[0]).toMatchObject({ data: { revision: cleared.revision, pins: [] } });
    await ctx.syncAckAll(auth, response);
    expect((await ctx.syncStream(auth, [SyncRequestType.PinnedCollectionsV1]))[0]).toMatchObject({
      data: { pins: [] },
    });
  });

  it('counts legacy saved searches with exactly their cover predicate, including filename and shared album access', async () => {
    const { ctx, auth, user, users, pins } = await setup();
    const { asset: match } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'needle.jpg' });
    await ctx.newAsset({ ownerId: user.id, originalFileName: 'other.jpg' });
    const { user: owner } = await ctx.newUser();
    const { asset: shared } = await ctx.newAsset({ ownerId: owner.id });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [shared.id]);
    await ctx.newAlbumUser({ albumId: album.id, userId: user.id });
    await users.upsertMetadata(user.id, {
      key: UserMetadataKey.Preferences,
      value: {
        savedSearches: [
          { name: 'Filename', query: { originalFileName: 'needle.jpg' } },
          { name: 'Shared', query: { albumIds: [album.id] } },
        ],
      },
    });
    const saved = await pins.set(auth, {
      expectedRevision: null,
      pins: [ref('saved-search', 'Filename'), ref('saved-search', 'Shared')],
    });
    expect(saved.pins[0]).toMatchObject({ title: 'Filename', count: 1, coverAssetId: match.id });
    expect(saved.pins[1]).toMatchObject({ title: 'Shared', count: 1, coverAssetId: shared.id });
    await ctx.database.deleteFrom('album_user').where('albumId', '=', album.id).where('userId', '=', user.id).execute();
    expect((await pins.get(auth)).pins[1]).toMatchObject({
      unavailable: true,
      title: null,
      count: null,
      coverAssetId: null,
    });
  });

  it('preserves mixed order, removes entries, and rejects both stale concurrent writes and cross-owner revisions', async () => {
    const { ctx, auth, user, users, pins } = await setup();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const refs = [ref('album', album.id), ref('builtin', 'favourites')];
    const first = await pins.set(auth, { expectedRevision: null, pins: refs });
    expect(first.pins.map(({ id }) => id)).toEqual(refs.map(({ id }) => id));
    const outcomes = await Promise.all([
      users.setPinnedCollections(user.id, refs.toReversed(), first.revision),
      users.setPinnedCollections(user.id, [], first.revision),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const stored = await users.getPinnedCollections(user.id);
    expect(stored?.value.pins).toEqual(outcomes[0] ? refs.toReversed() : []);
    const removed = await pins.set(auth, { expectedRevision: stored!.updateId, pins: [refs[1]] });
    expect(removed.pins.map(({ id }) => id)).toEqual([refs[1].id]);
    await expect(pins.set(auth, { expectedRevision: first.revision, pins: [] })).rejects.toBeInstanceOf(
      ConflictException,
    );
    const { auth: other } = await ctx.newSyncAuthUser();
    await expect(pins.set(other, { expectedRevision: removed.revision, pins: [] })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await users.getPinnedCollections(other.user.id)).toBeUndefined();
    await ctx.database
      .deleteFrom('user_metadata')
      .where('userId', '=', user.id)
      .where('key', '=', UserMetadataKey.PinnedCollections)
      .execute();
    expect(await users.setPinnedCollections(user.id, refs, removed.revision)).toBeUndefined();
    expect(await users.getPinnedCollections(user.id)).toBeUndefined();
    const initial = await Promise.all([
      users.setPinnedCollections(user.id, refs, null),
      users.setPinnedCollections(user.id, [], null),
    ]);
    expect(initial.filter(Boolean)).toHaveLength(1);
  });

  it('replaces acknowledged hydration after sharing is revoked and after album deletion without changing the pin revision', async () => {
    const { ctx, auth, users, pins } = await setup();
    const { user: owner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { album } = await ctx.newAlbum(
      { ownerId: owner.id, albumName: 'Private title', albumThumbnailAssetId: asset.id },
      [asset.id],
    );
    await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id });
    const pin = ref('album', album.id);
    const first = await pins.set(auth, { expectedRevision: null, pins: [pin] });
    expect(first.pins[0]).toMatchObject({
      title: 'Private title',
      count: 1,
      coverAssetId: asset.id,
      unavailable: false,
    });
    const initial = await ctx.syncStream(auth, [SyncRequestType.PinnedCollectionsV1]);
    expect(initial[0]).toMatchObject({
      type: SyncEntityType.PinnedCollectionsV1,
      data: { revision: first.revision, pins: first.pins },
    });
    await ctx.syncAckAll(auth, initial);
    await ctx.database
      .deleteFrom('album_user')
      .where('albumId', '=', album.id)
      .where('userId', '=', auth.user.id)
      .execute();
    const lost = await ctx.syncStream(auth, [SyncRequestType.PinnedCollectionsV1]);
    const unavailable = {
      id: pin.id,
      kind: pin.kind,
      targetId: null,
      unavailable: true,
      title: null,
      count: null,
      countCapped: false,
      coverAssetId: null,
    };
    expect(lost[0]).toMatchObject({ data: { revision: first.revision, pins: [unavailable] } });
    expect(JSON.stringify(lost)).not.toContain('Private title');
    expect(JSON.stringify(lost)).not.toContain(asset.id);
    expect(JSON.stringify(lost)).not.toContain(album.id);
    await ctx.syncAckAll(auth, lost);
    await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id });
    expect((await pins.get(auth)).pins[0].unavailable).toBe(false);
    await ctx.get(AlbumRepository).delete(album.id);
    expect((await ctx.syncStream(auth, [SyncRequestType.PinnedCollectionsV1]))[0]).toMatchObject({
      data: { revision: first.revision, pins: [unavailable] },
    });
    expect((await users.getPinnedCollections(auth.user.id))!.updateId).toBe(first.revision);
    const legacy = await ctx.syncStream(auth, [SyncRequestType.UserMetadataV1]);
    expect(JSON.stringify(legacy)).not.toContain('pinned-collections');
    expect(JSON.stringify(legacy)).not.toContain(album.id);
  });
});
