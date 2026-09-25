import { Kysely, sql } from 'kysely';

/**
 * Versioned consent for Frameleaf Cloud processing (FL-159, CLD-201).
 *
 * One row per consent an administrator gave: the destination it covers, the consent version the
 * cloud required at the time, the per-feature choices (`identityNames`, `medicalSignals`,
 * `ocrAddon`, all off unless chosen) and who accepted it. Revoking sets `revokedAt`; rows are never
 * rewritten, so the history of what was agreed survives. Fork-owned, so it lives in `immich_fork`
 * and does not foreign-key into the official schema.
 *
 * The fork configuration sidecar also moves from the previous cloud provider's section to the
 * `frameleafCloud` section (all off), so an authoritative fork keeps a complete configuration.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.frameleaf_consent (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "destinationId" uuid NOT NULL,
      version text NOT NULL,
      features jsonb NOT NULL DEFAULT '{}'::jsonb,
      "acceptedBy" uuid NOT NULL,
      "acceptedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "cloudRecordedVersion" text,
      "revokedAt" timestamptz,
      CONSTRAINT frameleaf_consent_features_check CHECK (jsonb_typeof(features) = 'object'),
      CONSTRAINT frameleaf_consent_version_check CHECK (length(version) BETWEEN 1 AND 64)
    )
  `.execute(db);
  await sql`
    CREATE INDEX frameleaf_consent_destination_accepted_idx
      ON immich_fork.frameleaf_consent ("destinationId", "acceptedAt" DESC)
  `.execute(db);
  await sql`
    DELETE FROM immich_fork.config WHERE key = 'machineLearning.runpod'
  `.execute(db);
  await sql`
    INSERT INTO immich_fork.config (key, value)
    VALUES (
      'frameleafCloud',
      '{"cloudMl":{"enabled":false,"descriptions":{"enabled":false,"defaultModel":"","autoBatch":false,"dailyBudgetUsd":0},"restoration":{"enabled":false,"defaultModel":""},"faces":{"enabled":false}}}'::jsonb
    )
    ON CONFLICT (key) DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM immich_fork.config WHERE key = 'frameleafCloud'`.execute(db);
  await sql`DROP TABLE immich_fork.frameleaf_consent`.execute(db);
}
