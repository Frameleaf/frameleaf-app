import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoLocationsRepository } from 'src/repositories/photo-locations.repository.js';
import { DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/2100000003034-PhotoLocations.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
  await down(db);
  await up(db);
});
afterAll(async () => {
  await db?.destroy();
});

const match = {
  provider: 'google' as const,
  placeId: 'cafe-id',
  name: 'Cafe',
  address: 'Main Street',
  mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Cafe&query_place_id=cafe-id',
  relation: 'near' as const,
  confidence: 'medium' as const,
  distanceM: 30,
  matchedAt: '2026-10-31T12:00:00Z',
  attributions: [],
};

async function setup() {
  const ctx = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }).ctx;
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  await db
    .insertInto('asset_exif')
    .values({ assetId: asset.id, latitude: 49, longitude: -123, gpsAccuracyM: 5 })
    .onConflict((oc) => oc.column('assetId').doUpdateSet({ latitude: 49, longitude: -123, gpsAccuracyM: 5 }))
    .execute();
  const repo = new PhotoLocationsRepository(db);
  const created = await repo.create(user.id, false, {
    cloudUrl: 'https://cloud.invalid',
    instanceId: randomUUID(),
    linkedAt: 'test',
  });
  const token = randomUUID();
  await db
    .updateTable('photo_location_scan')
    .set({ leaseToken: token, leaseUntil: new Date(Date.now() + 300_000) })
    .where('id', '=', created.id)
    .execute();
  const scan = (await repo.get(created.id, user.id))!;
  return { ctx, user, asset, repo, scan, token };
}

it('publishes once, preserves geography, and omits the suggestion when metadata is stripped', async () => {
  const { user, asset, repo, scan, token } = await setup();
  expect(await repo.freeze(scan)).toBe(1);
  const [point] = await repo.points(scan);
  const result = [{ itemKey: point.itemKey, state: 'matched' as const, match }];
  expect(await repo.adopt(scan.id, token, result)).toBe(true);
  expect(await repo.adopt(scan.id, token, result)).toBe(true);
  const stored = (await new AssetRepository(db).getById(asset.id, { exifInfo: true }))!;
  expect(mapAsset(stored).locationInsight).toEqual(match);
  expect(mapAsset(stored, { stripMetadata: true })).not.toHaveProperty('locationInsight');
  expect(stored.exifInfo?.latitude).toBe(49);
  expect((await repo.get(scan.id, user.id))?.processed).toBe(1);
  expect(await repo.get(scan.id, randomUUID())).toBeUndefined();
  await expect(
    repo.create(user.id, false, { cloudUrl: 'https://cloud.invalid', instanceId: randomUUID(), linkedAt: 'test' }),
  ).rejects.toThrow();
});

it('coordinate edits invalidate saved results and old work even when moved back to the original point', async () => {
  const { asset, repo, scan, token } = await setup();
  await repo.freeze(scan);
  const [point] = await repo.points(scan);
  await repo.adopt(scan.id, token, [{ itemKey: point.itemKey, state: 'matched', match }]);
  await db.updateTable('asset_exif').set({ latitude: 50 }).where('assetId', '=', asset.id).execute();
  await db.updateTable('asset_exif').set({ latitude: 49 }).where('assetId', '=', asset.id).execute();
  await repo.adopt(scan.id, token, [{ itemKey: point.itemKey, state: 'matched', match }]);
  expect(await db.selectFrom('asset_location_insight').selectAll().where('assetId', '=', asset.id).execute()).toEqual(
    [],
  );
  expect(await repo.points(scan)).toEqual([]);
});

it('cancellation fences late adoption and owner dismissal survives a refreshed scan', async () => {
  const { user, asset, repo, scan, token } = await setup();
  await repo.freeze(scan);
  const [point] = await repo.points(scan);
  await repo.cancel(scan.id, user.id);
  expect(await repo.adopt(scan.id, token, [{ itemKey: point.itemKey, state: 'matched', match }])).toBe(false);
  expect(await repo.dismiss(asset.id, randomUUID())).toBe(false);
  expect(await repo.dismiss(asset.id, user.id)).toBe(true);
  await db
    .updateTable('asset_exif')
    .set({ description: 'A new caption', lockedProperties: ['description'] })
    .where('assetId', '=', asset.id)
    .execute();
  expect(
    (await db.selectFrom('asset_location_insight').selectAll().where('assetId', '=', asset.id).executeTakeFirst())
      ?.dismissed,
  ).toBe(true);
  const next = await repo.create(user.id, true, {
    cloudUrl: 'https://cloud.invalid',
    instanceId: randomUUID(),
    linkedAt: 'test',
  });
  const nextToken = randomUUID();
  await db.updateTable('photo_location_scan').set({ leaseToken: nextToken }).where('id', '=', next.id).execute();
  expect(await repo.freeze({ ...next, leaseToken: nextToken })).toBe(0);
  expect(
    (await db.selectFrom('asset_location_insight').selectAll().where('assetId', '=', asset.id).executeTakeFirst())
      ?.dismissed,
  ).toBe(true);
});

it('excludes hidden, sensitive, trashed and foreign photos while accepting archive and zero on one axis', async () => {
  const { ctx, user, asset, repo, scan } = await setup();
  await db.updateTable('asset').set({ visibility: AssetVisibility.Archive }).where('id', '=', asset.id).execute();
  await db.updateTable('asset_exif').set({ latitude: 0 }).where('assetId', '=', asset.id).execute();
  const { user: other } = await ctx.newUser();
  for (const patch of [
    { visibility: AssetVisibility.Hidden },
    { is_nsfw: true },
    { deletedAt: new Date() },
    { ownerId: other.id },
  ]) {
    const { asset: extra } = await ctx.newAsset({ ownerId: user.id, ...patch });
    await db
      .insertInto('asset_exif')
      .values({ assetId: extra.id, latitude: 49, longitude: -123 })
      .onConflict((oc) => oc.column('assetId').doUpdateSet({ latitude: 49, longitude: -123 }))
      .execute();
  }
  expect(await repo.freeze(scan)).toBe(1);
  expect((await repo.points(scan)).map((p) => p.assetId)).toEqual([asset.id]);
});
