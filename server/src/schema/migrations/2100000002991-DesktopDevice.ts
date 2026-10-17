import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql.raw("CREATE TABLE \"desktop_device\" (\n  \"userId\" uuid NOT NULL,\n  \"installationId\" uuid NOT NULL,\n  \"publicKey\" character varying NOT NULL,\n  \"authorizationEpoch\" integer NOT NULL DEFAULT 1,\n  \"architecture\" character varying NOT NULL,\n  \"mode\" character varying NOT NULL,\n  \"name\" character varying NOT NULL,\n  \"revokedAt\" timestamp with time zone,\n  \"createdAt\" timestamp with time zone NOT NULL DEFAULT now(),\n  \"state\" character varying NOT NULL,\n  \"id\" uuid NOT NULL DEFAULT uuid_generate_v4(),\n  \"platform\" character varying NOT NULL,\n  CONSTRAINT \"desktop_device_pkey\" PRIMARY KEY (id),\n  CONSTRAINT \"desktop_device_userid_installationid_uq\" UNIQUE (\"userId\", \"installationId\"),\n  CONSTRAINT \"desktop_device_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"user\"(id) ON UPDATE CASCADE ON DELETE CASCADE\n);").execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql.raw("DROP TABLE \"desktop_device\";").execute(db);
}
