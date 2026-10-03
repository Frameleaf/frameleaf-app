import { Kysely, sql } from 'kysely';

/** Private local shoot workflow. UUID references deliberately have no upstream foreign keys. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE immich_fork.photography_workflow (
    id uuid PRIMARY KEY, "ownerId" uuid NOT NULL, "albumId" uuid NOT NULL,
    revision uuid NOT NULL, value jsonb NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
    "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT photography_workflow_value_check CHECK (jsonb_typeof(value) = 'object' AND octet_length(value::text) <= 20000000)
  )`.execute(db);
  await sql`CREATE TABLE immich_fork.photography_studio_site (
    "ownerId" uuid PRIMARY KEY, revision uuid NOT NULL, value jsonb NOT NULL,
    CONSTRAINT photography_site_value_check CHECK (jsonb_typeof(value) = 'object')
  )`.execute(db);
  await sql`CREATE INDEX photography_workflow_owner_idx ON immich_fork.photography_workflow ("ownerId")`.execute(db);
}
export async function down(db: Kysely<any>): Promise<void> {
  await sql`LOCK TABLE immich_fork.photography_workflow IN ACCESS EXCLUSIVE MODE`.execute(db);
  await sql`LOCK TABLE immich_fork.photography_studio_site IN ACCESS EXCLUSIVE MODE`.execute(db);
  const { rows } = await sql<{
    count: string;
  }>`SELECT ((SELECT count(*) FROM immich_fork.photography_workflow) + (SELECT count(*) FROM immich_fork.photography_studio_site))::text AS count`.execute(
    db,
  );
  if (rows[0].count !== '0') throw new Error('Photography history must be retained; nonempty rollback refused');
  await sql`DROP TABLE immich_fork.photography_studio_site`.execute(db);
  await sql`DROP TABLE immich_fork.photography_workflow`.execute(db);
}
