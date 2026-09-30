import { ConflictException } from '@nestjs/common';
import type { StoredPinnedCollection } from 'src/dtos/pinned-collection.dto.js';
import type { MemoryService } from 'src/services/memory.service.js';
import type { PersonService } from 'src/services/person.service.js';
import type { PetService } from 'src/services/pet.service.js';
import { AssetLockReason, AssetVisibility, SyncEntityType, SyncRequestType, UserMetadataKey } from 'src/enum.js';
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
import { SyncRepository } from 'src/repositories/sync.repository.js';
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
  return { ctx, auth, user, users, pins, repo: ctx.get(SyncRepository).tag, readPins: () => pins.get(auth) };
};

const ref = (kind: StoredPinnedCollection['kind'], targetId: string): StoredPinnedCollection => ({
  id: newUuid(),
  kind,
  targetId,
});

const types = [SyncRequestType.PinnedCollectionEventsV1];
const events = (rows: any[]) => rows.filter((row) => row.type !== SyncEntityType.SyncCompleteV1);
const builtin = (id: string) => ref('builtin', id);

it('creates, reorders, removes, clears and acknowledges individual pin hydration at list positions', async () => {
  const { ctx, auth, pins } = await setup();
  const refs = [builtin('photos'), builtin('videos'), builtin('archive')];
  let saved = await pins.set(auth, { expectedRevision: null, pins: refs });
  const initial = events(await ctx.syncStream(auth, types));
  expect(initial.map((row) => [row.data.id, row.data.position])).toEqual(
    refs.map((pin, position) => [pin.id, position]),
  );
  expect(Object.keys(initial[0].data).sort()).toEqual([
    'count',
    'countCapped',
    'coverAssetId',
    'id',
    'kind',
    'position',
    'targetId',
    'title',
    'unavailable',
  ]);
  await ctx.syncAckAll(auth, initial);
  await ctx.assertSyncIsComplete(auth, types);
  saved = await pins.set(auth, { expectedRevision: saved.revision, pins: refs.toReversed() });
  const reorder = events(await ctx.syncStream(auth, types));
  expect(reorder.map((row) => [row.data.id, row.data.position])).toEqual([
    [refs[2].id, 0],
    [refs[0].id, 2],
  ]);
  await ctx.syncAckAll(auth, reorder);
  saved = await pins.set(auth, { expectedRevision: saved.revision, pins: [refs[2], refs[0]] });
  const removal = events(await ctx.syncStream(auth, types));
  expect(removal).toContainEqual(
    expect.objectContaining({ type: SyncEntityType.PinnedCollectionDeleteV1, data: { pinId: refs[1].id } }),
  );
  expect(removal).toContainEqual(
    expect.objectContaining({
      type: SyncEntityType.PinnedCollectionV1,
      data: expect.objectContaining({ id: refs[0].id, position: 1 }),
    }),
  );
  await ctx.syncAckAll(auth, removal);
  await pins.set(auth, { expectedRevision: saved.revision, pins: [] });
  const cleared = events(await ctx.syncStream(auth, types));
  expect(cleared.map((row) => row.data.pinId).sort((a, b) => a.localeCompare(b))).toEqual(
    [refs[0].id, refs[2].id].sort((a, b) => a.localeCompare(b)),
  );
  await ctx.syncAckAll(auth, cleared);
  await ctx.assertSyncIsComplete(auth, types);
});

it('streams live title/count/cover changes without advancing the stored list revision', async () => {
  const { ctx, auth, user, pins, users } = await setup();
  const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Before' });
  const pin = ref('album', album.id);
  const saved = await pins.set(auth, { expectedRevision: null, pins: [pin] });
  const first = events(await ctx.syncStream(auth, types));
  await ctx.syncAckAll(auth, first);
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  await ctx.get(AlbumRepository).addAssetIds(album.id, [asset.id]);
  await ctx.database
    .updateTable('album')
    .set({ albumName: 'After', albumThumbnailAssetId: asset.id })
    .where('id', '=', album.id)
    .execute();
  const changed = events(await ctx.syncStream(auth, types));
  expect(changed[0].data).toMatchObject({ id: pin.id, title: 'After', count: 1, coverAssetId: asset.id });
  expect(changed[0].ack).not.toBe(first[0].ack);
  expect((await users.getPinnedCollections(user.id))!.updateId).toBe(saved.revision);
});

it.each([false, true])(
  'retries opaque revocation and regrants after sharing loss with sent ACK=%s',
  async (acknowledged) => {
    const { ctx, auth, pins, users } = await setup();
    const { user: owner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { album } = await ctx.newAlbum(
      { ownerId: owner.id, albumName: 'Secret title', albumThumbnailAssetId: asset.id },
      [asset.id],
    );
    await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id });
    const pin = ref('album', album.id);
    const saved = await pins.set(auth, { expectedRevision: null, pins: [pin] });
    const first = events(await ctx.syncStream(auth, types));
    if (acknowledged) await ctx.syncAckAll(auth, first);
    await ctx.database
      .deleteFrom('album_user')
      .where('albumId', '=', album.id)
      .where('userId', '=', auth.user.id)
      .execute();
    const revoked = events(await ctx.syncStream(auth, types));
    expect(revoked).toEqual([
      expect.objectContaining({ type: SyncEntityType.PinnedCollectionDeleteV1, data: { pinId: pin.id } }),
    ]);
    for (const secret of [album.id, asset.id, 'Secret title']) expect(JSON.stringify(revoked)).not.toContain(secret);
    expect(events(await ctx.syncStream(auth, types))).toEqual(revoked);
    const snapshot = (await ctx.syncStream(auth, [SyncRequestType.PinnedCollectionsV1]))[0];
    expect(snapshot.data).toMatchObject({
      revision: saved.revision,
      pins: [{ id: pin.id, unavailable: true, targetId: null, title: null, count: null, coverAssetId: null }],
    });
    await ctx.syncAckAll(auth, revoked);
    await pins.set(auth, { expectedRevision: saved.revision, pins: [{ ...pin, targetId: null }] });
    await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id });
    const regrant = events(await ctx.syncStream(auth, types));
    expect(regrant[0].data).toMatchObject({ id: pin.id, title: 'Secret title', position: 0 });
    expect(regrant[0].ack).not.toBe(first[0].ack);
    await ctx.syncAckAll(auth, first);
    expect(events(await ctx.syncStream(auth, types))).toEqual(regrant);
    expect((await users.getPinnedCollections(auth.user.id))!.value.pins[0].targetId).toBe(album.id);
  },
);

it('deletes mirror hydration on actual target deletion while preserving V1 unavailable placeholder and position holes', async () => {
  const { ctx, auth, user, pins } = await setup();
  const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Gone' });
  const pin = ref('album', album.id);
  const photo = builtin('photos');
  await pins.set(auth, { expectedRevision: null, pins: [pin, photo] });
  const first = events(await ctx.syncStream(auth, types));
  await ctx.syncAckAll(auth, first);
  await ctx.get(AlbumRepository).delete(album.id);
  const deleted = events(await ctx.syncStream(auth, types));
  expect(deleted).toEqual([
    expect.objectContaining({ type: SyncEntityType.PinnedCollectionDeleteV1, data: { pinId: pin.id } }),
  ]);
  const snapshot = await pins.get(auth);
  expect(snapshot.pins[0].unavailable).toBe(true);
  const fresh = await ctx.newSyncAuthUser();
  // The same stored list after reset still preserves the complete-list position of the available entry.
  await ctx.get(SyncRepository).tag.reset(auth.session!.id, [SyncEntityType.PinnedCollectionV1]);
  expect(events(await ctx.syncStream(auth, types))[0].data).toMatchObject({ id: photo.id, position: 1 });
  expect(events(await ctx.syncStream(fresh.auth, types))).toEqual([]);
});

it('revokes acknowledged Locked hydration after owner elevation loss without list revision changes', async () => {
  const { ctx, auth, user, pins, users } = await setup();
  const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
  const unlocked = { ...auth, session: { ...auth.session!, hasElevatedPermission: true } };
  const pin = builtin('locked');
  const saved = await pins.set(unlocked, { expectedRevision: null, pins: [pin] });
  const first = events(await ctx.syncStream(unlocked, types));
  expect(first[0].data.coverAssetId).toBe(asset.id);
  await ctx.syncAckAll(unlocked, first);
  const revoked = events(await ctx.syncStream(auth, types));
  expect(revoked[0].data).toEqual({ pinId: pin.id });
  expect(JSON.stringify(revoked)).not.toContain(asset.id);
  expect(JSON.stringify(revoked)).not.toContain('Locked');
  await ctx.syncAckAll(auth, revoked);
  const regrant = events(await ctx.syncStream(unlocked, types));
  expect(regrant[0].data.count).toBe(1);
  expect((await users.getPinnedCollections(user.id))!.updateId).toBe(saved.revision);
});

it('never exposes other-owner pin IDs, initially unavailable hydration, shared-link or admin-nonowner references', async () => {
  const { ctx, auth, user, pins, users, repo, readPins } = await setup();
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  const pin = ref('album', album.id);
  await pins.set(auth, { expectedRevision: null, pins: [pin] });
  const other = await ctx.newSyncAuthUser();
  for (const isAdmin of [false, true])
    expect(events(await ctx.syncStream({ ...other.auth, user: { ...other.auth.user, isAdmin } }, types))).toEqual([]);
  await ctx.get(AlbumRepository).delete(album.id);
  expect(await repo.reconcile(auth, 'pin', readPins)).toEqual([]);
  await expect(repo.reconcile({ ...auth, sharedLink: { id: 'link' } as never }, 'pin', readPins)).rejects.toThrow(
    'require a user session',
  );
  expect((await users.getPinnedCollections(user.id))!.value.pins[0].id).toBe(pin.id);
});

it('uses current saved-search count/cover/suppression and excludes names from preference-removal revoke', async () => {
  const { ctx, auth, user, users, pins } = await setup();
  const { asset: match } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'needle.jpg' });
  await ctx.newAsset({ ownerId: user.id, originalFileName: 'other.jpg' });
  const name = 'Private search';
  await users.upsertMetadata(user.id, {
    key: UserMetadataKey.Preferences,
    value: { savedSearches: [{ name, query: { originalFileName: 'needle.jpg' } }] },
  });
  const pin = ref('saved-search', name);
  await pins.set(auth, { expectedRevision: null, pins: [pin] });
  const first = events(await ctx.syncStream(auth, types));
  expect(first[0].data).toMatchObject({ count: 1, coverAssetId: match.id });
  await ctx.syncAckAll(auth, first);
  await ctx.get(AssetRepository).lock([match.id], AssetLockReason.Marked, user.id);
  const changed = events(await ctx.syncStream(auth, types));
  expect(changed[0].data).toMatchObject({ count: 0, coverAssetId: null });
  await ctx.syncAckAll(auth, changed);
  await users.upsertMetadata(user.id, { key: UserMetadataKey.Preferences, value: { savedSearches: [] } });
  const revoked = events(await ctx.syncStream(auth, types));
  expect(revoked[0].data).toEqual({ pinId: pin.id });
  expect(JSON.stringify(revoked)).not.toContain(name);
  expect(JSON.stringify(revoked)).not.toContain(match.id);
});

it('refuses changed hydration and privacy between reconciliation and prepare, stale/forged/wrong-action ACKs', async () => {
  const { auth, pins, repo, readPins } = await setup();
  const pin = builtin('photos');
  let saved = await pins.set(auth, { expectedRevision: null, pins: [pin] });
  const queued = await repo.reconcile(auth, 'pin', readPins);
  await repo.acknowledge(auth.session!.id, { type: SyncEntityType.PinnedCollectionV1, updateId: queued[0].eventId });
  expect((await repo.reconcile(auth, 'pin', readPins))[0].acknowledged).toBe(false);
  saved = await pins.set(auth, { expectedRevision: saved.revision, pins: [{ ...pin, targetId: 'videos' }] });
  expect(await repo.prepare(auth, 'pin', queued[0].eventId, readPins)).toBeUndefined();
  const changed = await repo.reconcile(auth, 'pin', readPins);
  const sent = await repo.prepare(auth, 'pin', changed[0].eventId, readPins);
  await repo.acknowledge(auth.session!.id, { type: SyncEntityType.PinnedCollectionDeleteV1, updateId: sent!.eventId });
  expect((await repo.reconcile(auth, 'pin', readPins))[0].acknowledged).toBe(false);
  await pins.set(auth, { expectedRevision: saved.revision, pins: [] });
  expect(await repo.prepare(auth, 'pin', sent!.eventId, readPins)).toBeUndefined();
  const removed = await repo.reconcile(auth, 'pin', readPins);
  await repo.acknowledge(auth.session!.id, { type: sent!.type, updateId: sent!.eventId });
  expect((await repo.reconcile(auth, 'pin', readPins))[0].eventId).toBe(removed[0].eventId);
});

it('resumes partial sent delivery in user order and cumulative last ACK despite reversed event IDs', async () => {
  const { ctx, auth, pins, repo, readPins } = await setup();
  const refs = [builtin('photos'), builtin('videos'), builtin('archive')];
  await pins.set(auth, { expectedRevision: null, pins: refs });
  const pending = await repo.reconcile(auth, 'pin', readPins);
  expect(pending.map((row) => row.entityId)).toEqual(refs.map((pin) => pin.id));
  for (let i = 0; i < pending.length; i++)
    await ctx.database
      .updateTable('session_tag_sync_state')
      .set({ eventId: `00000000-0000-7000-8000-00000000000${pending.length - i}` })
      .where('sessionId', '=', auth.session!.id)
      .where('kind', '=', 'pin')
      .where('key', '=', pending[i].key)
      .execute();
  const reversed = await repo.reconcile(auth, 'pin', readPins);
  const sent = await repo.prepare(auth, 'pin', reversed[0].eventId, readPins);
  expect((await repo.reconcile(auth, 'pin', readPins))[0].eventId).toBe(sent!.eventId);
  await repo.acknowledge(auth.session!.id, { type: sent!.type, updateId: sent!.eventId });
  const remaining = events(await ctx.syncStream(auth, types));
  expect(remaining.map((row) => row.data.position)).toEqual([1, 2]);
  await ctx.syncAckAll(auth, remaining);
  await ctx.assertSyncIsComplete(auth, types);
});

it('drops never-delivered removed pins and preserves old replacement/metadata wire', async () => {
  const { ctx, auth, pins, repo, readPins } = await setup();
  const pin = builtin('photos');
  const saved = await pins.set(auth, { expectedRevision: null, pins: [pin] });
  await repo.reconcile(auth, 'pin', readPins);
  await expect(pins.set(auth, { expectedRevision: null, pins: [] })).rejects.toBeInstanceOf(ConflictException);
  await pins.set(auth, { expectedRevision: saved.revision, pins: [] });
  expect(await repo.reconcile(auth, 'pin', readPins)).toEqual([]);
  const first = await ctx.syncStream(auth, [SyncRequestType.PinnedCollectionsV1]);
  await ctx.syncAckAll(auth, first);
  expect((await ctx.syncStream(auth, [SyncRequestType.PinnedCollectionsV1]))[0].data).toEqual(first[0].data);
  expect(JSON.stringify(await ctx.syncStream(auth, [SyncRequestType.UserMetadataV1]))).not.toContain(
    'pinned-collections',
  );
});

it('fails closed on missing hydration and propagates operational errors without converting delivered state to revocation', async () => {
  const { ctx, auth, pins, repo, readPins } = await setup();
  await pins.set(auth, { expectedRevision: null, pins: [builtin('photos')] });
  const first = events(await ctx.syncStream(auth, types));
  await ctx.syncAckAll(auth, first);
  await expect(repo.reconcile(auth, 'pin')).rejects.toThrow('current authorized hydration');
  await expect(repo.reconcile(auth, 'pin', () => Promise.reject(new Error('database offline')))).rejects.toThrow(
    'database offline',
  );
  expect(await repo.reconcile(auth, 'pin', readPins)).toEqual([]);
});

it('serializes concurrent pin deliveries and rejects old ACKs racing a list reorder', async () => {
  const { ctx, auth, pins, repo, readPins } = await setup();
  const refs = [builtin('photos'), builtin('videos')];
  const saved = await pins.set(auth, { expectedRevision: null, pins: refs });
  const pending = await repo.reconcile(auth, 'pin', readPins);
  const prepared = await Promise.all(pending.map((row) => repo.prepare(auth, 'pin', row.eventId, readPins)));
  const stored = await ctx.database
    .selectFrom('session_tag_sync_state')
    .select(['eventId', 'deliveryOrder'])
    .where('sessionId', '=', auth.session!.id)
    .where('kind', '=', 'pin')
    .orderBy('deliveryOrder', 'asc')
    .execute();
  expect(stored.map((row) => row.deliveryOrder)).toEqual([1, 2]);
  await repo.acknowledge(auth.session!.id, { type: SyncEntityType.PinnedCollectionV1, updateId: stored[1].eventId });
  expect(await repo.reconcile(auth, 'pin', readPins)).toEqual([]);
  await pins.set(auth, { expectedRevision: saved.revision, pins: refs.toReversed() });
  await Promise.all([
    repo.reconcile(auth, 'pin', readPins),
    repo.acknowledge(auth.session!.id, { type: prepared[0]!.type, updateId: prepared[0]!.eventId }),
  ]);
  const changed = await repo.reconcile(auth, 'pin', readPins);
  expect(changed).toHaveLength(2);
  for (const row of changed) expect(row).toMatchObject({ delivered: false, acknowledged: false, deliveryOrder: null });
  expect(changed.map((row) => row.eventId)).not.toContain(prepared[0]!.eventId);
});
