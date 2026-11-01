import { Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { advanceJobProgress, jobSignal } from 'src/queue/context.js';
import { landmarkInferenceEligible } from 'src/utils/database.js';
import {
  LANDMARK_INFERENCE_WINDOW_MS,
  selectTemporalReference,
  selectVisualLandmarks,
} from 'src/utils/landmark-inference.js';

/** Predictions are associations only: no EXIF, sidecars, originals or network requests are involved. */
export const inferLandmarks = async (db: Kysely<DB>, assetId?: string): Promise<void> => {
  let after = '';
  for (;;) {
    jobSignal()?.throwIfAborted();
    const targets = await db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset.id'])
      .where(landmarkInferenceEligible())
      .where(
        sql<boolean>`not coalesce(asset_exif."lockedProperties" && array['latitude','longitude']::varchar[], false)`,
      )
      .where(
        sql<boolean>`((asset_exif.latitude is null and asset_exif.longitude is null) or exists (
        select 1 from smart_search where "assetId" = asset.id and "producerModelKey" is not null
      ))`,
      )
      .$if(!!assetId, (qb) => qb.where('asset.id', '=', assetId!))
      .$if(!!after, (qb) => qb.where('asset.id', '>', after))
      .orderBy('asset.id')
      .limit(100)
      .execute();
    for (const { id } of targets) {
      jobSignal()?.throwIfAborted();
      await inferOne(db, id);
      advanceJobProgress(1);
    }
    if (targets.length < 100 || assetId) return;
    after = targets.at(-1)!.id;
  }
};

const inferOne = async (db: Kysely<DB>, id: string): Promise<void> => {
  await db.transaction().execute(async (tx) => {
    // Serialise repeated startup, metadata and embedding followups for this item.
    const target = await tx
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.libraryId',
        'asset.fileCreatedAt',
        'asset.checksum',
        'asset_exif.make',
        'asset_exif.model',
        'asset_exif.latitude',
        'asset_exif.longitude',
      ])
      .where('asset.id', '=', id)
      .where(landmarkInferenceEligible())
      .where(
        sql<boolean>`not coalesce(asset_exif."lockedProperties" && array['latitude','longitude']::varchar[], false)`,
      )
      .forUpdate('asset')
      .executeTakeFirst();
    if (!target) return;
    await tx.deleteFrom('asset_landmark').where('assetId', '=', id).where('inference', 'is not', null).execute();

    let prediction: { landmarkIds: string[]; sourceAssetIds: string[]; inference: 'temporal' | 'visual' } | undefined;
    const donors = tx
      .selectFrom('asset as donor')
      .innerJoin('asset_exif as donor_exif', 'donor_exif.assetId', 'donor.id')
      .where('donor.ownerId', '=', target.ownerId)
      .where('donor.id', '!=', id)
      .where(landmarkInferenceEligible('donor'))
      .where('donor_exif.latitude', 'is not', null)
      .where('donor_exif.longitude', 'is not', null);

    if (target.latitude === null && target.longitude === null && target.make?.trim() && target.model?.trim()) {
      // shortcut: camera identity uses owner/library/make/model; prefer serials when metadata extraction retains them.
      const nearby = donors
        .select(['donor.id', 'donor.fileCreatedAt as takenAt', 'donor_exif.latitude', 'donor_exif.longitude'])
        .where('donor.libraryId', target.libraryId === null ? 'is' : '=', target.libraryId)
        .where('donor_exif.make', '=', target.make)
        .where('donor_exif.model', '=', target.model)
        .where('donor.fileCreatedAt', '>=', new Date(target.fileCreatedAt.getTime() - LANDMARK_INFERENCE_WINDOW_MS))
        .where('donor.fileCreatedAt', '<=', new Date(target.fileCreatedAt.getTime() + LANDMARK_INFERENCE_WINDOW_MS))
        .$narrowType<{ latitude: number; longitude: number }>();
      const before = await nearby
        .where('donor.fileCreatedAt', '<=', target.fileCreatedAt)
        .orderBy('donor.fileCreatedAt', 'desc')
        .orderBy('donor.id')
        .limit(1)
        .execute();
      const after = await nearby
        .where('donor.fileCreatedAt', '>', target.fileCreatedAt)
        .orderBy('donor.fileCreatedAt')
        .orderBy('donor.id')
        .limit(1)
        .execute();
      const reference = selectTemporalReference([...before, ...after], target.fileCreatedAt);
      const conflict =
        reference &&
        (await nearby
          .where(
            sql<boolean>`earth_distance(
        ll_to_earth_public(donor_exif.latitude, donor_exif.longitude),
        ll_to_earth_public(${reference.latitude}, ${reference.longitude})) > 200`,
          )
          .limit(1)
          .executeTakeFirst());
      if (reference && !conflict) {
        const matches = await tx
          .selectFrom('asset_landmark')
          .select('landmarkId')
          .where('assetId', '=', reference.id)
          .where('inference', 'is', null)
          .execute();
        if (matches.length > 0)
          prediction = {
            landmarkIds: matches.map(({ landmarkId }) => landmarkId),
            sourceAssetIds: [reference.id],
            inference: 'temporal',
          };
      }
    }

    if (!prediction) {
      const embedding = await tx
        .selectFrom('smart_search')
        .select(['embedding', 'producerModelKey'])
        .where('assetId', '=', id)
        .where('producerModelKey', 'is not', null)
        .executeTakeFirst();
      if (embedding) {
        await sql`set local hnsw.ef_search = 100`.execute(tx);
        await sql`set local hnsw.iterative_scan = strict_order`.execute(tx);
        const neighbours = await donors
          .innerJoin('smart_search', 'smart_search.assetId', 'donor.id')
          .where('smart_search.producerModelKey', '=', embedding.producerModelKey)
          .where('donor.checksum', '!=', target.checksum)
          .select(['donor.id', 'donor.checksum'])
          .select(sql<number>`smart_search.embedding <=> ${embedding.embedding}::vector`.as('distance'))
          .select(
            sql<
              string[]
            >`array(select "landmarkId" from asset_landmark where "assetId" = donor.id and inference is null order by "landmarkId")`.as(
              'landmarkIds',
            ),
          )
          .orderBy('distance')
          .orderBy('donor.id')
          .limit(20)
          .execute();
        const seen = new Set<string>();
        const independent = neighbours.filter(({ checksum }) => {
          const key = checksum.toString('hex');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const visual = selectVisualLandmarks(independent);
        if (visual) prediction = { ...visual, inference: 'visual' };
      }
    }
    if (prediction) {
      jobSignal()?.throwIfAborted();
      const { sourceAssetIds, inference } = prediction;
      await tx
        .insertInto('asset_landmark')
        .values(prediction.landmarkIds.map((landmarkId) => ({ assetId: id, landmarkId, sourceAssetIds, inference })))
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  });
};
