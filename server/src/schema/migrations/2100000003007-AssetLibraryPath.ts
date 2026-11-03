import { Kysely, sql } from 'kysely';

/**
 * FL-417: a photo that shares a stored file keeps its own path for display, folders and path search.
 *
 * Photos already linked to a file outside their owner's folder get a path built from their owner's own
 * folder (storage label, else user id) and their own date and file name, in the server's default
 * layout; nothing of the other account's path is carried over. The storage template refines it the next
 * time it runs for the photo.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset" ADD "libraryPath" character varying`.execute(db);
  await backfillLibraryPaths(db);
}

/** Exported for the FL-417 medium test. Idempotent: only photos with no library path yet. */
export async function backfillLibraryPaths(db: Kysely<any>): Promise<void> {
  await sql`
    WITH linked AS (
      SELECT
        a.id,
        a."originalPath" AS path,
        replace(a."originalFileName", '/', '_') AS "fileName",
        a."localDateTime" AT TIME ZONE 'UTC' AS "localDate",
        u.id::text AS "ownerId",
        coalesce(nullif(u."storageLabel", ''), u.id::text) AS label,
        regexp_match(a."originalPath", '^(.*)/(library|upload)/([^/]+)/') AS root
      FROM "asset" a
      JOIN "user" u ON u.id = a."ownerId"
      WHERE a."physicalOriginalFileId" IS NOT NULL
        AND a."libraryPath" IS NULL
        AND a."libraryId" IS NULL
        AND NOT a."isExternal"
    )
    UPDATE "asset"
    SET "libraryPath" = CASE
      WHEN linked.root[2] = 'upload' THEN
        linked.root[1] || '/upload/' || linked."ownerId" || '/' || substr(linked.id::text, 1, 2) || '/'
          || substr(linked.id::text, 3, 2) || '/' || linked.id::text
          || coalesce(substring(linked.path from '(\\.[^./]+)$'), '')
      ELSE
        coalesce(linked.root[1], '') || '/library/' || linked.label || '/' || to_char(linked."localDate", 'YYYY')
          || '/' || to_char(linked."localDate", 'YYYY-MM-DD') || '/' || linked."fileName"
    END
    FROM linked
    WHERE "asset".id = linked.id
      AND (
        linked.root IS NULL
        OR NOT (
          linked.root[3] = linked."ownerId"
          OR (linked.root[2] = 'library' AND linked.root[3] = linked.label)
        )
      )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset" DROP COLUMN "libraryPath"`.execute(db);
}
