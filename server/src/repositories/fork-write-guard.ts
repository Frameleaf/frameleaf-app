import { ConflictException } from '@nestjs/common';
import { type Transaction, sql } from 'kysely';
import type { ForkSchemaPhase } from 'src/repositories/fork-schema.repository.js';
import { isForkWriteEnabled, isLegacyAuthoritative } from 'src/fork-schema/authority.js';
import { DB } from 'src/schema/index.js';

/**
 * Every writer of a fork-owned table takes this first, inside its transaction: it holds the fork
 * phase steady (`FOR SHARE`) and refuses while the fork schema is not writable or a handoff or
 * return reconciliation runs, so no fork row is written that the handoff would not carry.
 */
export const lockForkWrites = async (tx: Transaction<DB>, message: string) => {
  const { rows } = await sql<{ phase: ForkSchemaPhase }>`
    SELECT phase FROM immich_fork.state WHERE id = 1 FOR SHARE
  `.execute(tx);
  const handoff = await sql`
    SELECT 1 FROM immich_fork.migration_audit
    WHERE status = 'running' AND name IN ('official-handoff-preparation', 'fork-return-reconciliation')
    LIMIT 1
  `.execute(tx);
  const phase = rows[0]?.phase;
  if (!phase || !(isLegacyAuthoritative(phase) || isForkWriteEnabled(phase)) || handoff.rows.length > 0) {
    throw new ConflictException(message);
  }
};
