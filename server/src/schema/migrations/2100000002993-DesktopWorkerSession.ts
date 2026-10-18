import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql.raw("ALTER TABLE \"desktop_ml_task\" ADD \"resultSha256\" character varying;").execute(db);
  await sql.raw("ALTER TABLE \"desktop_ml_task\" DROP CONSTRAINT \"desktop_ml_task_state_check\";").execute(db);
  await sql.raw("ALTER TABLE \"desktop_ml_task\" ADD CONSTRAINT \"desktop_ml_task_state_check\" CHECK (((state)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'completed'::character varying, 'cancelled'::character varying, 'failed'::character varying, 'consumed'::character varying])::text[])));").execute(db);
  await sql.raw("ALTER TABLE \"desktop_ml_attempt\" ADD \"workerSessionId\" uuid;").execute(db);
  await sql.raw("CREATE TABLE \"desktop_worker_session\" (\n  \"id\" uuid NOT NULL DEFAULT uuid_generate_v4(),\n  \"deviceId\" uuid NOT NULL,\n  \"photoSessionId\" uuid NOT NULL,\n  \"tokenHash\" bytea NOT NULL,\n  \"authorizationEpoch\" integer NOT NULL,\n  \"lastSequence\" integer NOT NULL DEFAULT 0,\n  \"modelKeys\" jsonb NOT NULL DEFAULT '[]'::jsonb,\n  \"expiresAt\" timestamp with time zone NOT NULL,\n  \"revokedAt\" timestamp with time zone,\n  \"createdAt\" timestamp with time zone NOT NULL DEFAULT now(),\n  CONSTRAINT \"desktop_worker_session_pkey\" PRIMARY KEY (id),\n  CONSTRAINT \"desktop_worker_session_deviceid_uq\" UNIQUE (\"deviceId\"),\n  CONSTRAINT \"desktop_worker_session_deviceId_fkey\" FOREIGN KEY (\"deviceId\") REFERENCES desktop_device(id) ON UPDATE CASCADE ON DELETE CASCADE,\n  CONSTRAINT \"desktop_worker_session_photoSessionId_fkey\" FOREIGN KEY (\"photoSessionId\") REFERENCES session(id) ON UPDATE CASCADE ON DELETE CASCADE\n);").execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql.raw("ALTER TABLE \"desktop_ml_task\" DROP COLUMN \"resultSha256\";").execute(db);
  await sql.raw("ALTER TABLE \"desktop_ml_task\" DROP CONSTRAINT \"desktop_ml_task_state_check\";").execute(db);
  await sql.raw("ALTER TABLE \"desktop_ml_task\" ADD CONSTRAINT \"desktop_ml_task_state_check\" CHECK (((state)::text = ANY (ARRAY[('pending'::character varying)::text, ('running'::character varying)::text, ('completed'::character varying)::text, ('cancelled'::character varying)::text, ('failed'::character varying)::text])));").execute(db);
  await sql.raw("ALTER TABLE \"desktop_ml_attempt\" DROP COLUMN \"workerSessionId\";").execute(db);
  await sql.raw("DROP TABLE \"desktop_worker_session\";").execute(db);
}
