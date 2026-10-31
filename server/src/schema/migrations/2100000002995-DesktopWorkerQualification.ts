import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql.raw("ALTER TABLE \"desktop_ml_attempt\" ADD \"qualificationId\" uuid;").execute(db);
  await sql.raw("CREATE TABLE \"desktop_worker_qualification\" (\n  \"id\" uuid NOT NULL DEFAULT uuid_generate_v4(),\n  \"deviceId\" uuid NOT NULL,\n  \"sessionId\" uuid NOT NULL,\n  \"authorizationEpoch\" integer NOT NULL,\n  \"modelKey\" character varying NOT NULL,\n  \"profileSha256\" character varying NOT NULL,\n  \"configSha256\" character varying NOT NULL,\n  \"inputKind\" character varying NOT NULL,\n  \"runtime\" jsonb NOT NULL,\n  \"runtimeFingerprint\" character varying NOT NULL,\n  \"reportSha256\" character varying NOT NULL,\n  \"createdAt\" timestamp with time zone NOT NULL DEFAULT now(),\n  \"expiresAt\" timestamp with time zone NOT NULL,\n  CONSTRAINT \"desktop_worker_qualification_deviceId_fkey\" FOREIGN KEY (\"deviceId\") REFERENCES \"desktop_device\" (\"id\") ON UPDATE CASCADE ON DELETE CASCADE,\n  CONSTRAINT \"desktop_worker_qualification_sessionId_fkey\" FOREIGN KEY (\"sessionId\") REFERENCES \"desktop_worker_session\" (\"id\") ON UPDATE CASCADE ON DELETE CASCADE,\n  CONSTRAINT \"desktop_worker_qualification_sessionId_modelKey_uq\" UNIQUE (\"sessionId\", \"modelKey\"),\n  CONSTRAINT \"desktop_worker_qualification_lifetime_check\" CHECK (\"expiresAt\" > \"createdAt\" AND \"expiresAt\" <= \"createdAt\" + interval '1 hour'),\n  CONSTRAINT \"desktop_worker_qualification_kind_check\" CHECK (\"inputKind\" IN ('image', 'text')),\n  CONSTRAINT \"desktop_worker_qualification_pkey\" PRIMARY KEY (\"id\")\n);").execute(db);
  await sql.raw("CREATE INDEX \"desktop_worker_qualification_deviceId_expiresAt_idx\" ON \"desktop_worker_qualification\" (\"deviceId\", \"expiresAt\");").execute(db);
  await sql.raw("CREATE INDEX \"desktop_worker_qualification_deviceId_idx\" ON \"desktop_worker_qualification\" (\"deviceId\");").execute(db);
  await sql.raw("CREATE INDEX \"desktop_worker_qualification_sessionId_idx\" ON \"desktop_worker_qualification\" (\"sessionId\");").execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql.raw("ALTER TABLE \"desktop_ml_attempt\" DROP COLUMN \"qualificationId\";").execute(db);
  await sql.raw("DROP TABLE \"desktop_worker_qualification\";").execute(db);
}
