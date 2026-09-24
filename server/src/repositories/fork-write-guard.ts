import { ConflictException } from '@nestjs/common';
import { type Kysely, type Transaction, sql } from 'kysely';
import type { ForkSchemaPhase } from 'src/repositories/fork-schema.repository.js';
import { isForkWriteEnabled, isLegacyAuthoritative } from 'src/fork-schema/authority.js';
import { DB } from 'src/schema/index.js';

/**
 * Whether a fork-owned table may be written now, holding the fork phase steady (`FOR SHARE`) for
 * the rest of the transaction: the fork schema exists, its phase is writable, and no handoff or
 * return reconciliation runs.
 */
export const canWriteFork = async (tx: Transaction<DB> | Kysely<DB>): Promise<boolean> => {
  const exists = await sql<{ table: string | null }>`SELECT to_regclass('immich_fork.state')::text AS table`.execute(
    tx,
  );
  if (!exists.rows[0]?.table) {
    return false;
  }
  const { rows } = await sql<{ phase: ForkSchemaPhase }>`
    SELECT phase FROM immich_fork.state WHERE id = 1 FOR SHARE
  `.execute(tx);
  const handoff = await sql`
    SELECT 1 FROM immich_fork.migration_audit
    WHERE status = 'running' AND name IN ('official-handoff-preparation', 'fork-return-reconciliation')
    LIMIT 1
  `.execute(tx);
  const phase = rows[0]?.phase;
  return !!phase && (isLegacyAuthoritative(phase) || isForkWriteEnabled(phase)) && handoff.rows.length === 0;
};

/**
 * Every writer of a fork-owned table takes this first, inside its transaction, and is refused while
 * the fork schema is not writable, so no fork row is written that the handoff would not carry.
 */
export const lockForkWrites = async (tx: Transaction<DB>, message: string) => {
  if (!(await canWriteFork(tx))) {
    throw new ConflictException(message);
  }
};
