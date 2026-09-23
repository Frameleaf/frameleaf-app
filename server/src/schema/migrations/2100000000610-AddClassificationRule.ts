import { Kysely, sql } from 'kysely';

/**
 * Classification rules (FL-60): the rules behind a person's own smart albums and what each rule did.
 *
 * `classification_rule` is one rule, always backing one album the person owns (the smart album that
 * shows its results). It holds the criteria (people, tags, a date range, the media type and optional
 * visual category phrases with a confidence threshold), whether matches are suggested for review or
 * applied with a rule-owned tag, and whether matches are archived — which is only ever set together
 * with the moment the person consented to it (`archiveConsentAt`).
 *
 * `classification_match` is one asset a rule matched and what became of it: applied automatically,
 * waiting for review, or a manual decision (accepted or rejected) that reprocessing never overturns.
 * `tagContributed` and `archiveContributed` record that this rule, and not the person or another rule,
 * added the tag or archived the asset, so undoing a match only ever removes what the rule itself added.
 *
 * Additive only: nothing existing is read or rewritten. `down` drops both tables; albums, tags and
 * archive states already applied stay as they are.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS "classification_rule" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "albumId" uuid NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "personIds" jsonb NOT NULL DEFAULT '[]',
  "tagIds" jsonb NOT NULL DEFAULT '[]',
  "takenAfter" character varying,
  "takenBefore" character varying,
  "mediaType" character varying NOT NULL DEFAULT 'any',
  "visualQueries" jsonb NOT NULL DEFAULT '[]',
  "threshold" double precision NOT NULL DEFAULT 0.25,
  "action" character varying NOT NULL DEFAULT 'review',
  "tagId" uuid,
  "archive" boolean NOT NULL DEFAULT false,
  "archiveConsentAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "lastAppliedAt" timestamp with time zone,
  CONSTRAINT "classification_rule_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "classification_rule_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "classification_rule_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tag" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "classification_rule_albumId_uq" UNIQUE ("albumId"),
  CONSTRAINT "classification_rule_archive_consent_chk" CHECK (NOT "archive" OR "archiveConsentAt" IS NOT NULL),
  CONSTRAINT "classification_rule_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "classification_rule_ownerId_idx" ON "classification_rule" ("ownerId");`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS "classification_rule_albumId_idx" ON "classification_rule" ("albumId");`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS "classification_rule_tagId_idx" ON "classification_rule" ("tagId");`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS "classification_match" (
  "ruleId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "score" double precision,
  "decision" character varying NOT NULL,
  "tagContributed" boolean NOT NULL DEFAULT false,
  "archiveContributed" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "classification_match_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "classification_rule" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "classification_match_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "classification_match_pkey" PRIMARY KEY ("ruleId", "assetId")
);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "classification_match_ruleId_idx" ON "classification_match" ("ruleId");`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS "classification_match_assetId_idx" ON "classification_match" ("assetId");`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS "classification_match_ruleId_decision_idx" ON "classification_match" ("ruleId", "decision");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS "classification_match";`.execute(db);
  await sql`DROP TABLE IF EXISTS "classification_rule";`.execute(db);
}
