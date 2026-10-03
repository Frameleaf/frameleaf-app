import { Kysely, sql } from 'kysely';

/**
 * Universal people for partner sharing (FL-326, spec §4.5). When a partner's copy brings faces of the
 * partner's person P into a library, that library maps P to one of its own people:
 *
 * - `merged`: an existing person of the recipient whose faces match P above the recognition threshold.
 *   The auto-merge is one `partner-merge` entry in the recipient's face correction history
 *   (`correctionId`); undoing it moves the copied faces to a new person of their own.
 * - `created`: a new person made for P, which also has a `person_origin` row (migration 0000000000220)
 *   and follows P's name and details until the recipient changes them.
 *
 * `partner_person_link` keeps that mapping per recipient (`ownerId`) and source person group, so every
 * later copy of P's faces lands on the same person. A merged person never gets an origin row: it is the
 * recipient's own and never follows the partner's edits.
 *
 * The face correction checks gain `partner-merge`, a person-level entry (no face or photo anchor), as
 * `merge` already is.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.partner_person_link (
      "ownerId" uuid NOT NULL,
      "sourcePersonGroupId" uuid NOT NULL,
      "personGroupId" uuid NOT NULL,
      kind text NOT NULL,
      "partnerSharedById" uuid NOT NULL,
      "correctionId" uuid,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT partner_person_link_pkey PRIMARY KEY ("ownerId", "sourcePersonGroupId"),
      CONSTRAINT partner_person_link_kind_check CHECK (kind = ANY (ARRAY['created'::text, 'merged'::text]))
    )
  `.execute(db);
  await sql`
    CREATE INDEX partner_person_link_person_idx ON immich_fork.partner_person_link ("ownerId", "personGroupId")
  `.execute(db);

  await sql`
    ALTER TABLE immich_fork.face_correction
      DROP CONSTRAINT face_correction_action_check,
      DROP CONSTRAINT face_correction_anchor_check,
      ADD CONSTRAINT face_correction_action_check CHECK (
        action = ANY (ARRAY['reassign'::text, 'new-person'::text, 'unassign'::text, 'remove'::text, 'merge'::text, 'box-move'::text, 'partner-merge'::text])
      ),
      ADD CONSTRAINT face_correction_anchor_check CHECK (
        action = ANY (ARRAY['merge'::text, 'partner-merge'::text]) OR "assetId" IS NOT NULL
      )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM immich_fork.face_correction WHERE action = 'partner-merge'`.execute(db);
  await sql`
    ALTER TABLE immich_fork.face_correction
      DROP CONSTRAINT face_correction_action_check,
      DROP CONSTRAINT face_correction_anchor_check,
      ADD CONSTRAINT face_correction_action_check CHECK (
        action = ANY (ARRAY['reassign'::text, 'new-person'::text, 'unassign'::text, 'remove'::text, 'merge'::text, 'box-move'::text])
      ),
      ADD CONSTRAINT face_correction_anchor_check CHECK (
        action = 'merge' OR "assetId" IS NOT NULL
      )
  `.execute(db);
  await sql`DROP TABLE immich_fork.partner_person_link`.execute(db);
}
