import { Kysely, sql } from 'kysely';

/**
 * The Frameleaf Cloud model an administrator chose per model group (FL-186).
 *
 * The chosen model used to live on the workload route (`ml_workload_route.modelId`), so it was lost
 * when a route moved and could not apply to a "Both" workload routed to this server, or tell Studio
 * AI's speech to text and speech models apart. It now has its own table keyed by the catalogue's
 * model group (`descriptions`, `upscale`, `restoration-faithful`, `restoration-creative`,
 * `interpolation`, `transcription`, `tts`). A cloud job reads its group's row whatever the route
 * points at.
 *
 * A model already chosen on a route to the Frameleaf Cloud destination is copied when the destination's
 * last catalogue check still lists it for that workload. Studio AI rows are not copied: a Studio AI
 * model cannot be told apart as a transcription or a speech model, so it is chosen again. The route
 * column stays and is no longer read. `down` drops the table.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS "ml_cloud_model_choice" (
  "modelGroup" text NOT NULL,
  "modelId" text NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ml_cloud_model_choice_pkey" PRIMARY KEY ("modelGroup")
);`.execute(db);
  await sql`INSERT INTO "ml_cloud_model_choice" ("modelGroup", "modelId")
SELECT
  CASE r."workload"
    WHEN 'enrichment' THEN 'descriptions'
    WHEN 'upscale' THEN 'upscale'
    WHEN 'restoration-faithful' THEN 'restoration-faithful'
    WHEN 'restoration-creative' THEN 'restoration-creative'
    WHEN 'interpolation' THEN 'interpolation'
  END,
  r."modelId"
FROM "ml_workload_route" r
JOIN "ml_destination" d ON d."id" = r."destinationId"
WHERE d."kind" = 'frameleaf-cloud'
  AND r."modelId" IS NOT NULL
  AND r."workload" IN ('enrichment', 'upscale', 'restoration-faithful', 'restoration-creative', 'interpolation')
  AND d."lastProbeCloud" -> 'modelIds' @> to_jsonb(r."modelId")
  AND d."lastProbeCloud" -> 'modelWorkloads' ->> r."modelId" = r."workload"
ON CONFLICT ("modelGroup") DO NOTHING;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS "ml_cloud_model_choice";`.execute(db);
}
