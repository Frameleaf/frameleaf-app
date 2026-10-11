import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql.raw("ALTER TABLE \"studio_project_import\" ADD \"processingProvenance\" jsonb;").execute(db);
  await sql.raw("CREATE TABLE \"studio_import_publication\" (\n  \"ownerId\" uuid NOT NULL,\n  \"importId\" uuid NOT NULL,\n  \"targetPath\" text,\n  \"stagedPath\" text,\n  \"createdAt\" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),\n  \"state\" text NOT NULL,\n  \"projectId\" uuid NOT NULL,\n  \"stagedIdentity\" jsonb,\n  \"declaration\" jsonb,\n  \"expiresAt\" timestamp with time zone NOT NULL,\n  \"id\" uuid NOT NULL,\n  CONSTRAINT \"studio_import_publication_declaration_check\" CHECK (((declaration IS NULL) OR (jsonb_typeof(declaration) = 'object'::text))),\n  CONSTRAINT \"studio_import_publication_expiry_check\" CHECK ((\"expiresAt\" = (\"createdAt\" + '06:00:00'::interval))),\n  CONSTRAINT \"studio_import_publication_file_fields_check\" CHECK ((((\"stagedPath\" IS NULL) AND (\"targetPath\" IS NULL) AND (declaration IS NULL) AND (\"stagedIdentity\" IS NULL)) OR ((\"stagedPath\" IS NOT NULL) AND (\"targetPath\" IS NOT NULL) AND (declaration IS NOT NULL) AND (\"stagedIdentity\" IS NOT NULL)))),\n  CONSTRAINT \"studio_import_publication_identity_check\" CHECK (((\"stagedIdentity\" IS NULL) OR (jsonb_typeof(\"stagedIdentity\") = 'object'::text))),\n  CONSTRAINT \"studio_import_publication_pkey\" PRIMARY KEY (id),\n  CONSTRAINT \"studio_import_publication_preparing_check\" CHECK (((state <> 'preparing'::text) OR (\"stagedPath\" IS NOT NULL))),\n  CONSTRAINT \"studio_import_publication_registered_check\" CHECK (((state <> 'registered'::text) OR (\"stagedPath\" IS NULL))),\n  CONSTRAINT \"studio_import_publication_state_check\" CHECK ((state = ANY (ARRAY['registered'::text, 'preparing'::text, 'published'::text, 'aborted'::text])))\n);").execute(db);
  await sql.raw("CREATE UNIQUE INDEX studio_import_publication_active_import ON public.studio_import_publication USING btree (\"projectId\", \"importId\") WHERE ((\"stagedPath\" IS NOT NULL) OR (\"targetPath\" IS NOT NULL));").execute(db);
  await sql.raw("CREATE INDEX studio_import_publication_discovery ON public.studio_import_publication USING btree (\"ownerId\", \"projectId\", \"createdAt\", id);").execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql.raw("ALTER TABLE \"studio_project_import\" DROP COLUMN \"processingProvenance\";").execute(db);
  await sql.raw("DROP TABLE \"studio_import_publication\";").execute(db);
}
