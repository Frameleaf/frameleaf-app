import { Kysely, sql } from 'kysely';

/**
 * Complete workflow definitions and run details (FL-82).
 *
 * `workflow_definition` keeps every step of a workflow as its owner wrote or imported it, including
 * methods no installed plugin provides and fields this server does not use. `workflow_step` stays the
 * runnable projection; a plugin upgrade that drops a method still deletes that method's steps there,
 * and execution now compares the two and refuses the run instead of skipping the missing step.
 * `workflow_log_detail` records the attempt number and failure of each logged run.
 *
 * Both tables sit beside the shared workflow schema; nothing in `workflow`, `workflow_step` or
 * `workflow_log` changes shape. Existing workflows get a definition built from their current steps.
 * `down` drops the tables: steps that only existed in a definition are lost, the runnable ones stay.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS "workflow_definition" (
  "workflowId" uuid NOT NULL,
  "definition" jsonb NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "workflow_definition_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "workflow_definition_pkey" PRIMARY KEY ("workflowId")
);`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS "workflow_log_detail" (
  "logId" uuid NOT NULL,
  "workflowId" uuid NOT NULL,
  "attempt" integer NOT NULL DEFAULT 0,
  "errorCode" character varying,
  "error" character varying,
  CONSTRAINT "workflow_log_detail_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "workflow_log_detail_pkey" PRIMARY KEY ("logId")
);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "workflow_log_detail_workflowId_idx" ON "workflow_log_detail" ("workflowId");`.execute(
    db,
  );
  await sql`INSERT INTO "workflow_definition" ("workflowId", "definition")
SELECT "workflow"."id", jsonb_build_object(
  'version', 1,
  'trigger', "workflow"."trigger",
  'extra', '{}'::jsonb,
  'steps', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', "workflow_step"."id",
      'method', "plugin"."name" || '#' || "plugin_method"."name",
      'config', "workflow_step"."config",
      'enabled', "workflow_step"."enabled",
      'extra', '{}'::jsonb
    ) ORDER BY "workflow_step"."order")
    FROM "workflow_step"
    INNER JOIN "plugin_method" ON "plugin_method"."id" = "workflow_step"."pluginMethodId"
    INNER JOIN "plugin" ON "plugin"."id" = "plugin_method"."pluginId"
    WHERE "workflow_step"."workflowId" = "workflow"."id"
  ), '[]'::jsonb)
)
FROM "workflow"
ON CONFLICT ("workflowId") DO NOTHING;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS "workflow_log_detail";`.execute(db);
  await sql`DROP TABLE IF EXISTS "workflow_definition";`.execute(db);
}
