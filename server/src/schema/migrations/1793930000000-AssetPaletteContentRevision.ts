import { Kysely, sql } from 'kysely';

/**
 * A palette's revision now covers only what changes the image's pixels (`assetPaletteRevision`). Palettes already
 * worked out are stamped with the new revision here, so none of them is decoded again because the formula changed.
 * The expression is a frozen copy of `assetPaletteRevision('a')` as of this migration.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`UPDATE asset_palette p SET "sourceRevision" = md5(jsonb_build_array(
    a.checksum, a."fileModifiedAt", a."isEdited", lower(substring(a."originalFileName" from '[.]([^.]*)$')),
    (select jsonb_agg(jsonb_build_array(e.action, e.parameters) order by e.sequence, e.id) from asset_edit e where e."assetId" = a.id),
    (select x.orientation from asset_exif x where x."assetId" = a.id),
    (select jsonb_agg(jsonb_build_array(d.id, d.status) order by d.id) from asset_develop_revision d where d."assetId" = a.id and d."ownerId" = a."ownerId" and d."isCurrent"),
    (select m."coverTimestampMs" from video_moment_index m where m."assetId" = a.id)
  )::text)
  FROM asset a WHERE a.id = p."assetId" AND p.status = 'ready' AND p.version = 1`.execute(db);
}

/** The old revisions cannot be recomputed for the old formula without decoding again; nothing to undo. */
export async function down(): Promise<void> {}
