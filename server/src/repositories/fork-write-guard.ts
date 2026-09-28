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

/**
 * FL-44 (FN-304): the message every Frameleaf-owned public table refuses a write with while a
 * database handoff holds the schema, so callers and specs can recognise it.
 */
export const FORK_HANDOFF_WRITE_REFUSAL = 'This change is unavailable during database handoff';

/**
 * FL-44 (FN-304): the guard for Frameleaf-owned tables in the public schema (media operations,
 * Studio, preservation, render workers, Takeout, physical files). Those tables exist whether or not
 * the fork schema was installed, so a server without `immich_fork.state` keeps writing them; once
 * the fork schema exists the same rule as `lockForkWrites` applies — the phase is held steady
 * (`FOR SHARE`) and the write is refused while the phase is not writable or a handoff or return
 * reconciliation runs, so nothing is written that the handoff would not carry.
 */
export const lockPublicForkWrites = async (tx: Transaction<DB>, message = FORK_HANDOFF_WRITE_REFUSAL) => {
  const exists = await sql<{ table: string | null }>`SELECT to_regclass('immich_fork.state')::text AS table`.execute(
    tx,
  );
  if (!exists.rows[0]?.table) {
    return;
  }
  if (!(await canWriteFork(tx))) {
    throw new ConflictException(message);
  }
};

/**
 * FL-44 (FN-304): runs `write` in a transaction that first takes `lockPublicForkWrites`. Use it for
 * single-statement writers that otherwise would not open a transaction.
 */
export const withPublicForkWrites = <T>(
  db: Kysely<DB>,
  write: (tx: Transaction<DB>) => Promise<T>,
  message = FORK_HANDOFF_WRITE_REFUSAL,
): Promise<T> =>
  db.transaction().execute(async (tx) => {
    await lockPublicForkWrites(tx, message);
    return write(tx);
  });
