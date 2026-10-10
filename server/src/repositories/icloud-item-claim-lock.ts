import { Transaction, sql } from 'kysely';
import { DB } from 'src/schema/index.js';

/** CPLAsset is the whole-item scope: still/motion resource roles share this canonical key. */
export const iCloudItemClaimLockKey = (ownerId: string, name: string) =>
  `icloud-item-claim:v1:${ownerId.toLowerCase()}:${name.toUpperCase()}`;

/** Before claim rows or cleanup owner/operation/resource locks.
 * Covers absent rows too. Sorted keys keep overlapping multi-item claim writers ordered.
 */
export async function lockICloudItemClaims(tx: Transaction<DB>, ownerId: string, names: string[]) {
  const canonical = [...new Set(names.map((name) => name.toUpperCase()))].sort();
  for (const name of canonical) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${iCloudItemClaimLockKey(ownerId, name)},0))`.execute(tx);
  }
  return canonical;
}
