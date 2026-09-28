import { Kysely, sql } from 'kysely';

/**
 * Frameleaf Cloud replaces the previous cloud processing provider (FL-159, CLD-201; owner decision
 * FL-146, 2026-09-25).
 *
 * - Destinations of the two previous cloud kinds are removed. Their routes cascade with them, so
 *   the workloads they served become unrouted and are refused until an administrator routes them
 *   again: nothing is ever moved to another destination.
 * - Unfinished jobs bound to the previous cloud destination fail in place with `destination_removed`
 *   (their claims are dropped); they are never re-pointed. Render workers enrolled for it are
 *   revoked. Finished jobs, those workers and accounting rows keep their history, relabelled as
 *   cloud work, because the previous kind no longer exists.
 * - What was removed is written to `frameleaf-cloud-migration-notice`, so the server tells every
 *   administrator once, in plain language, at the next start.
 * - The kind CHECK narrows to `local`, `lan` and `frameleaf-cloud` (same shape as
 *   2100000000490-SeparateRestorationWorkers).
 * - New columns: `ml_destination.region`, `consentVersion` and `lastProbeCloud`,
 *   `ml_workload_route.modelId`, and `ml_workload_accounting.credits` and `cloudJobId`.
 * - The previous provider's state and orphan records in `system_metadata` are deleted, and its
 *   settings section is removed from the saved configuration (including its stored credentials).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    INSERT INTO "system_metadata" ("key", "value")
    SELECT
      'frameleaf-cloud-migration-notice',
      jsonb_build_object(
        'removedDestinations',
        COALESCE(
          (SELECT jsonb_agg(jsonb_build_object('name', "name", 'workloads', "workloads") ORDER BY "createdAt")
             FROM "ml_destination" WHERE "kind" IN ('runpod', 'runpod-video')),
          '[]'::jsonb
        ),
        'cancelledOperations',
        (SELECT count(*) FROM "media_operation"
          WHERE "destination" = 'runpod'
            AND "status" IN ('queued', 'preparing', 'rendering', 'validating', 'cancelling', 'paused')),
        'revokedRenderWorkers',
        (SELECT count(*) FROM "render_worker" WHERE "destination" = 'runpod' AND "status" <> 'revoked'),
        'createdAt',
        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    WHERE EXISTS (SELECT 1 FROM "ml_destination" WHERE "kind" IN ('runpod', 'runpod-video'))
       OR EXISTS (SELECT 1 FROM "render_worker" WHERE "destination" = 'runpod' AND "status" <> 'revoked')
       OR EXISTS (
         SELECT 1 FROM "media_operation"
          WHERE "destination" = 'runpod'
            AND "status" IN ('queued', 'preparing', 'rendering', 'validating', 'cancelling', 'paused')
       )
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value";
  `.execute(db);

  await sql`
    UPDATE "media_operation"
       SET "status" = 'failed',
           "errorCode" = 'destination_removed',
           "error" = 'The cloud processing destination this job was bound to was removed when Frameleaf Cloud replaced it',
           "claimToken" = NULL,
           "claimedBy" = NULL,
           "claimExpiresAt" = NULL,
           "finishedAt" = now()
     WHERE "destination" = 'runpod'
       AND "status" IN ('queued', 'preparing', 'rendering', 'validating', 'cancelling', 'paused');
  `.execute(db);

  // Finished jobs, render workers and accounting rows keep their history, relabelled as cloud work:
  // the previous destination kind no longer exists, and a revoked worker never claims again.
  await sql`UPDATE "media_operation" SET "destination" = 'frameleaf-cloud', "destinationDetail" = NULL WHERE "destination" = 'runpod';`.execute(
    db,
  );
  await sql`
    UPDATE "render_worker_session" SET "revokedAt" = now()
     WHERE "revokedAt" IS NULL
       AND "workerId" IN (SELECT "id" FROM "render_worker" WHERE "destination" = 'runpod');
  `.execute(db);
  await sql`UPDATE "render_worker" SET "status" = 'revoked', "destination" = 'frameleaf-cloud' WHERE "destination" = 'runpod';`.execute(
    db,
  );
  await sql`UPDATE "ml_workload_accounting" SET "destinationKind" = 'frameleaf-cloud' WHERE "destinationKind" IN ('runpod', 'runpod-video');`.execute(
    db,
  );
  await sql`DELETE FROM "ml_destination" WHERE "kind" IN ('runpod', 'runpod-video');`.execute(db);
  await sql`DELETE FROM "system_metadata" WHERE "key" IN ('runpod-state', 'runpod-orphans');`.execute(db);
  await sql`
    UPDATE "system_metadata"
       SET "value" = jsonb_set("value", '{machineLearning}', ("value"->'machineLearning') - 'runpod')
     WHERE "key" = 'system-config'
       AND jsonb_typeof("value"->'machineLearning') = 'object'
       AND ("value"->'machineLearning') ? 'runpod';
  `.execute(db);

  await sql`ALTER TABLE "ml_destination" DROP CONSTRAINT "ml_destination_kind_check";`.execute(db);
  await sql`ALTER TABLE "ml_destination" ADD CONSTRAINT "ml_destination_kind_check" CHECK (kind = ANY (ARRAY['local'::text, 'lan'::text, 'frameleaf-cloud'::text]));`.execute(
    db,
  );
  await sql`ALTER TABLE "ml_destination" ADD "region" text;`.execute(db);
  await sql`ALTER TABLE "ml_destination" ADD "consentVersion" text;`.execute(db);
  await sql`ALTER TABLE "ml_destination" ADD "lastProbeCloud" jsonb;`.execute(db);
  await sql`ALTER TABLE "ml_workload_route" ADD "modelId" text;`.execute(db);
  await sql`ALTER TABLE "ml_workload_accounting" ADD "credits" double precision;`.execute(db);
  await sql`ALTER TABLE "ml_workload_accounting" ADD "cloudJobId" text;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "ml_workload_accounting" DROP COLUMN "cloudJobId";`.execute(db);
  await sql`ALTER TABLE "ml_workload_accounting" DROP COLUMN "credits";`.execute(db);
  await sql`ALTER TABLE "ml_workload_route" DROP COLUMN "modelId";`.execute(db);
  await sql`ALTER TABLE "ml_destination" DROP COLUMN "lastProbeCloud";`.execute(db);
  await sql`ALTER TABLE "ml_destination" DROP COLUMN "consentVersion";`.execute(db);
  await sql`ALTER TABLE "ml_destination" DROP COLUMN "region";`.execute(db);
  // A Frameleaf Cloud row cannot survive the older CHECK. Its routes cascade with it, so its
  // workloads become unrouted and are refused rather than sent somewhere else. The previous
  // provider's rows removed by `up` are not recreated.
  await sql`DELETE FROM "ml_destination" WHERE "kind" = 'frameleaf-cloud';`.execute(db);
  await sql`ALTER TABLE "ml_destination" DROP CONSTRAINT "ml_destination_kind_check";`.execute(db);
  await sql`ALTER TABLE "ml_destination" ADD CONSTRAINT "ml_destination_kind_check" CHECK (kind = ANY (ARRAY['local'::text, 'lan'::text, 'runpod'::text, 'runpod-video'::text]));`.execute(
    db,
  );
}
