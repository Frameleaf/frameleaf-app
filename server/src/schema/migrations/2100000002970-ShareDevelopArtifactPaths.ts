import { Kysely, sql } from 'kysely';

/** Immutable masks and fills can have one owning reference per partner copy. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`drop index public.asset_develop_artifact_path_key;
    create index asset_develop_artifact_path_idx on public.asset_develop_artifact (path)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse rollback while shared references exist; never discard a recipient's artifacts.
  await sql`create unique index asset_develop_artifact_path_key on public.asset_develop_artifact (path);
    drop index public.asset_develop_artifact_path_idx`.execute(db);
}
