import { ConflictException } from '@nestjs/common';
import { type Transaction, sql } from 'kysely';
import type { ForkSchemaPhase } from 'src/repositories/fork-schema.repository.js';
import { isForkWriteEnabled, isLegacyAuthoritative } from 'src/fork-schema/authority.js';
import { DB } from 'src/schema/index.js';

/**
 * Takes the fork-state share lock inside `tx` before a write to an `immich_fork` table, and refuses
 * (ConflictException) while the fork schema may not be written: a phase in which neither the legacy
 * schema is authoritative nor fork writes are enabled, or a running official handoff preparation or
 * fork-return reconciliation. Shared by the face correction history, merge-suggestion answers
 * (FL-57) and pet recognition runs (FL-58).
 */
export const lockForkWrites = async (tx: Transaction<DB>, what: string): Promise<void> => {
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
    throw new ConflictException(`${what} are unavailable during database handoff`);
  }
};
