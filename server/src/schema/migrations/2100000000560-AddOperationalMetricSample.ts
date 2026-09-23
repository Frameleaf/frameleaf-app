import { Kysely, sql } from 'kysely';

/**
 * The local operational collector's history (FL-79).
 *
 * A new table and nothing is backfilled: growth history starts at the collector's first nightly
 * run, and the analytics report shows the days before it as missing, never as zero. Rows hold a
 * series id, a scope key made of ids, a bucket and a number; dropping the table loses only the
 * history, never a photo, an account or a setting.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // NOTE: constraint and index names follow the generator's conventions so
  // `migrations:generate` produces no drift against OperationalMetricSampleTable.
  await sql`CREATE TABLE "operational_metric_sample" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "series" character varying NOT NULL,
  "scopeKey" character varying NOT NULL,
  "userId" uuid,
  "libraryId" uuid,
  "grain" character varying NOT NULL,
  "bucketStart" timestamp with time zone NOT NULL,
  "value" bigint NOT NULL,
  "observedAt" timestamp with time zone NOT NULL,
  CONSTRAINT "operational_metric_sample_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "operational_metric_sample_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "library" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "operational_metric_sample_series_scopeKey_grain_bucketStart_uq" UNIQUE ("series", "scopeKey", "grain", "bucketStart"),
  CONSTRAINT "operational_metric_sample_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "operational_metric_sample_userId_idx" ON "operational_metric_sample" ("userId");`.execute(db);
  await sql`CREATE INDEX "operational_metric_sample_libraryId_idx" ON "operational_metric_sample" ("libraryId");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "operational_metric_sample";`.execute(db);
}
