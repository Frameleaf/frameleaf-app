import { Kysely, sql } from 'kysely';

/**
 * FL-58: pet observations remember the original they were made on, and an owner's pet recognition
 * run is durable so it can be followed, cancelled and read again after a reload.
 *
 * - `public.pet_observation."sourceChecksum"` is the asset checksum when the owner made the decision.
 *   A write that names the checksum it was looking at is refused once the original has changed, and
 *   when an original is replaced every drawn region whose checksum no longer matches is flagged in
 *   `"staleAt"` for review. The observation itself, and the identity it confirms, stay.
 *   `pet_observation` was created by the legacy fork track (2100000000150-AddPetIdentities), so,
 *   as 0000000000170 does for `ml_workload_accounting`, the columns are added only where that table
 *   exists: a database adopted from an official install has no pets to annotate.
 * - `immich_fork.pet_recognition_run` holds one row per owner: the latest run over that owner's
 *   library, its progress and whether the owner cancelled it. Fork-owned, so it does not
 *   foreign-key into the official schema; a row left by a deleted account is inert (keyed by an
 *   owner who can no longer start or read a run), like `person_merge_verdict`.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF to_regclass('public.pet_observation') IS NOT NULL THEN
        ALTER TABLE public.pet_observation ADD COLUMN IF NOT EXISTS "sourceChecksum" bytea;
        ALTER TABLE public.pet_observation ADD COLUMN IF NOT EXISTS "staleAt" timestamp with time zone;
      END IF;
    END
    $$
  `.execute(db);

  await sql`
    CREATE TABLE immich_fork.pet_recognition_run (
      "ownerId" uuid PRIMARY KEY,
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      status text NOT NULL DEFAULT 'queued',
      "assetCount" integer NOT NULL DEFAULT 0,
      "processedCount" integer NOT NULL DEFAULT 0,
      "proposalCount" integer NOT NULL DEFAULT 0,
      "destinationKind" text,
      error text,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "finishedAt" timestamptz,
      CONSTRAINT pet_recognition_run_status_check
        CHECK (status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'cancelled'::text, 'failed'::text]))
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS immich_fork.pet_recognition_run`.execute(db);
  await sql`
    DO $$
    BEGIN
      IF to_regclass('public.pet_observation') IS NOT NULL THEN
        ALTER TABLE public.pet_observation DROP COLUMN IF EXISTS "staleAt";
        ALTER TABLE public.pet_observation DROP COLUMN IF EXISTS "sourceChecksum";
      END IF;
    END
    $$
  `.execute(db);
}
