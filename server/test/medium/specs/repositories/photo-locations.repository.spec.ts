import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PhotoLocationsRepository } from 'src/repositories/photo-locations.repository.js';
import { DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/2100000003034-PhotoLocations.js';
import { down as billingDown, up as billingUp } from 'src/schema/migrations/2100000003035-PhotoLocationBilling.js';
import { BaseService } from 'src/services/base.service.js';
import { cloudMlJobSpentUsd } from 'src/utils/cloud-ml-job.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
  await billingDown(db);
  await down(db);
  await up(db);
  await billingUp(db);
}, 60_000);
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

it('retains checked cancellation results only under a fresh cleanup lease and current ownership, privacy and GPS', async () => {
  const { ctx, user, asset, repo, scan, token } = await setup();
  const { user: other } = await ctx.newUser();
  const extras = [];
  for (let index = 0; index < 3; index++) {
    const { asset: extra } = await ctx.newAsset({ ownerId: user.id });
    await db
      .insertInto('asset_exif')
      .values({ assetId: extra.id, latitude: 49, longitude: -123, gpsAccuracyM: 5 })
      .execute();
    extras.push(extra);
  }
  await repo.freeze(scan);
  const points = await repo.points(scan);
  const results = points.map(({ itemKey }) => ({ itemKey, state: 'matched' as const, match }));
  await repo.cancel(scan.id, user.id);
  expect(await repo.adopt(scan.id, token, results)).toBe(false);
  expect(await repo.adoptCompleted(scan.id, token, results, 4)).toBe(false);
  await db.updateTable('asset').set({ visibility: AssetVisibility.Hidden }).where('id', '=', extras[0].id).execute();
  await db.updateTable('asset_exif').set({ latitude: null }).where('assetId', '=', extras[1].id).execute();
  await db.updateTable('asset').set({ ownerId: other.id }).where('id', '=', extras[2].id).execute();
  const cleanupToken = randomUUID();
  await db
    .updateTable('photo_location_scan')
    .set({
      leaseToken: cleanupToken,
      leaseUntil: new Date(Date.now() + 300_000),
      billing: {
        currency: 'USD',
        unitPriceMicros: 5000,
        heldMicros: 20_000,
        checkedPhotos: 4,
        chargedMicros: 20_000,
        releasedMicros: 0,
        state: 'settled',
      },
    })
    .where('id', '=', scan.id)
    .execute();

  expect(await repo.cleanupActive(scan.id, token)).toBe(false);
  expect(await repo.cleanupActive(scan.id, cleanupToken)).toBe(true);
  expect(await repo.adoptCompleted(scan.id, cleanupToken, results, 3)).toBe(false);
  expect(await repo.adoptCompleted(scan.id, cleanupToken, results, 4)).toBe(true);
  expect(await repo.adoptCompleted(scan.id, cleanupToken, results, 4)).toBe(true);
  const saved = await db
    .selectFrom('asset_location_insight')
    .select('assetId')
    .where('assetId', 'in', [asset.id, ...extras.map(({ id }) => id)])
    .execute();
  expect(saved).toEqual([{ assetId: asset.id }]);
  expect(await repo.get(scan.id, user.id)).toMatchObject({
    processed: 1,
    matched: 1,
    billing: { chargedMicros: 20_000 },
  });
  await repo.clearItems(scan.id, token);
  expect(
    await db.selectFrom('photo_location_scan_item').selectAll().where('scanId', '=', scan.id).execute(),
  ).toHaveLength(3);
  await db
    .updateTable('photo_location_scan')
    .set({ leaseUntil: new Date(0) })
    .where('id', '=', scan.id)
    .execute();
  expect(await repo.adoptCompleted(scan.id, cleanupToken, results, 4)).toBe(false);
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

it('caps a deterministic snapshot and counts its exact pending or settled cost in shared AI spending', async () => {
  const { ctx, user, repo, scan } = await setup();
  for (let index = 0; index < 4; index++) {
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      ...(index === 3 ? { visibility: AssetVisibility.Hidden } : {}),
    });
    await db
      .insertInto('asset_exif')
      .values({ assetId: asset.id, latitude: 49, longitude: -123, gpsAccuracyM: 5 })
      .execute();
  }
  const eligible = await repo.countEligible(user.id, false);
  expect(eligible).toBe(4);
  await db
    .updateTable('photo_location_scan')
    .set({ estimateId: randomUUID(), eligiblePhotos: eligible, selectedPhotos: 2, estimatedMicros: 10_000 })
    .where('id', '=', scan.id)
    .execute();
  const paid = (await repo.get(scan.id, user.id))!;
  expect(await repo.freeze(paid)).toBe(2);
  const allIds = await db
    .selectFrom('asset')
    .select('id')
    .where('ownerId', '=', user.id)
    .where('visibility', '=', AssetVisibility.Timeline)
    .orderBy('id')
    .execute();
  expect((await repo.points(paid)).map(({ assetId }) => assetId)).toEqual(allIds.slice(0, 2).map(({ id }) => id));
  expect(await repo.freeze(paid)).toBe(2);
  const operations = new MediaOperationRepository(db);
  expect(cloudMlJobSpentUsd(await operations.listCloudMlJobSpend(user.id, new Date(0)))).toBe(0.01);
  expect(cloudMlJobSpentUsd(await operations.listCloudMlJobSpend(user.id, new Date(0), scan.id))).toBe(0);
  await repo.cancel(scan.id, user.id);
  expect(cloudMlJobSpentUsd(await operations.listCloudMlJobSpend(user.id, new Date(0)))).toBe(0.01);
  await db
    .updateTable('photo_location_scan')
    .set({
      billing: {
        currency: 'USD',
        unitPriceMicros: 5000,
        heldMicros: 10_000,
        checkedPhotos: 1,
        chargedMicros: 5000,
        releasedMicros: 5000,
        state: 'settled',
      },
    })
    .where('id', '=', scan.id)
    .execute();
  expect(cloudMlJobSpentUsd(await operations.listCloudMlJobSpend(user.id, new Date(0)))).toBe(0.005);
});
