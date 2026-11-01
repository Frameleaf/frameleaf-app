import { Injectable } from '@nestjs/common';
import { Kysely, type Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { LocationScanSummary } from 'src/dtos/photo-locations.dto.js';
import type { DB } from 'src/schema/index.js';
import type { PhotoLocationScanState, PhotoLocationScanTable } from 'src/schema/tables/photo-locations.table.js';
import type { PhotoLocationInsight } from 'src/utils/photo-locations.js';
import { AssetType, AssetVisibility, UserStatus } from 'src/enum.js';
import { withHiddenContentFilter } from 'src/utils/database.js';
import { isNotLocked } from 'src/utils/locked.js';
import { LOCATION_ACTIVE_STATUSES } from 'src/utils/photo-locations.js';

export type LocationScan = Selectable<PhotoLocationScanTable>;
export type LocationResult = { itemKey: string; state: 'matched' | 'unmatched'; match?: PhotoLocationInsight };

@Injectable()
export class PhotoLocationsRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  latest(ownerId: string) {
    return this.db
      .selectFrom('photo_location_scan')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
  }

  get(id: string, ownerId: string) {
    return this.db
      .selectFrom('photo_location_scan')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
  }

  create(ownerId: string, refresh: boolean, cloud: { cloudUrl: string; instanceId: string; linkedAt: string }) {
    return this.db
      .insertInto('photo_location_scan')
      .values({
        id: randomUUID(),
        ownerId,
        refresh,
        status: 'queued',
        cloudUrl: cloud.cloudUrl,
        instanceId: cloud.instanceId,
        linkedAt: cloud.linkedAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async claim() {
    const token = randomUUID();
    const { rows } = await sql<LocationScan>`UPDATE photo_location_scan SET "leaseToken" = ${token}::uuid,
      "leaseUntil" = now() + interval '5 minutes'
      WHERE id = (SELECT id FROM photo_location_scan
        WHERE (status = ANY(${[...LOCATION_ACTIVE_STATUSES]}::text[]) OR state @> '{"cleanupPending":true}')
          AND "nextAttemptAt" <= now() AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
        ORDER BY "nextAttemptAt", "createdAt", id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`.execute(this.db);
    return rows[0];
  }

  async renew(id: string, token: string) {
    const result = await this.db
      .updateTable('photo_location_scan')
      .set({ leaseUntil: sql`now() + interval '5 minutes'` })
      .where('id', '=', id)
      .where('leaseToken', '=', token)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async active(id: string, token: string) {
    return !!(await this.db
      .selectFrom('photo_location_scan')
      .innerJoin('user', 'user.id', 'photo_location_scan.ownerId')
      .select('photo_location_scan.id')
      .where('photo_location_scan.id', '=', id)
      .where('leaseToken', '=', token)
      .where('photo_location_scan.status', 'in', LOCATION_ACTIVE_STATUSES)
      .where('user.deletedAt', 'is', null)
      .where('user.status', '=', UserStatus.Active)
      .executeTakeFirst());
  }

  async ownerActive(ownerId: string) {
    return !!(await this.db
      .selectFrom('user')
      .select('id')
      .where('id', '=', ownerId)
      .where('deletedAt', 'is', null)
      .where('status', '=', UserStatus.Active)
      .executeTakeFirst());
  }

  async inputExists(id: string) {
    return !!(await this.db
      .selectFrom('photo_location_scan')
      .innerJoin('user', 'user.id', 'photo_location_scan.ownerId')
      .select('photo_location_scan.id')
      .where('photo_location_scan.id', '=', id)
      .where('user.deletedAt', 'is', null)
      .executeTakeFirst());
  }

  async patch(
    id: string,
    token: string,
    values: Partial<LocationScanSummary> & { state?: PhotoLocationScanState; nextAttemptAt?: Date },
  ) {
    const { id: _id, ...data } = values;
    const result = await this.db
      .updateTable('photo_location_scan')
      .set(data)
      .where('id', '=', id)
      .where('leaseToken', '=', token)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw new Error('Location scan lease lost');
  }

  release(id: string, token: string, delaySeconds = 15) {
    return this.db
      .updateTable('photo_location_scan')
      .set({ leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + delaySeconds * 1000) })
      .where('id', '=', id)
      .where('leaseToken', '=', token)
      .execute();
  }

  private eligible(ownerId: string) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .innerJoin('user', 'user.id', 'asset.ownerId')
      .where('asset.ownerId', '=', ownerId)
      .where('user.deletedAt', 'is', null)
      .where('user.status', '=', UserStatus.Active)
      .where('asset.type', '=', AssetType.Image)
      .where('asset.deletedAt', 'is', null)
      .where('asset.isOffline', '=', false)
      .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
      .where('asset.is_nsfw', '=', false)
      .where(isNotLocked('asset'))
      .$call((qb) => withHiddenContentFilter(qb, { othersRulesViewerId: null }))
      .where('asset_exif.latitude', '>=', -90)
      .where('asset_exif.latitude', '<=', 90)
      .where('asset_exif.longitude', '>=', -180)
      .where('asset_exif.longitude', '<=', 180)
      .where(sql<boolean>`NOT (asset_exif.latitude = 0 AND asset_exif.longitude = 0)`);
  }

  async freeze(scan: LocationScan) {
    const selection = this.eligible(scan.ownerId)
      .where((eb) =>
        scan.refresh
          ? eb.val(true)
          : eb.not(
              eb.exists(
                eb
                  .selectFrom('asset_location_insight')
                  .select('assetId')
                  .whereRef('asset_location_insight.assetId', '=', 'asset.id')
                  .whereRef('asset_location_insight.latitude', '=', 'asset_exif.latitude')
                  .whereRef('asset_location_insight.longitude', '=', 'asset_exif.longitude'),
              ),
            ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('asset_location_insight')
              .select('assetId')
              .whereRef('asset_location_insight.assetId', '=', 'asset.id')
              .where('dismissed', '=', true),
          ),
        ),
      )
      .select([
        sql<string>`${scan.id}::uuid`.as('scanId'),
        'asset.id as assetId',
        sql<string>`gen_random_uuid()::text`.as('itemKey'),
        'asset_exif.latitude',
        'asset_exif.longitude',
        'asset_exif.gpsAccuracyM as accuracyM',
      ]);
    // A retried preparation retains the same opaque identities and never adds newly uploaded photos.
    return this.db.transaction().execute(async (tx) => {
      const live = await tx
        .selectFrom('photo_location_scan')
        .select('status')
        .where('id', '=', scan.id)
        .where('leaseToken', '=', scan.leaseToken)
        .forUpdate()
        .executeTakeFirst();
      if (!live || !LOCATION_ACTIVE_STATUSES.includes(live.status as (typeof LOCATION_ACTIVE_STATUSES)[number]))
        throw new Error('Location scan cancelled');
      if (live.status === 'queued') {
        await tx
          .insertInto('photo_location_scan_item')
          .columns(['scanId', 'assetId', 'itemKey', 'latitude', 'longitude', 'accuracyM'])
          .expression(selection)
          .execute();
        await tx.updateTable('photo_location_scan').set({ status: 'preparing' }).where('id', '=', scan.id).execute();
      }
      const count = await tx
        .selectFrom('photo_location_scan_item')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('scanId', '=', scan.id)
        .executeTakeFirstOrThrow();
      await tx
        .updateTable('photo_location_scan')
        .set({ total: Number(count.count) })
        .where('id', '=', scan.id)
        .execute();
      return Number(count.count);
    });
  }

  points(scan: LocationScan, after = '') {
    return this.eligible(scan.ownerId)
      .innerJoin('photo_location_scan_item', 'photo_location_scan_item.assetId', 'asset.id')
      .where('photo_location_scan_item.scanId', '=', scan.id)
      .where('photo_location_scan_item.assetId', '>', after || '00000000-0000-0000-0000-000000000000')
      .whereRef('photo_location_scan_item.latitude', '=', 'asset_exif.latitude')
      .whereRef('photo_location_scan_item.longitude', '=', 'asset_exif.longitude')
      .select([
        'asset.id as assetId',
        'asset.originalPath',
        'asset_exif.lockedProperties',
        'photo_location_scan_item.itemKey',
        'photo_location_scan_item.latitude',
        'photo_location_scan_item.longitude',
        'photo_location_scan_item.accuracyM',
      ])
      .orderBy('asset.id')
      .limit(500)
      .execute();
  }

  async inputStillEligible(scan: LocationScan) {
    const row = await this.eligible(scan.ownerId)
      .innerJoin('photo_location_scan_item', 'photo_location_scan_item.assetId', 'asset.id')
      .where('photo_location_scan_item.scanId', '=', scan.id)
      .whereRef('photo_location_scan_item.latitude', '=', 'asset_exif.latitude')
      .whereRef('photo_location_scan_item.longitude', '=', 'asset_exif.longitude')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count) === scan.state.pointCount;
  }

  async adopt(id: string, token: string, results: LocationResult[]) {
    return this.db.transaction().execute(async (tx) => {
      const scan = await tx
        .selectFrom('photo_location_scan')
        .selectAll()
        .where('id', '=', id)
        .where('leaseToken', '=', token)
        .where('status', 'in', LOCATION_ACTIVE_STATUSES)
        .forUpdate()
        .executeTakeFirst();
      if (!scan) return false;
      const itemKeys = results.map((r) => r.itemKey);
      // Lock coordinates before reading the snapshot: a concurrent GPS edit then clears any published result.
      await tx
        .selectFrom('asset_exif')
        .innerJoin('photo_location_scan_item', 'photo_location_scan_item.assetId', 'asset_exif.assetId')
        .select('asset_exif.assetId')
        .where('photo_location_scan_item.scanId', '=', id)
        .where('photo_location_scan_item.itemKey', 'in', itemKeys)
        .orderBy('asset_exif.assetId')
        .forUpdate('asset_exif')
        .execute();
      const rows = this.eligible(scan.ownerId)
        .innerJoin('photo_location_scan_item', 'photo_location_scan_item.assetId', 'asset.id')
        .where('photo_location_scan_item.scanId', '=', id)
        .where('photo_location_scan_item.itemKey', 'in', itemKeys)
        .where('photo_location_scan_item.completed', '=', false)
        .whereRef('photo_location_scan_item.latitude', '=', 'asset_exif.latitude')
        .whereRef('photo_location_scan_item.longitude', '=', 'asset_exif.longitude')
        .select([
          'asset.id as assetId',
          'photo_location_scan_item.itemKey',
          'photo_location_scan_item.latitude',
          'photo_location_scan_item.longitude',
        ])
        .$castTo<{ assetId: string; itemKey: string; latitude: number; longitude: number }>()
        .compile();
      const eligible = await tx.executeQuery(rows);
      const byKey = new Map(results.map((r) => [r.itemKey, r]));
      let processed = 0,
        matched = 0;
      for (const item of eligible.rows) {
        const result = byKey.get(item.itemKey)!;
        if (result.state === 'matched' && !result.match) throw new Error('Location match missing');
        const saved = await tx
          .insertInto('asset_location_insight')
          .values({
            assetId: item.assetId,
            latitude: item.latitude,
            longitude: item.longitude,
            insight: result.match ?? null,
          })
          .onConflict((oc) =>
            oc
              .column('assetId')
              .doUpdateSet({ insight: result.match ?? null, latitude: item.latitude, longitude: item.longitude })
              .where('asset_location_insight.dismissed', '=', false),
          )
          .returning('assetId')
          .executeTakeFirst();
        await tx
          .updateTable('photo_location_scan_item')
          .set({ completed: true })
          .where('scanId', '=', id)
          .where('assetId', '=', item.assetId)
          .execute();
        if (saved) {
          processed++;
          if (result.match) matched++;
        }
      }
      await tx
        .updateTable('photo_location_scan')
        .set({
          processed: sql`processed + ${processed}`,
          matched: sql`matched + ${matched}`,
          unmatched: sql`unmatched + ${processed - matched}`,
        })
        .where('id', '=', id)
        .execute();
      return true;
    });
  }

  async cancel(id: string, ownerId: string) {
    return this.db
      .updateTable('photo_location_scan')
      .set({
        status: 'cancelled',
        leaseToken: null,
        leaseUntil: null,
        state: sql`state || '{"cleanupPending":true}'::jsonb`,
        nextAttemptAt: new Date(),
      })
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .where('status', 'in', LOCATION_ACTIVE_STATUSES)
      .returningAll()
      .executeTakeFirst();
  }

  async dismiss(assetId: string, ownerId: string) {
    return this.db.transaction().execute(async (tx) => {
      const asset = await tx
        .selectFrom('asset_exif')
        .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
        .select(['asset.id', 'asset_exif.latitude', 'asset_exif.longitude'])
        .where('asset.id', '=', assetId)
        .where('asset.ownerId', '=', ownerId)
        .forUpdate('asset_exif')
        .executeTakeFirst();
      if (!asset || asset.latitude === null || asset.longitude === null) return false;
      await tx.deleteFrom('photo_location_scan_item').where('assetId', '=', assetId).execute();
      await tx
        .insertInto('asset_location_insight')
        .values({ assetId, latitude: asset.latitude, longitude: asset.longitude, insight: null, dismissed: true })
        .onConflict((oc) => oc.column('assetId').doUpdateSet({ insight: null, dismissed: true }))
        .execute();
      return true;
    });
  }

  clearItems(id: string) {
    return this.db.deleteFrom('photo_location_scan_item').where('scanId', '=', id).execute();
  }

  async finish(id: string, token: string) {
    await this.db
      .updateTable('photo_location_scan')
      .set({
        status: 'completed',
        skipped: sql`GREATEST(0, total - processed)`,
        reason: null,
        error: null,
        state: sql`state || '{"cleanupPending":true}'::jsonb`,
      })
      .where('id', '=', id)
      .where('leaseToken', '=', token)
      .where('status', 'in', LOCATION_ACTIVE_STATUSES)
      .execute();
  }
}
