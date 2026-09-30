import { Kysely } from 'kysely';
import { AlbumKind, AlbumUserRole, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
const request = SyncRequestType.AlbumsV3;
const rows = (response: Awaited<ReturnType<SyncTestContext['syncStream']>>) =>
  response.filter(({ type }) => type === SyncEntityType.AlbumV3);
beforeAll(async () => {
  db = await getKyselyDB();
});

it('bootstraps tree and trash metadata newest first with exact microsecond resume', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { album: parent } = await ctx.newAlbum({
    ownerId: auth.user.id,
    kind: AlbumKind.Collection,
    createdAt: '2020-01-01T00:00:00Z',
  });
  const { album: child } = await ctx.newAlbum({
    ownerId: auth.user.id,
    parentId: parent.id,
    icon: 'leaf',
    sortOrder: 2.5,
    createdAt: '2026-01-01T00:00:00.123456Z',
  });
  const { album: latest } = await ctx.newAlbum({ ownerId: auth.user.id, createdAt: '2026-01-01T00:00:00.123457Z' });
  const first = await ctx.syncStream(auth, [request]);
  expect(rows(first).map(({ data }) => data.id)).toEqual([latest.id, child.id, parent.id]);
  expect(rows(first)[1]!.data).toMatchObject({
    parentId: parent.id,
    kind: AlbumKind.Album,
    icon: 'leaf',
    sortOrder: 2.5,
    deletedAt: null,
  });
  const cursor = rows(first)[0]!.ack;
  expect(JSON.parse(Buffer.from(cursor.split('|', 3)[2]!, 'base64url').toString())).toEqual([
    '2026-01-01T00:00:00.123457Z',
    latest.id,
  ]);
  await ctx.sut.setAcks(auth, { acks: [cursor] });
  const next = await ctx.syncStream(auth, [request]);
  expect(rows(next).map(({ data }) => data.id)).toEqual([child.id, parent.id]);
  expect(next.find(({ type }) => type === SyncEntityType.SyncAckV1)?.ack.split('|', 3)[1]).toBe(
    cursor.split('|', 3)[1],
  );
  await ctx.syncAckAll(auth, next);
  await ctx.assertSyncIsComplete(auth, [request]);
});

it('streams tree edits, trash and restore after acknowledgement', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { album: parent } = await ctx.newAlbum({ ownerId: auth.user.id, kind: AlbumKind.Collection });
  const { album } = await ctx.newAlbum({ ownerId: auth.user.id });
  await ctx.syncAckAll(auth, await ctx.syncStream(auth, [request]));
  await db
    .updateTable('album')
    .set({ parentId: parent.id, icon: 'tree', sortOrder: 7, albumName: 'Moved', deletedAt: new Date() })
    .where('id', '=', album.id)
    .execute();
  const trashed = await ctx.syncStream(auth, [request]);
  expect(rows(trashed)).toHaveLength(1);
  expect(rows(trashed)[0]!.data).toMatchObject({
    id: album.id,
    parentId: parent.id,
    icon: 'tree',
    sortOrder: 7,
    name: 'Moved',
    deletedAt: expect.any(String),
  });
  await ctx.syncAckAll(auth, trashed);
  await db
    .updateTable('album')
    .set({ parentId: null, deletedAt: null, kind: AlbumKind.Collection })
    .where('id', '=', album.id)
    .execute();
  const restored = await ctx.syncStream(auth, [request]);
  expect(rows(restored)[0]!.data).toMatchObject({ parentId: null, deletedAt: null, kind: AlbumKind.Collection });
  await ctx.syncAckAll(auth, restored);
  await ctx.assertSyncIsComplete(auth, [request]);
});

it('streams membership revocation and hard-delete tombstones with independent progress', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { user: owner } = await ctx.newUser();
  const { album: shared } = await ctx.newAlbum({ ownerId: owner.id });
  const { album: own } = await ctx.newAlbum({ ownerId: auth.user.id });
  await ctx.newAlbumUser({ albumId: shared.id, userId: auth.user.id, role: AlbumUserRole.Viewer });
  await ctx.syncAckAll(auth, await ctx.syncStream(auth, [request]));
  await db.deleteFrom('album_user').where('albumId', '=', shared.id).where('userId', '=', auth.user.id).execute();
  await db.deleteFrom('album').where('id', '=', own.id).execute();
  const next = await ctx.syncStream(auth, [request]);
  const deletes = next.filter(({ type }) => type === SyncEntityType.AlbumDeleteV2);
  expect(deletes.map(({ data }) => data.albumId).sort((a, b) => a.localeCompare(b))).toEqual(
    [shared.id, own.id].sort((a, b) => a.localeCompare(b)),
  );
  expect(rows(next)).toHaveLength(0);
  await ctx.sut.setAcks(auth, { acks: [deletes[0]!.ack] });
  const resumed = await ctx.syncStream(auth, [request]);
  expect(resumed.filter(({ type }) => type === SyncEntityType.AlbumDeleteV2)).toHaveLength(1);
  await ctx.syncAckAll(auth, resumed);
  await ctx.assertSyncIsComplete(auth, [request]);
});

it('clears inaccessible parent links and refreshes multiple children on parent grant/revoke with tuple resume', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { user: owner } = await ctx.newUser();
  const { album: parent } = await ctx.newAlbum({
    ownerId: owner.id,
    kind: AlbumKind.Collection,
    albumName: 'Private parent',
  });
  const children = [];
  for (let i = 0; i < 2; i++) {
    const { album } = await ctx.newAlbum({ ownerId: owner.id, parentId: parent.id });
    children.push(album);
    await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id, role: AlbumUserRole.Viewer });
  }
  const first = await ctx.syncStream(auth, [request]);
  expect(rows(first)).toHaveLength(2);
  expect(rows(first).every(({ data }) => data.parentId === null)).toBe(true);
  expect(JSON.stringify(first)).not.toContain(parent.id);
  expect(JSON.stringify(first)).not.toContain('Private parent');
  await ctx.syncAckAll(auth, first);
  await ctx.newAlbumUser({ albumId: parent.id, userId: auth.user.id, role: AlbumUserRole.Viewer });
  const grant = await ctx.syncStream(auth, [request]);
  expect(rows(grant)).toHaveLength(3);
  expect(
    rows(grant)
      .filter(({ data }) => data.id !== parent.id)
      .every(({ data }) => data.parentId === parent.id),
  ).toBe(true);
  const grantedChildren = rows(grant).filter(({ data }) => data.id !== parent.id);
  await ctx.sut.setAcks(auth, { acks: [grantedChildren[0]!.ack] });
  const resumed = await ctx.syncStream(auth, [request]);
  expect(rows(resumed).some(({ data }) => data.id === grantedChildren[1]!.data.id)).toBe(true);
  await ctx.syncAckAll(auth, resumed);
  await db.deleteFrom('album_user').where('albumId', '=', parent.id).where('userId', '=', auth.user.id).execute();
  const revoke = await ctx.syncStream(auth, [request]);
  expect(rows(revoke)).toHaveLength(2);
  expect(rows(revoke).every(({ data }) => data.parentId === null)).toBe(true);
  expect(revoke.find(({ type }) => type === SyncEntityType.AlbumDeleteV2)?.data).toEqual({ albumId: parent.id });
  await ctx.syncAckAll(auth, revoke);
  await ctx.assertSyncIsComplete(auth, [request]);
});

it('delivers updates and an old album newly shared after a partial bootstrap watermark', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { user: owner } = await ctx.newUser();
  const { album: privateAlbum } = await ctx.newAlbum({ ownerId: owner.id, createdAt: '2000-01-01T00:00:00Z' });
  const { album: firstAlbum } = await ctx.newAlbum({ ownerId: auth.user.id });
  const first = await ctx.syncStream(auth, [request]);
  await ctx.sut.setAcks(auth, { acks: [rows(first)[0]!.ack] });
  await db.updateTable('album').set({ icon: 'changed' }).where('id', '=', firstAlbum.id).execute();
  await ctx.newAlbumUser({ albumId: privateAlbum.id, userId: auth.user.id, role: AlbumUserRole.Viewer });
  const next = await ctx.syncStream(auth, [request]);
  expect(
    rows(next)
      .map(({ data }) => data.id)
      .sort((a, b) => a.localeCompare(b)),
  ).toEqual([privateAlbum.id, firstAlbum.id].sort((a, b) => a.localeCompare(b)));
  expect(rows(next).every(({ ack }) => ack.startsWith('AlbumV3|'))).toBe(true);
  await ctx.syncAckAll(auth, next);
  await ctx.assertSyncIsComplete(auth, [request]);
});

it('keeps AlbumsV2 payload and ordering unchanged', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { album } = await ctx.newAlbum({ ownerId: auth.user.id, icon: 'not-in-v2', kind: AlbumKind.Collection });
  const old = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2]);
  const data = old.find(({ type }) => type === SyncEntityType.AlbumV2)!.data;
  expect(data.id).toBe(album.id);
  for (const field of ['parentId', 'kind', 'icon', 'sortOrder', 'deletedAt']) expect(data).not.toHaveProperty(field);
  expect(old.some(({ type }) => type === SyncEntityType.SyncAckV1)).toBe(false);
});

it.each([
  'bad-base64',
  Buffer.from(JSON.stringify(['0000-01-01T00:00:00.000001Z', '00000000-0000-4000-8000-000000000000'])).toString(
    'base64url',
  ),
])('rejects malformed album bootstrap cursors before persistence %s', async (cursor) => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  await expect(
    ctx.sut.setAcks(auth, { acks: [`AlbumBootstrapV1|00000000-0000-4000-8000-000000000000|${cursor}`] }),
  ).rejects.toThrow('Invalid asset bootstrap cursor');
});

it.each([
  'AlbumV3|not-a-uuid|00000000-0000-4000-8000-000000000000',
  'AlbumV3|00000000-0000-4000-8000-000000000000|not-a-uuid',
  'AlbumDeleteV2|not-a-uuid',
])('rejects malformed album progress acknowledgement %s', async (ack) => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  await expect(ctx.sut.setAcks(auth, { acks: [ack] })).rejects.toThrow('Invalid album sync acknowledgement');
});

it('resumes created-at UUID ties without skipping an album', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const { album } = await ctx.newAlbum({ ownerId: auth.user.id, createdAt: '2026-01-01T00:00:00.123456Z' });
    ids.push(album.id);
  }
  const first = await ctx.syncStream(auth, [request]);
  expect(rows(first).map(({ data }) => data.id)).toEqual(ids.sort((a, b) => a.localeCompare(b)).toReversed());
  await ctx.sut.setAcks(auth, { acks: [rows(first)[0]!.ack] });
  const resumed = await ctx.syncStream(auth, [request]);
  expect(rows(resumed).map(({ data }) => data.id)).toEqual([ids[0]]);
});

it('streams parent hard-delete cascade tombstones for owned child albums', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { album: parent } = await ctx.newAlbum({ ownerId: auth.user.id, kind: AlbumKind.Collection });
  const { album: child } = await ctx.newAlbum({ ownerId: auth.user.id, parentId: parent.id });
  await ctx.syncAckAll(auth, await ctx.syncStream(auth, [request]));
  await db.deleteFrom('album').where('id', '=', parent.id).execute();
  const next = await ctx.syncStream(auth, [request]);
  expect(
    next
      .filter(({ type }) => type === SyncEntityType.AlbumDeleteV2)
      .map(({ data }) => data.albumId)
      .sort((a, b) => a.localeCompare(b)),
  ).toEqual([parent.id, child.id].sort((a, b) => a.localeCompare(b)));
  await ctx.syncAckAll(auth, next);
  await ctx.assertSyncIsComplete(auth, [request]);
});
