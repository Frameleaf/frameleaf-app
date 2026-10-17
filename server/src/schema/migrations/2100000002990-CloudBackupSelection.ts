import { Kysely, sql } from 'kysely';

/**
 * FL-362: each account's Cloud Backup choice, each run's inventory (the decision a restore labels by) and
 * the numeric coverage reports for Frameleaf Cloud. New tables only: no existing row or backup changes.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.cloud_backup_selection (
      "userId" uuid NOT NULL,
      destination text NOT NULL,
      "albumIds" uuid[] NOT NULL DEFAULT '{}',
      "collectionIds" uuid[] NOT NULL DEFAULT '{}',
      "personIds" uuid[] NOT NULL DEFAULT '{}',
      "tagIds" uuid[] NOT NULL DEFAULT '{}',
      folders text[] NOT NULL DEFAULT '{}',
      favorites boolean NOT NULL DEFAULT false,
      "dateRanges" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT cloud_backup_selection_pkey PRIMARY KEY ("userId", destination),
      CONSTRAINT "cloud_backup_selection_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT cloud_backup_selection_destination_check CHECK (destination = 'cloud'),
      CONSTRAINT "cloud_backup_selection_dateRanges_check" CHECK (jsonb_typeof("dateRanges") = 'array')
    );
    CREATE TABLE public.cloud_backup_decision_run (
      "runId" uuid NOT NULL,
      "manifestKey" text NOT NULL,
      "inventoryAt" timestamp with time zone NOT NULL,
      "licenceScope" text NOT NULL,
      "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT cloud_backup_decision_run_pkey PRIMARY KEY ("runId"),
      CONSTRAINT "cloud_backup_decision_run_licenceScope_check"
        CHECK ("licenceScope" = ANY (ARRAY['all'::text, 'users'::text, 'none'::text, 'own-bucket'::text]))
    );
    CREATE INDEX "cloud_backup_decision_run_manifestKey_idx" ON public.cloud_backup_decision_run ("manifestKey");
    CREATE TABLE public.cloud_backup_decision_account (
      "runId" uuid NOT NULL,
      "userId" uuid NOT NULL,
      "userFingerprint" text NOT NULL,
      "selectionHash" text,
      "totalOriginals" integer NOT NULL,
      "selectedOriginals" integer NOT NULL,
      "licenceEligible" boolean NOT NULL,
      "includedOriginals" integer,
      CONSTRAINT cloud_backup_decision_account_pkey PRIMARY KEY ("runId", "userId"),
      CONSTRAINT "cloud_backup_decision_account_runId_fkey" FOREIGN KEY ("runId")
        REFERENCES public.cloud_backup_decision_run("runId") ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT cloud_backup_decision_account_counts_check CHECK (
        "totalOriginals" >= 0 AND "selectedOriginals" >= 0 AND "selectedOriginals" <= "totalOriginals"
        AND ("includedOriginals" IS NULL OR ("includedOriginals" >= 0 AND "includedOriginals" <= "selectedOriginals"))
        AND ("licenceEligible" OR "includedOriginals" IS NULL OR "includedOriginals" = 0)
      )
    );
    CREATE TABLE public.cloud_backup_decision_asset (
      "runId" uuid NOT NULL,
      "assetId" uuid NOT NULL,
      "ownerId" uuid NOT NULL,
      reason text NOT NULL,
      CONSTRAINT cloud_backup_decision_asset_pkey PRIMARY KEY ("runId", "assetId"),
      CONSTRAINT "cloud_backup_decision_asset_runId_fkey" FOREIGN KEY ("runId")
        REFERENCES public.cloud_backup_decision_run("runId") ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT cloud_backup_decision_asset_reason_check
        CHECK (reason = ANY (ARRAY['included'::text, 'selection'::text, 'licence'::text]))
    );
    CREATE TABLE public.cloud_backup_coverage_report (
      "runId" uuid NOT NULL,
      "instanceId" uuid,
      "revisionId" uuid NOT NULL,
      sequence integer NOT NULL,
      "inventoryAt" timestamp with time zone NOT NULL,
      "accountCount" integer NOT NULL,
      "pageCount" integer NOT NULL,
      snapshot jsonb,
      pages text[] NOT NULL,
      "runReport" jsonb,
      "revisionAccepted" boolean NOT NULL DEFAULT false,
      status text NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      "nextAttemptAt" timestamp with time zone,
      "lastError" text,
      "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
      "publishedAt" timestamp with time zone,
      CONSTRAINT cloud_backup_coverage_report_pkey PRIMARY KEY ("runId"),
      CONSTRAINT cloud_backup_coverage_report_sequence_check CHECK (sequence >= 1),
      CONSTRAINT cloud_backup_coverage_report_pages_check
        CHECK ("accountCount" >= 0 AND "pageCount" = cardinality(pages) AND "pageCount" = ("accountCount" + 31) / 32),
      CONSTRAINT cloud_backup_coverage_report_status_check
        CHECK (status = ANY (ARRAY['local'::text, 'pending'::text, 'published'::text, 'rejected'::text, 'expired'::text]))
    );
    CREATE INDEX cloud_backup_coverage_report_pending_idx ON public.cloud_backup_coverage_report ("nextAttemptAt")
      WHERE status = 'pending';
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DROP TABLE public.cloud_backup_coverage_report;
    DROP TABLE public.cloud_backup_decision_asset;
    DROP TABLE public.cloud_backup_decision_account;
    DROP TABLE public.cloud_backup_decision_run;
    DROP TABLE public.cloud_backup_selection;
  `.execute(db);
}
