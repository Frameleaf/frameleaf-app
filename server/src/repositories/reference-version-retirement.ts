import { type Transaction, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import type { SourceReference } from 'src/utils/source-reference.js';
import { columns } from 'src/database.js';
import { AssetMetadataKey } from 'src/enum.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { DocumentRepository } from 'src/repositories/document.repository.js';
import { lockFilePath } from 'src/repositories/physical-file.repository.js';
import { VideoMomentRepository } from 'src/repositories/video-moment.repository.js';
import { AssetSourceChangedError, readAssetSource } from 'src/utils/asset-source-authority.js';
import { withoutGeneratedDescriptionBlocks } from 'src/utils/generated-description.js';

/** DB-only retirement; source authority and queue catalogue are already locked by the publisher. */
export async function retireReferenceVersion(tx: Transaction<DB>, assetId: string, previous: SourceReference) {
  const source = await readAssetSource(tx, assetId, false);
  if (!source) throw new AssetSourceChangedError();
  const edits = new AssetEditRepository(tx);
  const ids = await edits.sourceProjectionAssetIds(source);
  // Classification and file publication both take their advisory locks before asset rows.
  for (const id of ids) await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${id})::int)`.execute(tx);
  const paths = async () => {
    const { rows } = await sql<{ path: string }>`SELECT path FROM asset_file
      WHERE "assetId"=${assetId}::uuid OR ("assetId"=ANY(${ids}::uuid[]) AND "isEdited")
      UNION SELECT path FROM video_moment_frame WHERE "assetId"=${assetId}::uuid
      UNION SELECT path FROM asset_video_duplicate_frame WHERE "assetId"=${assetId}::uuid`.execute(tx);
    return rows.map(({ path }) => path).sort();
  };
  const locked = new Set(await paths());
  for (const path of locked) await lockFilePath(tx, path);
  await tx.selectFrom('asset').select('id').where('id', 'in', ids).orderBy('id').forUpdate().execute();
  if ((await paths()).some((path) => !locked.has(path))) throw new AssetSourceChangedError();
  if ((await edits.sourceProjectionAssetIds(source)).some((id) => !ids.includes(id)))
    throw new AssetSourceChangedError();
  await new DocumentRepository(tx).archiveForSourceChange(assetId, previous);
  const retired = await edits.retireSourceProjection(source, async () => {});
  const moments = new VideoMomentRepository(tx);
  const index = await moments.getIndex(assetId);
  if (index) {
    const fingerprint = (await moments.getFingerprints([assetId])).get(assetId);
    if (!fingerprint) throw new AssetSourceChangedError();
    retired.paths.push(
      ...(await moments.invalidateGenerated(assetId, fingerprint, source, index.sourceFingerprint, async () => {})),
    );
  }
  const removed = await tx.deleteFrom('asset_file').where('assetId', '=', assetId).returning('path').execute();
  const frames = await tx
    .deleteFrom('asset_video_duplicate_frame')
    .where('assetId', '=', assetId)
    .returning('path')
    .execute();
  retired.paths.push(...removed.map(({ path }) => path), ...frames.map(({ path }) => path));

  const metadata = await tx
    .selectFrom('asset_metadata')
    .selectAll()
    .where('assetId', '=', assetId)
    .where('key', '=', AssetMetadataKey.MlEnrichment)
    .executeTakeFirst();
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const description = record(metadata?.value.description);
  const generated = record(description.result).description;
  const exif = await tx.selectFrom('asset_exif').selectAll().where('assetId', '=', assetId).executeTakeFirst();
  if (
    exif &&
    description.status === 'success' &&
    typeof description.appliedDescriptionHash === 'string' &&
    typeof generated === 'string'
  ) {
    await tx
      .updateTable('asset_exif')
      .set({ description: withoutGeneratedDescriptionBlocks(exif.description, [generated]) })
      .where('assetId', '=', assetId)
      .execute();
  }
  const generatedTags = [description, record(metadata?.value.nsfwDetection)].flatMap((task) =>
    task.status === 'success' && Array.isArray(task.appliedTagValues)
      ? task.appliedTagValues.filter((value): value is string => typeof value === 'string')
      : [],
  );
  if (generatedTags.length > 0) {
    await tx
      .deleteFrom('tag_asset')
      .where('assetId', '=', assetId)
      .where(
        'tagId',
        'in',
        tx.selectFrom('tag').select('id').where('userId', '=', source.ownerId).where('value', 'in', generatedTags),
      )
      .execute();
    await sql`UPDATE asset_exif SET tags=(SELECT array_agg(t.value ORDER BY t.value) FROM tag_asset a JOIN tag t ON t.id=a."tagId" WHERE a."assetId"=${assetId}::uuid)
      WHERE "assetId"=${assetId}::uuid`.execute(tx);
  }
  if (metadata) {
    // Preserve reviews as history, while a previous safe review must not classify new pixels.
    await tx
      .insertInto('asset_metadata')
      .values({
        assetId,
        key: `${metadata.key}:source-version:${previous.resourceId}:${metadata.updateId}`,
        value: metadata.value,
      })
      .onConflict((oc) => oc.columns(['assetId', 'key']).doNothing())
      .execute();
    // Keep the conservative is_nsfw projection and all privacy locks until fresh classification.
    await tx
      .deleteFrom('asset_metadata')
      .where('assetId', '=', assetId)
      .where('key', '=', AssetMetadataKey.MlEnrichment)
      .execute();
  }
  const reset = columns.exif.filter(
    (column) =>
      ![
        'asset_exif.assetId',
        'asset_exif.description',
        ...(generatedTags.length > 0 ? ['asset_exif.tags'] : []),
      ].includes(column),
  );
  await sql`UPDATE asset_exif SET ${sql.join(
    reset.map((column) => {
      const name = column.slice('asset_exif.'.length);
      return sql`${sql.id(name)}=CASE WHEN ${name}=ANY(coalesce("lockedProperties",'{}'::varchar[])) THEN ${sql.ref(column)} ELSE NULL END`;
    }),
  )} WHERE "assetId"=${assetId}::uuid`.execute(tx);
  await tx
    .deleteFrom('asset_metadata')
    .where('assetId', '=', assetId)
    .where('key', '=', 'camera-identification')
    .where(
      sql<boolean>`NOT EXISTS (SELECT 1 FROM asset_exif e WHERE e."assetId"=${assetId}::uuid AND coalesce(e."lockedProperties" && array['make','model']::varchar[],false))`,
    )
    .execute();
  await tx
    .deleteFrom('face_search')
    .where('faceId', 'in', tx.selectFrom('asset_face').select('id').where('assetId', '=', assetId))
    .execute();
  await tx
    .updateTable('asset_face')
    .set({ deletedAt: new Date(), isVisible: false })
    .where('assetId', '=', assetId)
    .where('deletedAt', 'is', null)
    .execute();
  await tx.deleteFrom('pet_detection').where('assetId', '=', assetId).execute();
  await tx
    .updateTable('pet_observation')
    .set({ staleAt: new Date(), updatedAt: new Date() })
    .where('assetId', '=', assetId)
    .where('staleAt', 'is', null)
    .execute();
  for (const table of [
    'asset_audio',
    'asset_video',
    'asset_keyframe',
    'asset_job_status',
    'asset_ocr',
    'ocr_search',
    'smart_search',
    'smart_search_description',
    'asset_best_photo_score',
    'smart_album_asset',
    'video_stream_session',
  ] as const) {
    await tx.deleteFrom(table).where('assetId', '=', assetId).execute();
  }
  await tx
    .updateTable('asset_restoration')
    .set({ isCurrent: false })
    .where('assetId', '=', assetId)
    .where('isCurrent', '=', true)
    .execute();
  await tx.updateTable('asset').set({ duration: null, duplicateId: null }).where('id', '=', assetId).execute();
  return { files: [...new Set(retired.paths)].sort(), projections: retired.assetIds.filter((id) => id !== assetId) };
}
