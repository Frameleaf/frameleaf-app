import { Kysely, sql } from 'kysely';

/** Bound claim and reservation probes as retained iCloud history grows. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`create index icloud_resource_claim_order_idx on public.icloud_resource
    ("connectionId", (case when status = 'committed' then 0 else 1 end), "createdAt", id)
    where "auditRequestId" is null and status in ('pending','retry','staging','validated','promoted','committed')`.execute(
    db,
  );
  await sql`create index icloud_resource_reservation_contributors_idx on public.icloud_resource ("connectionId")
    where status not in ('finalized','removed') and ("reservedBytes" > 0 or "leaseExpiresAt" is not null)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index public.icloud_resource_reservation_contributors_idx`.execute(db);
  await sql`drop index public.icloud_resource_claim_order_idx`.execute(db);
}
