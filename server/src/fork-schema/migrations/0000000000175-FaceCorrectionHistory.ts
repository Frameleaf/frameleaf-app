import { Kysely, sql } from 'kysely';

/**
 * Face correction history (FL-57). Every manual face decision an owner makes is one row: moving a
 * face to another person or to someone new, taking it off a person, "not a face of anyone", merging
 * people, and (FL-38) moving a face box. A row keeps what the face was anchored to when the decision
 * was made, so the decision outlives the face row itself:
 *
 * - `faceId` names the face; it is not a foreign key, and it is re-pointed when face detection
 *   replaces the row with a new one at the same place.
 * - `assetChecksum` is the original's checksum at the time. When the original is replaced (another
 *   checksum), a decision about the old file is never applied to the new one.
 * - `boxX1`..`boxY2` is the face box, normalized to 0..1 of the image, so a new detection of the
 *   same face (overlapping box) is recognized as the same face whatever the preview size.
 *
 * `undoneAt` marks a decision the owner undid. Only the owner reads their history.
 *
 * The same migration extends the merge-suggestion verdicts (0000000000140): `ignore` means "stop
 * suggesting this person", stored as the person paired with itself; the anchor faces
 * (`personFaceId`, `suggestionFaceId`: each person's featured face when the answer was given) let an
 * answer follow its people when facial recognition rebuilds person rows.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.face_correction (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "ownerId" uuid NOT NULL,
      "actorId" uuid NOT NULL,
      action text NOT NULL,
      "faceId" uuid,
      "assetId" uuid,
      "assetChecksum" bytea,
      "boxX1" double precision,
      "boxY1" double precision,
      "boxX2" double precision,
      "boxY2" double precision,
      "fromPersonId" uuid,
      "toPersonId" uuid,
      "fromPersonName" text,
      "toPersonName" text,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "undoneAt" timestamptz,
      CONSTRAINT face_correction_action_check CHECK (
        action = ANY (ARRAY['reassign'::text, 'new-person'::text, 'unassign'::text, 'remove'::text, 'merge'::text, 'box-move'::text])
      ),
      CONSTRAINT face_correction_anchor_check CHECK (
        action = 'merge' OR "assetId" IS NOT NULL
      ),
      CONSTRAINT face_correction_box_check CHECK (
        ("boxX1" IS NULL AND "boxY1" IS NULL AND "boxX2" IS NULL AND "boxY2" IS NULL)
        OR ("boxX1" IS NOT NULL AND "boxY1" IS NOT NULL AND "boxX2" IS NOT NULL AND "boxY2" IS NOT NULL)
      )
    )
  `.execute(db);
  await sql`
    CREATE INDEX face_correction_owner_to_idx
      ON immich_fork.face_correction ("ownerId", "toPersonId", "createdAt" DESC)
  `.execute(db);
  await sql`
    CREATE INDEX face_correction_owner_from_idx
      ON immich_fork.face_correction ("ownerId", "fromPersonId", "createdAt" DESC)
  `.execute(db);
  await sql`CREATE INDEX face_correction_asset_idx ON immich_fork.face_correction ("assetId")`.execute(db);
  await sql`CREATE INDEX face_correction_face_idx ON immich_fork.face_correction ("faceId")`.execute(db);

  await sql`
    ALTER TABLE immich_fork.person_merge_verdict
      ADD COLUMN "personFaceId" uuid,
      ADD COLUMN "suggestionFaceId" uuid,
      DROP CONSTRAINT person_merge_verdict_verdict_check,
      DROP CONSTRAINT person_merge_verdict_check,
      ADD CONSTRAINT person_merge_verdict_verdict_check
        CHECK (verdict = ANY (ARRAY['different'::text, 'later'::text, 'ignore'::text])),
      ADD CONSTRAINT person_merge_verdict_check CHECK (
        ("personId" < "suggestionId" AND verdict <> 'ignore') OR ("personId" = "suggestionId" AND verdict = 'ignore')
      )
  `.execute(db);

  // Decisions made before this history existed: faces moved by a person (`correctedAt`, where that
  // column exists) and faces taken off with "not a face of anyone" (a soft delete) are recorded as the
  // owner's own, so they are kept and re-applied like any later decision.
  // Only on the fork's own public schema (people in person groups); an official-origin database has
  // neither those columns nor any such decision to carry over.
  const columns = await sql<{ name: string }>`
    SELECT table_name || '.' || column_name AS name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (('asset_face', 'correctedAt'), ('asset_face', 'personGroupId'), ('person', 'personGroupId'))
  `.execute(db);
  const present = new Set(columns.rows.map(({ name }) => name));
  if (!present.has('asset_face.personGroupId') || !present.has('person.personGroupId')) {
    return;
  }
  const decidedAt = present.has('asset_face.correctedAt') ? sql`face."correctedAt"` : sql`NULL::timestamptz`;
  await sql`
    INSERT INTO immich_fork.face_correction
      ("ownerId", "actorId", action, "faceId", "assetId", "assetChecksum", "boxX1", "boxY1", "boxX2", "boxY2",
       "fromPersonId", "toPersonId", "toPersonName", "createdAt")
    SELECT asset."ownerId", asset."ownerId",
      CASE WHEN face."deletedAt" IS NOT NULL THEN 'remove' ELSE 'reassign' END,
      face.id, face."assetId", asset.checksum,
      face."boundingBoxX1"::float8 / face."imageWidth", face."boundingBoxY1"::float8 / face."imageHeight",
      face."boundingBoxX2"::float8 / face."imageWidth", face."boundingBoxY2"::float8 / face."imageHeight",
      CASE WHEN face."deletedAt" IS NOT NULL THEN face."personGroupId" END,
      CASE WHEN face."deletedAt" IS NULL THEN face."personGroupId" END,
      CASE WHEN face."deletedAt" IS NULL THEN person.name END,
      COALESCE(face."deletedAt", ${decidedAt})
    FROM public.asset_face face
    INNER JOIN public.asset asset ON asset.id = face."assetId"
    LEFT JOIN public.person person ON person."ownerId" = asset."ownerId" AND person."personGroupId" = face."personGroupId"
    WHERE (face."deletedAt" IS NOT NULL OR ${decidedAt} IS NOT NULL)
      AND face."imageWidth" > 0 AND face."imageHeight" > 0
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM immich_fork.person_merge_verdict WHERE verdict = 'ignore'`.execute(db);
  await sql`
    ALTER TABLE immich_fork.person_merge_verdict
      DROP CONSTRAINT person_merge_verdict_verdict_check,
      DROP CONSTRAINT person_merge_verdict_check,
      DROP COLUMN "personFaceId",
      DROP COLUMN "suggestionFaceId",
      ADD CONSTRAINT person_merge_verdict_verdict_check
        CHECK (verdict = ANY (ARRAY['different'::text, 'later'::text])),
      ADD CONSTRAINT person_merge_verdict_check CHECK ("personId" < "suggestionId")
  `.execute(db);
  await sql`DROP TABLE immich_fork.face_correction`.execute(db);
}
