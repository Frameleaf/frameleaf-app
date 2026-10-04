import { Kysely, sql } from 'kysely';

/**
 * FL-296: hosted plans showed a full scan/sort for each claim and two full reservation scans.
 * These indexes preserve admission and ordering; reservation predicates retain every charged row
 * and every lease. The corresponding hand-authored catalog entries are source expectations until
 * hosted PostgreSQL snapshot output confirms their exact definitions.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE INDEX icloud_resource_claim_order_idx ON immich_fork.icloud_resource
    ("connectionId", (CASE WHEN status='committed' THEN 0 ELSE 1 END), "createdAt", id)
    WHERE "auditRequestId" IS NULL AND status IN ('pending','retry','staging','validated','promoted','committed')`.execute(
    db,
  );
  await sql`CREATE INDEX icloud_resource_reservation_contributors_idx ON immich_fork.icloud_resource ("connectionId")
    WHERE status NOT IN ('finalized','removed') AND ("reservedBytes">0 OR "leaseExpiresAt" IS NOT NULL)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX immich_fork.icloud_resource_reservation_contributors_idx`.execute(db);
  await sql`DROP INDEX immich_fork.icloud_resource_claim_order_idx`.execute(db);
}
