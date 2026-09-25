import { Kysely, sql } from 'kysely';

/**
 * Personal Frameleaf supporter keys (FL-156, CLD-003): one row per account that activated an
 * individual key (`FL-I…`) on this server.
 *
 * - `binding` is `sha256(instanceId + userId)`, the fingerprint Frameleaf Cloud activated the key
 *   for, so a key moved to another account or server is a new activation.
 * - `keySha256` is unique: one active activation of a key on this server. The key itself is never
 *   stored; only its last four symbols (`keyHint`) are shown again.
 * - `certificate` is the signed licence certificate the cloud returned, verified before it is kept.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema; the
 * account service removes a person's row when the account is removed.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.frameleaf_user_license (
      "userId" uuid NOT NULL,
      kind text NOT NULL DEFAULT 'individual',
      "keyHint" text NOT NULL,
      "keySha256" text NOT NULL,
      binding text NOT NULL,
      certificate text NOT NULL,
      "activationId" text,
      "activatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT frameleaf_user_license_pkey PRIMARY KEY ("userId"),
      CONSTRAINT frameleaf_user_license_key_unique UNIQUE ("keySha256"),
      CONSTRAINT frameleaf_user_license_kind_check CHECK (kind = 'individual'),
      CONSTRAINT frameleaf_user_license_key_hint_check CHECK (length("keyHint") = 4)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.frameleaf_user_license`.execute(db);
}
