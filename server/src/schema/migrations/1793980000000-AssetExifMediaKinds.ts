import { Kysely, sql } from 'kysely';

/**
 * FL-1284: the kinds of capture a file's metadata shows (slow motion, panorama, burst, portrait …).
 * Existing rows get the kinds already readable from stored metadata; the rest arrive with the next
 * metadata scan of each file.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_exif ADD COLUMN "mediaKinds" character varying[]`.execute(db);
  await sql`CREATE INDEX "asset_exif_mediaKinds_idx" ON public.asset_exif USING gin ("mediaKinds")`.execute(db);
  await sql`
    UPDATE public.asset_exif e
    SET "mediaKinds" = kinds.value
    FROM (
      SELECT a.id,
        array_remove(ARRAY[
          CASE WHEN a.type = 'VIDEO' AND x.fps >= 100 AND x.make ILIKE 'apple' THEN 'slow-motion' END,
          CASE WHEN upper(coalesce(x."projectionType", '')) = 'CYLINDRICAL' THEN 'panorama' END,
          CASE WHEN upper(coalesce(x."projectionType", '')) = 'EQUIRECTANGULAR'
            OR lower(a."originalFileName") LIKE '%.insp' THEN 'spherical' END,
          CASE WHEN a.type = 'IMAGE' AND x."autoStackId" IS NOT NULL AND x.make ILIKE 'apple' THEN 'burst' END,
          CASE WHEN x."lensModel" ~* '\\mfront\\M' THEN 'selfie' END,
          CASE WHEN a.type = 'IMAGE' AND a."originalFileName" ~* 'screen[ _-]?shot|screen[ _-]?capture|bildschirmfoto|captura de pantalla|schermafbeelding|schermata' THEN 'screenshot' END,
          CASE WHEN a.type = 'VIDEO' AND a."originalFileName" ~* 'screen[ _-]?record' THEN 'screen-recording' END
        ]::character varying[], NULL) AS value
      FROM public.asset a
      JOIN public.asset_exif x ON x."assetId" = a.id
    ) kinds
    WHERE e."assetId" = kinds.id AND cardinality(kinds.value) > 0
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public."asset_exif_mediaKinds_idx"`.execute(db);
  await sql`ALTER TABLE public.asset_exif DROP COLUMN "mediaKinds"`.execute(db);
}
