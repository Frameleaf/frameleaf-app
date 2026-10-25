import { Kysely, type Transaction, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';

/** Workers are stopped; revoke snapshot authority without claiming filesystem owners stopped. */
export const resetSourceResourcesAfterRestore = async (db: Kysely<DB> | Transaction<DB>): Promise<void> => {
  await sql`UPDATE source_resource_grant SET "revokedAt" = clock_timestamp() WHERE "revokedAt" IS NULL`.execute(db);
  // A dump can omit readers acquired after its snapshot; old stop receipts cannot authorize removal.
  await sql`UPDATE source_resource_cache SET "restoreHeld" = true`.execute(db);
  await sql`UPDATE source_resource_read SET state = 'unavailable', "claimTokenHash" = NULL,
    "claimCredentialHash" = NULL, "leaseUntil" = NULL`.execute(db);
};
