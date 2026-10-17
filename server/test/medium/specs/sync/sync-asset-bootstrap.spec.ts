import { Kysely, sql } from 'kysely';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;

beforeAll(async () => {
  db = await getKyselyDB();
});

it('paints the newest own asset first during a full sync', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { asset: older } = await ctx.newAsset({ ownerId: auth.user.id, localDateTime: '2020-01-01T00:00:00Z' });
  const { asset: newer } = await ctx.newAsset({ ownerId: auth.user.id, localDateTime: '2026-01-01T00:00:00Z' });
  const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV3]);
  expect(response.filter((item) => item.type === SyncEntityType.AssetV3).map((item) => item.data.id)).toEqual([
    newer.id,
    older.id,
  ]);
});

it('resumes a partial bootstrap with exact microsecond dates and UUID ties', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const assets = [];
  for (const date of ['2026-01-01T00:00:00.123456Z', '2026-01-01T00:00:00.123457Z', '2026-01-01T00:00:00.123457Z']) {
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id, localDateTime: date });
    assets.push(asset);
  }
  const expected = [...[assets[1]!.id, assets[2]!.id].sort().toReversed(), assets[0]!.id];
  const first = await ctx.syncStream(auth, [SyncRequestType.AssetsV3]);
  const rows = first.filter((item) => item.type === SyncEntityType.AssetV3);
  expect(rows.map((item) => item.data.id)).toEqual(expected);
  const cursor = JSON.parse(Buffer.from(rows[0]!.ack.split('|', 3)[2]!, 'base64url').toString());
  expect(cursor).toEqual(['2026-01-01T00:00:00.123457Z', expected[0]]);
  await ctx.sut.setAcks(auth, { acks: [rows[0]!.ack] });
  const resumed = await ctx.syncStream(auth, [SyncRequestType.AssetsV3]);
  expect(resumed.filter((item) => item.type === SyncEntityType.AssetV3).map((item) => item.data.id)).toEqual(
    expected.slice(1),
  );
  const complete = resumed.find((item) => item.type === SyncEntityType.SyncAckV1)!;
  expect(complete.ack).toBe(`${SyncEntityType.AssetBootstrapV1}|${rows[0]!.ack.split('|', 3)[1]}|complete`);
  await ctx.syncAckAll(auth, resumed);
  await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV3]);
});

it('delivers updates and deletes made during bootstrap as ascending deltas', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { asset: older } = await ctx.newAsset({ ownerId: auth.user.id, localDateTime: '2020-01-01T00:00:00Z' });
  const { asset: newer } = await ctx.newAsset({ ownerId: auth.user.id, localDateTime: '2026-01-01T00:00:00Z' });
  const first = await ctx.syncStream(auth, [SyncRequestType.AssetsV3]);
  const partial = first.find((item) => item.type === SyncEntityType.AssetV3)!;
  await ctx.sut.setAcks(auth, { acks: [partial.ack] });
  await db.updateTable('asset').set({ isFavorite: true }).where('id', '=', older.id).execute();
  const { asset: latest } = await ctx.newAsset({ ownerId: auth.user.id, localDateTime: '2030-01-01T00:00:00Z' });
  await ctx.get(AssetRepository).remove(newer);
  const resumed = await ctx.syncStream(auth, [SyncRequestType.AssetsV3]);
  const deltas = resumed.filter((item) => item.type === SyncEntityType.AssetV3);
  expect(deltas.map((item) => item.data.id).toSorted((a, b) => a.localeCompare(b))).toEqual(
    [older.id, latest.id].toSorted((a, b) => a.localeCompare(b)),
  );
  expect(deltas.find((item) => item.data.id === older.id)!.data.isFavorite).toBe(true);
  expect(deltas.map((item) => item.ack)).toEqual(deltas.map((item) => item.ack).toSorted((a, b) => a.localeCompare(b)));
  expect(deltas.every((item) => item.ack.startsWith(`${SyncEntityType.AssetV3}|`))).toBe(true);
  expect(resumed.find((item) => item.type === SyncEntityType.AssetDeleteV2)?.data).toEqual({ assetId: newer.id });
  await ctx.syncAckAll(auth, resumed);
  await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV3]);
});

it('does not replace a newer ordinary delta acknowledgement with the bootstrap floor', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
  const first = await ctx.syncStream(auth, [SyncRequestType.AssetsV3]);
  const bootstrap = first.find((item) => item.type === SyncEntityType.AssetV3)!;
  await ctx.sut.setAcks(auth, { acks: [bootstrap.ack] });
  await db.updateTable('asset').set({ isFavorite: true }).where('id', '=', asset.id).execute();
  const resumed = await ctx.syncStream(auth, [SyncRequestType.AssetsV3]);
  const delta = resumed.find((item) => item.type === SyncEntityType.AssetV3)!;
  expect(delta.ack.startsWith(`${SyncEntityType.AssetV3}|`)).toBe(true);
  await ctx.sut.setAcks(auth, { acks: [delta.ack] });
  const replay = await ctx.syncStream(auth, [SyncRequestType.AssetsV3]);
  expect(replay.some((item) => item.type === SyncEntityType.AssetV3)).toBe(false);
  await ctx.syncAckAll(auth, replay);
  await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV3]);
});

it('retains oldest update first compatibility for AssetsV2', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { asset: older } = await ctx.newAsset({ ownerId: auth.user.id, localDateTime: '2020-01-01T00:00:00Z' });
  const { asset: newer } = await ctx.newAsset({ ownerId: auth.user.id, localDateTime: '2026-01-01T00:00:00Z' });
  const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
  expect(response.filter((item) => item.type === SyncEntityType.AssetV2).map((item) => item.data.id)).toEqual([
    older.id,
    newer.id,
  ]);
  expect(response.some((item) => item.type === SyncEntityType.SyncAckV1)).toBe(false);
});

it('limits bootstrap and deltas to the current owner', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { user: other } = await ctx.newUser();
  await ctx.newAsset({ ownerId: other.id });
  const { asset: own } = await ctx.newAsset({ ownerId: auth.user.id });
  const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV3]);
  expect(response.filter((item) => item.type === SyncEntityType.AssetV3).map((item) => item.data.id)).toEqual([own.id]);
});

it.each([
  'not-base64',
  Buffer.from(JSON.stringify(['2026-02-30T00:00:00.000001Z', '00000000-0000-4000-8000-000000000000'])).toString(
    'base64url',
  ),
  Buffer.from(JSON.stringify(['2026-01-01T00:00:00.000Z', '00000000-0000-4000-8000-000000000000'])).toString(
    'base64url',
  ),
])('rejects a malformed bootstrap cursor %s before persisting it', async (cursor) => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const watermark = '00000000-0000-4000-8000-000000000000';
  await expect(
    ctx.sut.setAcks(auth, { acks: [`${SyncEntityType.AssetBootstrapV1}|${watermark}|${cursor}`] }),
  ).rejects.toThrow('Invalid asset bootstrap cursor');
});

it('resumes UUID ties at null dates using the negative-infinity cursor', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { asset: dated } = await ctx.newAsset({ ownerId: auth.user.id });
  const { asset: a } = await ctx.newAsset({ ownerId: auth.user.id });
  const { asset: b } = await ctx.newAsset({ ownerId: auth.user.id });
  // Historical nullable schemas are supported without changing the production schema.
  await sql`ALTER TABLE asset ALTER COLUMN "localDateTime" DROP NOT NULL`.execute(db);
  try {
    await sql`UPDATE asset SET "localDateTime" = null WHERE id IN (${a.id}::uuid, ${b.id}::uuid)`.execute(db);
    const first = await ctx.syncStream(auth, [SyncRequestType.AssetsV3]);
    const rows = first.filter((item) => item.type === SyncEntityType.AssetV3);
    const ties = [a.id, b.id].sort().toReversed();
    expect(rows.map((item) => item.data.id)).toEqual([dated.id, ...ties]);
    expect(JSON.parse(Buffer.from(rows[1]!.ack.split('|', 3)[2]!, 'base64url').toString())).toEqual([
      '-infinity',
      ties[0],
    ]);
    await ctx.sut.setAcks(auth, { acks: [rows[1]!.ack] });
    const resumed = await ctx.syncStream(auth, [SyncRequestType.AssetsV3]);
    expect(resumed.filter((item) => item.type === SyncEntityType.AssetV3).map((item) => item.data.id)).toEqual([
      ties[1],
    ]);
  } finally {
    await sql`UPDATE asset SET "localDateTime" = now() WHERE "localDateTime" IS NULL`.execute(db);
    await sql`ALTER TABLE asset ALTER COLUMN "localDateTime" SET NOT NULL`.execute(db);
  }
});

it('reuses hidden-content filtering for initial bootstrap and subsequent deltas', async () => {
  const ctx = new SyncTestContext(db);
  const { auth } = await ctx.newSyncAuthUser();
  const { asset: hidden } = await ctx.newAsset({ ownerId: auth.user.id, is_nsfw: true });
  const { asset: visible } = await ctx.newAsset({ ownerId: auth.user.id, is_nsfw: false });
  const restricted = { ...auth, hideNsfwAssets: true };
  const first = await ctx.syncStream(restricted, [SyncRequestType.AssetsV3]);
  expect(first.filter((item) => item.type === SyncEntityType.AssetV3).map((item) => item.data.id)).toEqual([
    visible.id,
  ]);
  await ctx.syncAckAll(restricted, first);
  await db.updateTable('asset').set({ isFavorite: true }).where('id', 'in', [hidden.id, visible.id]).execute();
  const next = await ctx.syncStream(restricted, [SyncRequestType.AssetsV3]);
  expect(next.filter((item) => item.type === SyncEntityType.AssetV3).map((item) => item.data.id)).toEqual([visible.id]);
});
