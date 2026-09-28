import { Kysely, sql } from 'kysely';

/**
 * Separate library-analysis and restoration workers (FL-72).
 *
 * - `ml_destination.kind` accepts `runpod-video`: a persistent restoration worker on RunPod,
 *   reached by its own URL and credential rather than the library-analysis pod's endpoint.
 * - `lastProbeHardware` and `lastProbeLatencyMs` keep what the last health check learned about
 *   the worker's acceleration, so the worker inventory can tell a CPU-only worker from one with
 *   an accelerator without contacting it again.
 * - `sharesLibraryHardware` marks a restoration worker that runs on the same GPU as library
 *   analysis; full restorations bound to it wait while library analysis has work.
 *
 * Nothing existing is rewritten: current rows keep their kind and workloads, the new columns
 * start empty (or false), and the widened CHECK accepts every value the old one did.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "ml_destination" DROP CONSTRAINT "ml_destination_kind_check";`.execute(db);
  await sql`ALTER TABLE "ml_destination" ADD CONSTRAINT "ml_destination_kind_check" CHECK (kind = ANY (ARRAY['local'::text, 'lan'::text, 'runpod'::text, 'runpod-video'::text]));`.execute(
    db,
  );
  await sql`ALTER TABLE "ml_destination" ADD "lastProbeHardware" jsonb;`.execute(db);
  await sql`ALTER TABLE "ml_destination" ADD "lastProbeLatencyMs" integer;`.execute(db);
  await sql`ALTER TABLE "ml_destination" ADD "sharesLibraryHardware" boolean NOT NULL DEFAULT false;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "ml_destination" DROP COLUMN "sharesLibraryHardware";`.execute(db);
  await sql`ALTER TABLE "ml_destination" DROP COLUMN "lastProbeLatencyMs";`.execute(db);
  await sql`ALTER TABLE "ml_destination" DROP COLUMN "lastProbeHardware";`.execute(db);
  // A runpod-video row cannot survive the narrower CHECK. Its routes cascade with it, so those
  // restoration workloads become unrouted and are refused rather than sent somewhere else.
  await sql`DELETE FROM "ml_destination" WHERE "kind" = 'runpod-video';`.execute(db);
  await sql`ALTER TABLE "ml_destination" DROP CONSTRAINT "ml_destination_kind_check";`.execute(db);
  await sql`ALTER TABLE "ml_destination" ADD CONSTRAINT "ml_destination_kind_check" CHECK (kind = ANY (ARRAY['local'::text, 'lan'::text, 'runpod'::text]));`.execute(
    db,
  );
}
