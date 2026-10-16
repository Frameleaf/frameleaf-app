import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql.raw("CREATE TABLE \"ml_workload_route_origin\" (\n  \"workload\" text NOT NULL,\n  \"origin\" text NOT NULL,\n  \"revisionId\" uuid NOT NULL,\n  \"destinationId\" uuid,\n  \"updatedAt\" timestamp with time zone NOT NULL DEFAULT now(),\n  CONSTRAINT \"ml_workload_route_origin_destinationId_fkey\" FOREIGN KEY (\"destinationId\") REFERENCES \"ml_destination\" (\"id\") ON UPDATE CASCADE ON DELETE SET NULL,\n  CONSTRAINT \"ml_workload_route_origin_kind_check\" CHECK (origin IN ('default', 'pinned')),\n  CONSTRAINT \"ml_workload_route_origin_pkey\" PRIMARY KEY (\"workload\")\n);").execute(db);
  await sql.raw("CREATE INDEX \"ml_workload_route_origin_destinationId_idx\" ON \"ml_workload_route_origin\" (\"destinationId\");").execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`LOCK TABLE ml_workload_route_origin IN ACCESS EXCLUSIVE MODE`.execute(db);
  const { rows } = await sql<{ recorded: boolean }>`
    SELECT EXISTS (SELECT 1 FROM ml_workload_route_origin) AS recorded
  `.execute(db);
  if (rows[0].recorded) throw new Error('Cannot discard recorded route intent during schema downgrade');
  await sql.raw("DROP TABLE \"ml_workload_route_origin\";").execute(db);
}
