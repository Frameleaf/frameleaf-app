import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql.raw("ALTER TABLE \"source_resource_read\" ADD \"consumerManaged\" boolean NOT NULL DEFAULT false;").execute(db);
  await sql.raw("CREATE TABLE \"source_resource_read_consumer\" (\n  \"id\" uuid NOT NULL DEFAULT uuidv7(),\n  \"readId\" uuid NOT NULL,\n  \"readerId\" uuid NOT NULL,\n  \"readerOwnerId\" uuid NOT NULL,\n  \"expiresAt\" timestamp with time zone,\n  CONSTRAINT \"source_resource_read_consumer_pkey\" PRIMARY KEY (id),\n  CONSTRAINT \"source_resource_read_consumer_readId_readerId_uq\" UNIQUE (\"readId\", \"readerId\"),\n  CONSTRAINT \"source_resource_read_consumer_readId_fkey\" FOREIGN KEY (\"readId\") REFERENCES source_resource_read(id) ON UPDATE CASCADE ON DELETE CASCADE\n);").execute(db);
  await sql.raw("CREATE INDEX \"source_resource_read_consumer_readId_idx\" ON public.source_resource_read_consumer USING btree (\"readId\");").execute(db);
  await sql.raw("CREATE TABLE \"source_resource_cache\" (\n  \"id\" uuid NOT NULL DEFAULT uuidv7(),\n  \"readId\" uuid NOT NULL,\n  \"claimFence\" integer NOT NULL,\n  \"assetId\" uuid NOT NULL,\n  \"resourceId\" uuid NOT NULL,\n  \"sourceId\" uuid NOT NULL,\n  \"ownerId\" uuid NOT NULL,\n  \"deviceId\" uuid NOT NULL,\n  \"scopeFingerprint\" character varying NOT NULL,\n  \"authorizationEpoch\" integer NOT NULL,\n  \"resourceKey\" character varying NOT NULL,\n  \"version\" character varying NOT NULL,\n  \"sha256\" bytea NOT NULL,\n  \"bytes\" bigint NOT NULL,\n  \"state\" character varying NOT NULL DEFAULT 'writing'::character varying,\n  \"writerId\" uuid NOT NULL,\n  \"writerOwnerId\" uuid NOT NULL,\n  \"writerStoppedAt\" timestamp with time zone,\n  \"fileName\" character varying,\n  \"createdAt\" timestamp with time zone NOT NULL DEFAULT now(),\n  \"restoreHeld\" boolean NOT NULL DEFAULT false,\n  CONSTRAINT \"source_resource_cache_state_check\" CHECK (((state)::text = ANY ((ARRAY['writing'::character varying, 'ready'::character varying, 'deleting'::character varying])::text[]))),\n  CONSTRAINT \"source_resource_cache_size_check\" CHECK (((bytes > 0) AND (bytes <= '9007199254740991'::bigint) AND (\"claimFence\" > 0) AND (\"authorizationEpoch\" > 0))),\n  CONSTRAINT \"source_resource_cache_digest_check\" CHECK (((octet_length(sha256) = 32) AND ((version)::text ~ '^[a-f0-9]{64}$'::text) AND ((\"resourceKey\")::text ~ '^[a-f0-9]{64}$'::text) AND ((\"scopeFingerprint\")::text ~ '^[a-f0-9]{64}$'::text))),\n  CONSTRAINT \"source_resource_cache_file_check\" CHECK ((((\"fileName\" IS NULL) OR ((\"fileName\")::text ~ '^[a-f0-9-]{36}[.]artifact$'::text)) AND (((state)::text <> 'ready'::text) OR ((\"fileName\" IS NOT NULL) AND (\"writerStoppedAt\" IS NOT NULL))))),\n  CONSTRAINT \"source_resource_cache_pkey\" PRIMARY KEY (id),\n  CONSTRAINT \"source_resource_cache_readId_claimFence_uq\" UNIQUE (\"readId\", \"claimFence\")\n);").execute(db);
  await sql.raw("CREATE TABLE \"source_resource_cache_lease\" (\n  \"id\" uuid NOT NULL DEFAULT uuidv7(),\n  \"cacheId\" uuid NOT NULL,\n  \"readerId\" uuid NOT NULL,\n  \"readerOwnerId\" uuid NOT NULL,\n  \"kind\" character varying NOT NULL,\n  \"jobId\" uuid,\n  \"attemptToken\" uuid,\n  \"createdAt\" timestamp with time zone NOT NULL DEFAULT now(),\n  \"readerStoppedAt\" timestamp with time zone,\n  CONSTRAINT \"source_resource_cache_lease_kind_check\" CHECK (((((kind)::text = 'http'::text) AND (\"jobId\" IS NULL) AND (\"attemptToken\" IS NULL)) OR (((kind)::text = 'job'::text) AND (\"jobId\" IS NOT NULL) AND (\"attemptToken\" IS NOT NULL)))),\n  CONSTRAINT \"source_resource_cache_lease_pkey\" PRIMARY KEY (id),\n  CONSTRAINT \"source_resource_cache_lease_cacheId_readerId_uq\" UNIQUE (\"cacheId\", \"readerId\"),\n  CONSTRAINT \"source_resource_cache_lease_cacheId_fkey\" FOREIGN KEY (\"cacheId\") REFERENCES source_resource_cache(id) ON UPDATE CASCADE ON DELETE CASCADE\n);").execute(db);
  await sql.raw("CREATE INDEX \"source_resource_cache_lease_cacheId_idx\" ON public.source_resource_cache_lease USING btree (\"cacheId\");").execute(db);
  await sql.raw("CREATE INDEX \"source_resource_cache_state_createdAt_idx\" ON public.source_resource_cache USING btree (state, \"createdAt\");").execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Retained ownership must survive rollback just as it survives media deletion.
  await sql`LOCK TABLE source_resource_read, source_resource_cache, source_resource_cache_lease,
    source_resource_read_consumer IN ACCESS EXCLUSIVE MODE`.execute(db);
  const { rows } = await sql<{ retained: boolean }>`SELECT
    EXISTS (SELECT 1 FROM source_resource_cache) OR
    EXISTS (SELECT 1 FROM source_resource_cache_lease) OR
    EXISTS (SELECT 1 FROM source_resource_read_consumer) OR
    EXISTS (SELECT 1 FROM source_resource_read WHERE "consumerManaged") OR
    EXISTS (SELECT 1 FROM system_metadata WHERE key LIKE 'frameleaf-source-reader-stopped:%') AS retained`.execute(db);
  if (rows[0].retained) throw new Error('Cannot discard retained source cache ownership');
  await sql.raw("ALTER TABLE \"source_resource_read\" DROP COLUMN \"consumerManaged\";").execute(db);
  await sql.raw("DROP TABLE \"source_resource_read_consumer\";").execute(db);
  await sql.raw("DROP TABLE \"source_resource_cache_lease\";").execute(db);
  await sql.raw("DROP TABLE \"source_resource_cache\";").execute(db);
}
