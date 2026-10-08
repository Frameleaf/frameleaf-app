import { type Transaction, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';

// Distinct from the legacy session key: the outer settings lock uses a different connection.
export const EFFECTIVE_CONFIG_LOCK = 'frameleaf-effective-config:v1';

/** Before config reads/writes or domain locks, on the connection that will commit the operation. */
export async function lockEffectiveConfig(tx: Transaction<DB>, mode: 'read' | 'write') {
  if (mode === 'write') {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${EFFECTIVE_CONFIG_LOCK},0))`.execute(tx);
  } else {
    await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${EFFECTIVE_CONFIG_LOCK},0))`.execute(tx);
  }
}
