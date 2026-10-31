import { Kysely, sql } from 'kysely';
import { AlbumKind, AlbumUserRole, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
const types = [SyncRequestType.SharedSpacesV1, SyncRequestType.SharedSpaceMembersV1];
const events = (rows: any[]) => rows.filter((row) => row.type !== SyncEntityType.SyncCompleteV1);
const setup = async () => {
  const ctx = new SyncTestContext(db);
  const owner = await ctx.newSyncAuthUser();
  const member = await ctx.newSyncAuthUser();
  const { album: space } = await ctx.newAlbum({
    ownerId: owner.user.id,
    kind: AlbumKind.Space,
    albumName: 'Family',
    icon: 'mdi-home',
  });
  await ctx.newAlbumUser({ albumId: space.id, userId: member.user.id, role: AlbumUserRole.Viewer });
  return { ctx, owner, member, space, repo: ctx.get(SyncRepository).tag };
};

it('creates updates and deletes identity and accepted membership with unchanged old wire', async () => {
  const { ctx, owner, member, space } = await setup();
  const first = await ctx.syncStream(member.auth, types);
  expect(events(first)[0]).toMatchObject({
    type: SyncEntityType.SharedSpaceV1,
    data: { id: space.id, kind: 'space', name: 'Family', icon: 'mdi-home', description: null },
  });
  expect(events(first).filter((row) => row.type === SyncEntityType.SharedSpaceMemberV1)).toHaveLength(2);
  expect(JSON.stringify(first)).not.toContain(owner.user.email);
  await ctx.syncAckAll(member.auth, first);
  await ctx.assertSyncIsComplete(member.auth, types);
  await db
    .updateTable('album')
    .set({ albumName: 'Renamed', description: 'Accepted members only' })
    .where('id', '=', space.id)
    .execute();
  await db
    .updateTable('album_user')
    .set({ role: AlbumUserRole.Editor })
    .where('albumId', '=', space.id)
    .where('userId', '=', member.user.id)
    .execute();
  const updates = events(await ctx.syncStream(member.auth, types));
  expect(updates).toHaveLength(2);
  expect(updates).toContainEqual(
    expect.objectContaining({ type: SyncEntityType.SharedSpaceV1, data: expect.objectContaining({ name: 'Renamed' }) }),
  );
  expect(updates).toContainEqual(
    expect.objectContaining({
      type: SyncEntityType.SharedSpaceMemberV1,
      data: expect.objectContaining({ userId: member.user.id, role: AlbumUserRole.Editor }),
    }),
  );
  await ctx.syncAckAll(member.auth, updates);
  await db.deleteFrom('album_user').where('albumId', '=', space.id).where('userId', '=', member.user.id).execute();
  const revoked = events(await ctx.syncStream(owner.auth, types));
  // The owner's session has never received that roster entry and must not get its delete identifier.
  expect(revoked.some((row) => row.type === SyncEntityType.SharedSpaceMemberDeleteV1)).toBe(false);
});

it.each([false, true])(
  'retries removal and regrants unchanged roster generations before/after ACK=%s',
  async (acknowledged) => {
    const { ctx, owner, member, space } = await setup();
    const first = await ctx.syncStream(member.auth, types);
    if (acknowledged) await ctx.syncAckAll(member.auth, first);
    const original = await db
      .selectFrom('album_user')
      .select('updateId')
      .where('albumId', '=', space.id)
      .where('userId', '=', owner.user.id)
      .executeTakeFirstOrThrow();
    await db.deleteFrom('album_user').where('albumId', '=', space.id).where('userId', '=', member.user.id).execute();
    const revoked = events(await ctx.syncStream(member.auth, types));
    expect(revoked.filter((row) => row.type === SyncEntityType.SharedSpaceDeleteV1)).toEqual([
      expect.objectContaining({ data: { spaceId: space.id } }),
    ]);
    expect(
      revoked
        .filter((row) => row.type === SyncEntityType.SharedSpaceMemberDeleteV1)
        .map((row) => row.data.userId)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([owner.user.id, member.user.id].sort((a, b) => a.localeCompare(b)));
    expect(events(await ctx.syncStream(member.auth, types))).toEqual(revoked);
    await ctx.syncAckAll(member.auth, revoked);
    await ctx.assertSyncIsComplete(member.auth, types);
    await ctx.newAlbumUser({ albumId: space.id, userId: member.user.id, role: AlbumUserRole.Viewer });
    const regrant = events(await ctx.syncStream(member.auth, types));
    expect(regrant).toHaveLength(3);
    expect(
      regrant.find((row) => row.type === SyncEntityType.SharedSpaceMemberV1 && row.data.userId === owner.user.id).ack,
    ).not.toBe(
      first.find((row) => row.type === SyncEntityType.SharedSpaceMemberV1 && row.data.userId === owner.user.id).ack,
    );
    expect(
      (
        await db
          .selectFrom('album_user')
          .select('updateId')
          .where('albumId', '=', space.id)
          .where('userId', '=', owner.user.id)
          .executeTakeFirstOrThrow()
      ).updateId,
    ).toBe(original.updateId);
    await Promise.all([ctx.syncAckAll(member.auth, revoked), ctx.syncAckAll(member.auth, first)]);
    expect(events(await ctx.syncStream(member.auth, types))).toEqual(regrant);
    await ctx.syncAckAll(member.auth, regrant);
    await ctx.assertSyncIsComplete(member.auth, types);
  },
);

it('never discloses pending, partner-only, shared-link, stranger or nonowner-admin identifiers', async () => {
  const { ctx, owner, space } = await setup();
  const stranger = await ctx.newSyncAuthUser();
  await ctx.newPartner({ sharedById: owner.user.id, sharedWithId: stranger.user.id });
  await db
    .insertInto('shared_space_invite')
    .values({ albumId: space.id, userId: stranger.user.id, invitedById: owner.user.id, role: AlbumUserRole.Editor })
    .execute();
  for (const auth of [
    stranger.auth,
    { ...stranger.auth, user: { ...stranger.auth.user, isAdmin: true } },
    { ...owner.auth, sharedLink: {} as never },
  ]) {
    const rows = await ctx.syncStream(auth, types);
    expect(events(rows)).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain(space.id);
    expect(JSON.stringify(rows)).not.toContain(owner.user.id);
  }
  const memberRows = events(await ctx.syncStream(owner.auth, types));
  expect(memberRows.some((row) => row.data.userId === stranger.user.id)).toBe(false);
  await db.deleteFrom('shared_space_invite').where('albumId', '=', space.id).execute();
  expect(events(await ctx.syncStream(stranger.auth, types))).toEqual([]);
});

it('rechecks accepted access at preparation and never revokes an unseen queued roster', async () => {
  const { member, space, repo } = await setup();
  const identity = await repo.reconcile(member.auth, 'space');
  const roster = await repo.reconcile(member.auth, 'spaceMember');
  await db.deleteFrom('album_user').where('albumId', '=', space.id).where('userId', '=', member.user.id).execute();
  expect(await repo.prepare(member.auth, 'space', identity[0].eventId)).toBeUndefined();
  for (const row of roster) expect(await repo.prepare(member.auth, 'spaceMember', row.eventId)).toBeUndefined();
  expect(await repo.reconcile(member.auth, 'space')).toEqual([]);
  expect(await repo.reconcile(member.auth, 'spaceMember')).toEqual([]);
});

it('drops a delivered roster after physical space deletion without target FKs erasing revoke state', async () => {
  const { ctx, member, space } = await setup();
  const first = await ctx.syncStream(member.auth, types);
  await ctx.syncAckAll(member.auth, first);
  await db.deleteFrom('album').where('id', '=', space.id).execute();
  const deleted = events(await ctx.syncStream(member.auth, types));
  expect(deleted).toHaveLength(3);
  expect(
    deleted.every((row) =>
      [SyncEntityType.SharedSpaceDeleteV1, SyncEntityType.SharedSpaceMemberDeleteV1].includes(row.type),
    ),
  ).toBe(true);
  await ctx.syncAckAll(member.auth, deleted);
  await ctx.assertSyncIsComplete(member.auth, types);
});

it('orders identity newest first with microsecond and ID ties, without ACK skipping unsent rows', async () => {
  const ctx = new SyncTestContext(db);
  const { auth, user } = await ctx.newSyncAuthUser();
  const spaces = [];
  for (let i = 0; i < 4; i++) spaces.push((await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Space })).album);
  await db
    .updateTable('album')
    .set({ createdAt: sql`'2026-01-01T01:00:00.000001Z'::timestamptz` })
    .where(
      'id',
      'in',
      spaces.map((row) => row.id),
    )
    .execute();
  await db
    .updateTable('album')
    .set({ createdAt: sql`'2026-01-01T01:00:00.000002Z'::timestamptz` })
    .where('id', '=', spaces[0].id)
    .execute();
  const repo = ctx.get(SyncRepository).tag;
  const pending = await repo.reconcile(auth, 'space');
  expect(pending.map((row) => row.entityId)).toEqual([
    spaces[0].id,
    ...spaces
      .slice(1)
      .map((row) => row.id)
      .sort((a, b) => a.localeCompare(b))
      .toReversed(),
  ]);
  // Deliberately reverse UUID order for the remaining records: a last-UUID ACK cannot pass by chance.
  for (let i = 1; i < pending.length; i++) {
    await db
      .updateTable('session_tag_sync_state')
      .set({ eventId: `00000000-0000-7000-8000-00000000000${pending.length - i}` })
      .where('sessionId', '=', auth.session!.id)
      .where('kind', '=', 'space')
      .where('key', '=', pending[i].key)
      .execute();
  }
  // Make the first ordered record's event the greatest: ACK still must leave every unsent older record pending.
  const greatest = 'ffffffff-ffff-7fff-bfff-ffffffffffff';
  await db
    .updateTable('session_tag_sync_state')
    .set({ eventId: greatest })
    .where('sessionId', '=', auth.session!.id)
    .where('kind', '=', 'space')
    .where('key', '=', pending[0].key)
    .execute();
  // Even an exact queued ACK is ignored before delivery.
  await repo.acknowledge(auth.session!.id, { type: SyncEntityType.SharedSpaceV1, updateId: greatest });
  expect(await repo.reconcile(auth, 'space')).toHaveLength(4);
  const first = await repo.prepare(auth, 'space', greatest);
  await repo.acknowledge(auth.session!.id, { type: first!.type, updateId: first!.eventId });
  const remaining = await repo.reconcile(auth, 'space');
  expect(remaining.map((row) => row.entityId)).toEqual(pending.slice(1).map((row) => row.entityId));
  const delivered = await ctx.syncStream(auth, [SyncRequestType.SharedSpacesV1]);
  expect(events(delivered).map((row) => row.data.id)).toEqual(remaining.map((row) => row.entityId));
  await ctx.syncAckAll(auth, delivered);
  await ctx.assertSyncIsComplete(auth, [SyncRequestType.SharedSpacesV1]);
});

it('revalidates soft-deleted owner and member accounts without returning cached roster payloads', async () => {
  const { ctx, owner, member, space } = await setup();
  const first = await ctx.syncStream(member.auth, types);
  await ctx.syncAckAll(member.auth, first);
  await db.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', owner.user.id).execute();
  expect(events(await ctx.syncStream(member.auth, types))).toHaveLength(3);
  const fresh = await ctx.newSyncAuthUser();
  await ctx.newAlbumUser({ albumId: space.id, userId: fresh.user.id });
  expect(events(await ctx.syncStream(fresh.auth, types))).toEqual([]);
});

it('serializes concurrent delivery orders and rejects a stale ACK racing a source change', async () => {
  const { ctx, owner, space, repo } = await setup();
  await ctx.newAlbum({ ownerId: owner.user.id, kind: AlbumKind.Space });
  const queued = await repo.reconcile(owner.auth, 'space');
  const prepared = await Promise.all(queued.map((row) => repo.prepare(owner.auth, 'space', row.eventId)));
  const stored = await db
    .selectFrom('session_tag_sync_state')
    .select(['eventId', 'deliveryOrder'])
    .where('sessionId', '=', owner.auth.session!.id)
    .where('kind', '=', 'space')
    .orderBy('deliveryOrder', 'asc')
    .execute();
  expect(stored.map((row) => row.deliveryOrder)).toEqual([1, 2]);
  await repo.acknowledge(owner.auth.session!.id, { type: SyncEntityType.SharedSpaceV1, updateId: stored[1].eventId });
  expect(await repo.reconcile(owner.auth, 'space')).toEqual([]);
  const old = prepared.find((row) => row!.data.id === space.id)!;
  await db.updateTable('album').set({ albumName: 'Concurrent rename' }).where('id', '=', space.id).execute();
  await Promise.all([
    repo.reconcile(owner.auth, 'space'),
    repo.acknowledge(owner.auth.session!.id, { type: old!.type, updateId: old!.eventId }),
  ]);
  const changed = await repo.reconcile(owner.auth, 'space');
  expect(changed).toHaveLength(1);
  expect(changed[0]).toMatchObject({ delivered: false, acknowledged: false, deliveryOrder: null });
  expect(changed[0].eventId).not.toBe(old!.eventId);
});

it('resumes around new, changed and deleted identities without acknowledging unseen generations', async () => {
  const { ctx, owner, space, repo } = await setup();
  const pending = await repo.reconcile(owner.auth, 'space');
  await db.updateTable('album').set({ albumName: 'Changed before delivery' }).where('id', '=', space.id).execute();
  expect(await repo.prepare(owner.auth, 'space', pending[0].eventId)).toBeUndefined();
  const changed = await repo.reconcile(owner.auth, 'space');
  expect(changed[0].eventId).not.toBe(pending[0].eventId);
  const delivered = await repo.prepare(owner.auth, 'space', changed[0].eventId);
  expect(delivered).toMatchObject({ data: { name: 'Changed before delivery' } });
  await repo.acknowledge(owner.auth.session!.id, { type: delivered!.type, updateId: delivered!.eventId });
  const { album: unseen } = await ctx.newAlbum({ ownerId: owner.user.id, kind: AlbumKind.Space });
  await repo.reconcile(owner.auth, 'space');
  await db.deleteFrom('album').where('id', '=', unseen.id).execute();
  const { album: newest } = await ctx.newAlbum({ ownerId: owner.user.id, kind: AlbumKind.Space });
  const next = events(await ctx.syncStream(owner.auth, [SyncRequestType.SharedSpacesV1]));
  expect(next).toEqual([
    expect.objectContaining({ type: SyncEntityType.SharedSpaceV1, data: expect.objectContaining({ id: newest.id }) }),
  ]);
  expect(JSON.stringify(next)).not.toContain(unseen.id);
  await ctx.syncAckAll(owner.auth, next);
  await ctx.assertSyncIsComplete(owner.auth, [SyncRequestType.SharedSpacesV1]);
});
