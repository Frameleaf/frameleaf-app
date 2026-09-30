import { Kysely, sql } from 'kysely';
import {
  AlbumKind,
  AlbumUserRole,
  AssetLockReason,
  AssetVisibility,
  SyncEntityType,
  SyncRequestType,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
const types = [SyncRequestType.SharedSpaceAlbumsV1, SyncRequestType.SharedSpacePeopleV1];
const events = (rows: any[]) => rows.filter((row) => row.type !== SyncEntityType.SyncCompleteV1);
const setup = async () => {
  const ctx = new SyncTestContext(db);
  const owner = await ctx.newSyncAuthUser();
  const member = await ctx.newSyncAuthUser();
  const { asset } = await ctx.newAsset({ ownerId: owner.user.id });
  const { album: space } = await ctx.newAlbum({ ownerId: owner.user.id, kind: AlbumKind.Space }, [asset.id]);
  const { album: target } = await ctx.newAlbum(
    { ownerId: owner.user.id, albumName: 'Published album', icon: 'mdi-flower' },
    [asset.id],
  );
  await ctx.newAlbumUser({ albumId: space.id, userId: member.user.id, role: AlbumUserRole.Viewer });
  const links = new AlbumUserRepository(db);
  await links.createLinkedAlbum({ albumId: space.id, linkedAlbumId: target.id, linkedById: owner.user.id });
  const { person } = await ctx.newPerson({
    ownerId: owner.user.id,
    name: 'Private secret',
    thumbnailPath: '/private/face',
    birthDate: '2000-01-01',
  });
  await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId, isVisible: true });
  const published = await links.createLinkedPerson({
    albumId: space.id,
    personOwnerId: owner.user.id,
    personGroupId: person.personGroupId,
    name: 'Public identity',
    coverAssetId: asset.id,
  });
  return { ctx, owner, member, space, target, asset, person, published, links, repo: ctx.get(SyncRepository).tag };
};

it('publishes narrow references with strict counts but does not grant target album access or disclose private people', async () => {
  const { ctx, member, space, target, asset, person, published } = await setup();
  const first = events(await ctx.syncStream(member.auth, types));
  expect(first).toEqual([
    expect.objectContaining({
      type: SyncEntityType.SharedSpaceAlbumV1,
      data: {
        spaceId: space.id,
        albumId: target.id,
        name: 'Published album',
        icon: 'mdi-flower',
        assetCount: 1,
        thumbnailAssetId: asset.id,
        linkedAt: expect.any(String),
      },
    }),
    expect.objectContaining({
      type: SyncEntityType.SharedSpacePersonV1,
      data: {
        id: published.id,
        spaceId: space.id,
        name: 'Public identity',
        coverAssetId: asset.id,
        assetCount: 1,
        linkedAt: expect.any(String),
      },
    }),
  ]);
  const raw = JSON.stringify(first);
  for (const secret of [person.ownerId, person.personGroupId, 'Private secret', '/private/face', '2000-01-01'])
    expect(raw).not.toContain(secret);
  expect(
    await new AccessRepository(db).album.checkSharedAlbumAccess(
      member.user.id,
      new Set([target.id]),
      AlbumUserRole.Viewer,
    ),
  ).toEqual(new Set());
  await ctx.syncAckAll(member.auth, first);
  await ctx.assertSyncIsComplete(member.auth, types);
});

it('tracks current public names and derived counts without changing link timestamps or private names', async () => {
  const { ctx, member, space, target, asset, person, published, links } = await setup();
  await ctx.syncAckAll(member.auth, await ctx.syncStream(member.auth, types));
  await db
    .updateTable('person')
    .set({ name: 'Different private name' })
    .where('ownerId', '=', person.ownerId)
    .where('personGroupId', '=', person.personGroupId)
    .execute();
  await ctx.assertSyncIsComplete(member.auth, types);
  await db
    .updateTable('album')
    .set({ albumName: 'Renamed public target', icon: null })
    .where('id', '=', target.id)
    .execute();
  await links.createLinkedPerson({
    albumId: space.id,
    personOwnerId: person.ownerId,
    personGroupId: person.personGroupId,
    name: 'Renamed published',
    coverAssetId: asset.id,
  });
  const renamed = events(await ctx.syncStream(member.auth, types));
  expect(renamed).toHaveLength(2);
  expect(renamed[0].data.name).toBe('Renamed public target');
  expect(renamed[1].data).toMatchObject({ id: published.id, name: 'Renamed published' });
  await ctx.syncAckAll(member.auth, renamed);
  await db.deleteFrom('album_asset').where('albumId', '=', space.id).where('assetId', '=', asset.id).execute();
  const empty = events(await ctx.syncStream(member.auth, types));
  expect(empty.map((row) => row.data.assetCount)).toEqual([0, 0]);
  expect(empty[0].data.thumbnailAssetId).toBeNull();
  expect(empty[1].data.coverAssetId).toBeNull();
});

it.each(['outside', 'trash', 'sensitive', 'locked'] as const)(
  'clears %s stored covers and counts before payload, even for elevated owners',
  async (reason) => {
    const { ctx, owner, member, space, asset, published } = await setup();
    switch (reason) {
      case 'outside': {
        await db.deleteFrom('album_asset').where('albumId', '=', space.id).where('assetId', '=', asset.id).execute();
        break;
      }
      case 'trash': {
        await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();
        break;
      }
      case 'sensitive': {
        await db.updateTable('asset').set({ is_nsfw: true }).where('id', '=', asset.id).execute();
        break;
      }
      case 'locked': {
        const { asset: locked } = await ctx.newAsset({ ownerId: owner.user.id, visibility: AssetVisibility.Locked });
        await ctx.newAlbumAsset({ albumId: space.id, assetId: locked.id });
        await db
          .updateTable('shared_space_person')
          .set({ coverAssetId: locked.id })
          .where('id', '=', published.id)
          .execute();
        await db.deleteFrom('album_asset').where('albumId', '=', space.id).where('assetId', '=', asset.id).execute();

        break;
      }
      // No default
    }
    for (const auth of [
      member.auth,
      { ...owner.auth, session: { ...owner.auth.session!, hasElevatedPermission: true } },
    ]) {
      const rows = events(await ctx.syncStream(auth, types));
      expect(rows.map((row) => row.data.assetCount)).toEqual([0, 0]);
      expect(rows[0].data.thumbnailAssetId).toBeNull();
      expect(rows[1].data.coverAssetId).toBeNull();
    }
  },
);

it('never discloses link IDs to invitations, partners, admin or shared-link sessions', async () => {
  const { ctx, owner, space, target, published } = await setup();
  const stranger = await ctx.newSyncAuthUser();
  await ctx.newPartner({ sharedById: owner.user.id, sharedWithId: stranger.user.id });
  await db
    .insertInto('shared_space_invite')
    .values({ albumId: space.id, userId: stranger.user.id, role: AlbumUserRole.Editor })
    .execute();
  for (const auth of [
    stranger.auth,
    { ...stranger.auth, user: { ...stranger.auth.user, isAdmin: true } },
    { ...owner.auth, sharedLink: {} as never },
  ]) {
    const rows = await ctx.syncStream(auth, types);
    expect(events(rows)).toEqual([]);
    for (const id of [space.id, target.id, published.id]) expect(JSON.stringify(rows)).not.toContain(id);
  }
});

it.each([false, true])(
  'retries revoked links and rejects stale regrant ACKs before/after ack=%s',
  async (acknowledged) => {
    const { ctx, member, space, target, published } = await setup();
    const first = events(await ctx.syncStream(member.auth, types));
    if (acknowledged) await ctx.syncAckAll(member.auth, first);
    await db.deleteFrom('album_user').where('albumId', '=', space.id).where('userId', '=', member.user.id).execute();
    const revoked = events(await ctx.syncStream(member.auth, types));
    expect(revoked).toEqual([
      expect.objectContaining({
        type: SyncEntityType.SharedSpaceAlbumDeleteV1,
        data: { spaceId: space.id, albumId: target.id },
      }),
      expect.objectContaining({
        type: SyncEntityType.SharedSpacePersonDeleteV1,
        data: { spaceId: space.id, id: published.id },
      }),
    ]);
    expect(events(await ctx.syncStream(member.auth, types))).toEqual(revoked);
    await ctx.newAlbumUser({ albumId: space.id, userId: member.user.id, role: AlbumUserRole.Viewer });
    const regrant = events(await ctx.syncStream(member.auth, types));
    expect(regrant.map((row) => row.ack)).not.toEqual(first.map((row) => row.ack));
    await Promise.all([ctx.syncAckAll(member.auth, revoked), ctx.syncAckAll(member.auth, first)]);
    expect(events(await ctx.syncStream(member.auth, types))).toEqual(regrant);
    await ctx.syncAckAll(member.auth, regrant);
    await ctx.assertSyncIsComplete(member.auth, types);
  },
);

it('silently drops unseen links and refuses changed payloads between reconciliation and prepare', async () => {
  const { member, space, target, published, repo } = await setup();
  const albums = await repo.reconcile(member.auth, 'spaceAlbum');
  const people = await repo.reconcile(member.auth, 'spacePerson');
  await db.updateTable('album').set({ albumName: 'Changed after reconcile' }).where('id', '=', target.id).execute();
  await db
    .updateTable('shared_space_person')
    .set({ name: 'Changed after reconcile' })
    .where('id', '=', published.id)
    .execute();
  expect(await repo.prepare(member.auth, 'spaceAlbum', albums[0].eventId)).toBeUndefined();
  expect(await repo.prepare(member.auth, 'spacePerson', people[0].eventId)).toBeUndefined();
  await db.deleteFrom('album_user').where('albumId', '=', space.id).where('userId', '=', member.user.id).execute();
  for (const kind of ['spaceAlbum', 'spacePerson'] as const)
    expect(await repo.reconcile(member.auth, kind)).toEqual([]);
});

it('retains delivered delete knowledge for target deletion and a physical orphan private person', async () => {
  const { ctx, member, target, person, space, published } = await setup();
  await ctx.syncAckAll(member.auth, await ctx.syncStream(member.auth, types));
  await db.deleteFrom('album').where('id', '=', target.id).execute();
  await db
    .deleteFrom('person')
    .where('ownerId', '=', person.ownerId)
    .where('personGroupId', '=', person.personGroupId)
    .execute();
  expect(await db.selectFrom('shared_space_person').select('id').where('id', '=', published.id).execute()).toHaveLength(
    1,
  );
  const deleted = events(await ctx.syncStream(member.auth, types));
  expect(deleted.map((row) => row.data)).toEqual([
    { spaceId: space.id, albumId: target.id },
    { spaceId: space.id, id: published.id },
  ]);
  await ctx.syncAckAll(member.auth, deleted);
  await ctx.assertSyncIsComplete(member.auth, types);
});

it.each(['spaceAlbum', 'spacePerson'] as const)(
  'orders %s by actual microseconds and key ties and acknowledges actual delivery order only',
  async (kind) => {
    const { ctx, owner, member, space, target, published, links, repo } = await setup();
    const keys = kind === 'spaceAlbum' ? [`${space.id}:${target.id}`] : [published.id];
    for (let i = 0; i < 3; i++) {
      if (kind === 'spaceAlbum') {
        const { album } = await ctx.newAlbum({ ownerId: owner.user.id });
        await links.createLinkedAlbum({ albumId: space.id, linkedAlbumId: album.id });
        keys.push(`${space.id}:${album.id}`);
      } else {
        const { person: next } = await ctx.newPerson({ ownerId: owner.user.id });
        keys.push(
          (
            await links.createLinkedPerson({
              albumId: space.id,
              personOwnerId: next.ownerId,
              personGroupId: next.personGroupId,
              name: 'Another',
            })
          ).id,
        );
      }
    }
    for (const [i, key] of keys.entries()) {
      const timestamp = i < 2 ? '2026-01-01 00:00:00.000002+00' : '2026-01-01 00:00:00.000001+00';
      if (kind === 'spaceAlbum')
        await db
          .updateTable('shared_space_album')
          .set({ createdAt: sql`${timestamp}::timestamptz` })
          .where('albumId', '=', space.id)
          .where('linkedAlbumId', '=', key.split(':', 2)[1])
          .execute();
      else
        await db
          .updateTable('shared_space_person')
          .set({ createdAt: sql`${timestamp}::timestamptz` })
          .where('id', '=', key)
          .execute();
    }
    const expected = [...keys.slice(0, 2).sort().toReversed(), ...keys.slice(2).sort().toReversed()];
    const pending = await repo.reconcile(member.auth, kind);
    expect(pending.map((row) => row.key)).toEqual(expected);
    // Make UUID order the reverse of actual delivery order, eliminating accidental green.
    for (const [i, state] of pending.entries())
      await db
        .updateTable('session_tag_sync_state')
        .set({ eventId: `00000000-0000-7000-8000-${String(10 - i).padStart(12, '0')}` })
        .where('sessionId', '=', member.auth.session!.id)
        .where('kind', '=', kind)
        .where('key', '=', state.key)
        .execute();
    const ordered = await repo.reconcile(member.auth, kind);
    await repo.acknowledge(owner.auth.session!.id, {
      type: kind === 'spaceAlbum' ? SyncEntityType.SharedSpaceAlbumV1 : SyncEntityType.SharedSpacePersonV1,
      updateId: ordered[0].eventId,
    });
    expect(await repo.reconcile(member.auth, kind)).toHaveLength(4);
    await repo.acknowledge(member.auth.session!.id, {
      type: kind === 'spaceAlbum' ? SyncEntityType.SharedSpaceAlbumV1 : SyncEntityType.SharedSpacePersonV1,
      updateId: ordered[3].eventId,
    });
    expect(await repo.reconcile(member.auth, kind)).toHaveLength(4); // unsent ACK does nothing
    const first = (await repo.prepare(member.auth, kind, ordered[0].eventId))!;
    await repo.acknowledge(member.auth.session!.id, { type: first.type, updateId: first.eventId });
    expect(await repo.reconcile(member.auth, kind)).toHaveLength(3);
    const rest = await repo.reconcile(member.auth, kind);
    let last = first;
    for (const row of rest) last = (await repo.prepare(member.auth, kind, row.eventId))!;
    await repo.acknowledge(member.auth.session!.id, { type: last.type, updateId: last.eventId });
    expect(await repo.reconcile(member.auth, kind)).toEqual([]);
  },
);

it('rechecks membership after multi-query link hydration, not just before it', async () => {
  const { member, space, repo } = await setup();
  const original = AlbumUserRepository.prototype.getLinkedAlbums;
  const spy = vi.spyOn(AlbumUserRepository.prototype, 'getLinkedAlbums').mockImplementation(async function (
    this: AlbumUserRepository,
    ...args
  ) {
    const result = await original.apply(this, args);
    await db.deleteFrom('album_user').where('albumId', '=', space.id).where('userId', '=', member.user.id).execute();
    return result;
  });
  try {
    expect(await repo.reconcile(member.auth, 'spaceAlbum')).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

it('refuses a cover made private during count hydration instead of emitting its cached asset ID', async () => {
  const { member, asset, repo } = await setup();
  const initial = await repo.reconcile(member.auth, 'spacePerson');
  const original = AlbumUserRepository.prototype.getLinkedPersonCounts;
  const spy = vi.spyOn(AlbumUserRepository.prototype, 'getLinkedPersonCounts').mockImplementation(async function (
    this: AlbumUserRepository,
    ...args
  ) {
    const result = await original.apply(this, args);
    await db.updateTable('asset').set({ is_nsfw: true }).where('id', '=', asset.id).execute();
    return result;
  });
  try {
    expect(await repo.prepare(member.auth, 'spacePerson', initial[0].eventId)).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
  const next = await repo.reconcile(member.auth, 'spacePerson');
  expect((await repo.prepare(member.auth, 'spacePerson', next[0].eventId))!.data).toMatchObject({
    coverAssetId: null,
    assetCount: 0,
  });
});

it('keeps retryable revoke identifiers after the space cascades its published links', async () => {
  const { ctx, member, space, target, published } = await setup();
  await ctx.syncAckAll(member.auth, await ctx.syncStream(member.auth, types));
  await db.deleteFrom('album').where('id', '=', space.id).execute();
  expect(await db.selectFrom('shared_space_album').selectAll().where('albumId', '=', space.id).execute()).toEqual([]);
  expect(await db.selectFrom('shared_space_person').selectAll().where('albumId', '=', space.id).execute()).toEqual([]);
  const revoked = events(await ctx.syncStream(member.auth, types));
  expect(revoked.map((row) => row.data)).toEqual([
    { spaceId: space.id, albumId: target.id },
    { spaceId: space.id, id: published.id },
  ]);
  expect(events(await ctx.syncStream(member.auth, types))).toEqual(revoked);
  await ctx.syncAckAll(member.auth, revoked);
  await ctx.assertSyncIsComplete(member.auth, types);
});

it.each(['locked', 'outside', 'sensitive'] as const)(
  'refuses an album thumbnail made %s during the final link recheck',
  async (reason) => {
    const { ctx, owner, member, space, asset, repo } = await setup();
    const initial = await repo.reconcile(member.auth, 'spaceAlbum');
    const original = AlbumUserRepository.prototype.getLinkedAlbums;
    let reads = 0;
    const spy = vi.spyOn(AlbumUserRepository.prototype, 'getLinkedAlbums').mockImplementation(async function (
      this: AlbumUserRepository,
      ...args
    ) {
      const rows = await original.apply(this, args);
      if (++reads === 2) {
        switch (reason) {
          case 'locked': {
            await ctx.get(AssetRepository).lock([asset.id], AssetLockReason.Marked, owner.user.id);
            break;
          }
          case 'outside': {
            await db
              .deleteFrom('album_asset')
              .where('albumId', '=', space.id)
              .where('assetId', '=', asset.id)
              .execute();
            break;
          }
          case 'sensitive': {
            await db.updateTable('asset').set({ is_nsfw: true }).where('id', '=', asset.id).execute();
            break;
          }
        }
      }
      return rows;
    });
    try {
      expect(await repo.prepare(member.auth, 'spaceAlbum', initial[0].eventId)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const next = await repo.reconcile(member.auth, 'spaceAlbum');
    expect(next[0].eventId).not.toBe(initial[0].eventId);
    const prepared = (await repo.prepare(member.auth, 'spaceAlbum', next[0].eventId))!;
    expect(prepared.data).toMatchObject({ assetCount: 0, thumbnailAssetId: null });
    expect(JSON.stringify(prepared.data)).not.toContain(asset.id);
  },
);
