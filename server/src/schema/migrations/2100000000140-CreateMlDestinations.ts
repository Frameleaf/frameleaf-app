import { Kysely, sql } from 'kysely';

/**
 * Machine-learning destinations, workload routes and accounting (FL-110).
 *
 * `ml_destination` holds every place work may run: the local container, a LAN worker or
 * the managed RunPod endpoint, with the admin's consent state and cost controls.
 * `ml_workload_route` names the destination each library workload uses; a workload
 * without a route is refused. `ml_workload_accounting` records job id, destination, bytes
 * and duration per request so FL-115 can show measured estimates and billing limits.
 *
 * Nothing is seeded here. The destination service creates a local destination for the
 * configured ML URLs on bootstrap and routes the library workloads to it; RunPod rows are
 * only ever created by an administrator, and consent is a separate explicit action.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "ml_destination" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "kind" text NOT NULL,
    "name" text NOT NULL,
    "url" text,
    "authToken" text,
    "enabled" boolean NOT NULL DEFAULT true,
    "workloads" jsonb NOT NULL DEFAULT '[]',
    "consentAcknowledgedAt" timestamp with time zone,
    "consentAcknowledgedBy" uuid,
    "budgetLimitUsd" double precision,
    "maxRuntimeMinutes" integer,
    "maxUploadBytes" bigint,
    "lastProbeAt" timestamp with time zone,
    "lastProbeHealth" text NOT NULL DEFAULT 'unknown',
    "lastProbeSummary" text,
    "lastProbeWorkloads" jsonb,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "ml_destination_consentAcknowledgedBy_fkey" FOREIGN KEY ("consentAcknowledgedBy") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "ml_destination_kind_check" CHECK (kind = ANY (ARRAY['local'::text, 'lan'::text, 'runpod'::text])),
    CONSTRAINT "ml_destination_pkey" PRIMARY KEY ("id")
  );`.execute(db);

  await sql`CREATE INDEX "ml_destination_consentAcknowledgedBy_idx" ON "ml_destination" ("consentAcknowledgedBy");`.execute(
    db,
  );

  await sql`CREATE TABLE "ml_workload_route" (
    "workload" text NOT NULL,
    "destinationId" uuid NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "ml_workload_route_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "ml_destination" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "ml_workload_route_pkey" PRIMARY KEY ("workload")
  );`.execute(db);

  await sql`CREATE INDEX "ml_workload_route_destinationId_idx" ON "ml_workload_route" ("destinationId");`.execute(db);

  await sql`CREATE TABLE "ml_workload_accounting" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "destinationId" uuid,
    "destinationKind" text NOT NULL,
    "workload" text NOT NULL,
    "jobId" text,
    "jobName" text,
    "bytesSent" bigint NOT NULL DEFAULT 0,
    "bytesReceived" bigint NOT NULL DEFAULT 0,
    "durationMs" integer NOT NULL DEFAULT 0,
    "outcome" text NOT NULL,
    "costUsd" double precision,
    "startedAt" timestamp with time zone NOT NULL,
    "finishedAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "ml_workload_accounting_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "ml_destination" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "ml_workload_accounting_pkey" PRIMARY KEY ("id")
  );`.execute(db);

  await sql`CREATE INDEX "ml_workload_accounting_destinationId_startedAt_idx" ON "ml_workload_accounting" ("destinationId", "startedAt");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "ml_workload_accounting_destinationId_startedAt_idx";`.execute(db);
  await sql`DROP TABLE "ml_workload_accounting";`.execute(db);
  await sql`DROP INDEX "ml_workload_route_destinationId_idx";`.execute(db);
  await sql`DROP TABLE "ml_workload_route";`.execute(db);
  await sql`DROP INDEX "ml_destination_consentAcknowledgedBy_idx";`.execute(db);
  await sql`DROP TABLE "ml_destination";`.execute(db);
}
