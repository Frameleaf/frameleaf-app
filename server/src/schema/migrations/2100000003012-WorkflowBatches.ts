import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE workflow_batch (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "workflowId" uuid NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
    "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','cancelled','failed')),
    reason text NOT NULL CHECK(reason IN ('manual','schedule')), definition jsonb NOT NULL, source jsonb NOT NULL,
    embedding text, "embeddingKey" text, "definitionSha256" text NOT NULL, "snapshotAt" timestamptz NOT NULL DEFAULT now(),
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), "finishedAt" timestamptz,
    total integer NOT NULL DEFAULT 0, completed integer NOT NULL DEFAULT 0, skipped integer NOT NULL DEFAULT 0,
    failed integer NOT NULL DEFAULT 0, error text
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX workflow_batch_active ON workflow_batch("workflowId") WHERE status IN ('pending','running')`.execute(
    db,
  );
  await sql`CREATE TABLE workflow_batch_item (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "batchId" uuid NOT NULL REFERENCES workflow_batch(id) ON DELETE CASCADE,
    "assetId" uuid NOT NULL, attempt integer NOT NULL DEFAULT 0, "fromStepId" uuid,
    status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','skipped','failed')),
    UNIQUE("batchId","assetId")
  )`.execute(db);
  await sql`CREATE INDEX workflow_batch_item_pending ON workflow_batch_item("batchId",id) WHERE status='pending'`.execute(
    db,
  );
  await sql`CREATE TABLE workflow_causation (
    "chainId" uuid NOT NULL,"workflowId" uuid NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
    "assetId" uuid NOT NULL,"runId" uuid NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY("chainId","workflowId","assetId")
  )`.execute(db);
  await sql`CREATE TABLE workflow_schedule (
    "workflowId" uuid PRIMARY KEY REFERENCES workflow(id) ON DELETE CASCADE,
    "definitionSha256" text NOT NULL, "nextAt" timestamptz NOT NULL, "lastAt" timestamptz
  )`.execute(db);
}
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE workflow_causation, workflow_schedule, workflow_batch_item, workflow_batch`.execute(db);
}
