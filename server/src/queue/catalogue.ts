import { type QueryExecutorProvider, type Transaction, sql } from 'kysely';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DB } from 'src/schema/index.js';
import { DatabaseLock } from 'src/enum.js';
import { jobSignal } from 'src/queue/context.js';

/**
 * FL-1172: `job_queue` row locks fence queue work. An enqueue, claim or failure locks its queue's row; a publication
 * that may reach any queue locks every row (the catalogue), in name order, before any job or domain row.
 *
 * Taken row by row, a catalogue waiter held the rows it already had while enqueues and claims kept taking the next
 * one, and every other catalogue waiter queued behind it. That convoy ran past the pool's 5 s lock_timeout although
 * no holder was older than 0.16 s. The turnstile is an advisory lock in front of the rows: catalogue lockers hold it
 * exclusively, single-queue lockers share it. PostgreSQL queues a new shared request behind a waiting exclusive one, so
 * a catalogue lock waits once for the single-queue transactions already running, side by side, then takes every row
 * without waiting. The rows remain the fence; the lock order and their conflicts are unchanged. Foreign-key checks
 * never take the turnstile, and a row locker that skips it is only as unfair as before.
 */
// The comments name job_queue in pg_stat_activity, where a wait on the turnstile shows up as an advisory lock.
export const enterQueueTurnstile = (db: QueryExecutorProvider) =>
  sql`select pg_advisory_xact_lock_shared(${DatabaseLock.QueueCatalogue}::bigint) /* job_queue turnstile */`.execute(
    db,
  );

/** One queue's row. Several queues: pass them all, they are locked in name order. */
export async function lockQueues(db: QueryExecutorProvider, queues: string[]) {
  await enterQueueTurnstile(db);
  await sql`select name from job_queue where name = any(${queues}::text[]) order by name for no key update`.execute(db);
}

export async function lockQueueCatalogue(db: QueryExecutorProvider) {
  await sql`select pg_advisory_xact_lock(${DatabaseLock.QueueCatalogue}::bigint) /* job_queue catalogue */`.execute(db);
  await sql`select name from job_queue order by name for no key update`.execute(db);
}

export const isLockContention = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && (error.code === '55P03' || error.code === '40P01');

/** Without a claim to bound it, a caller gives up after about 10 s of backoff. */
const UNCLAIMED_ATTEMPTS = 8;

/**
 * Runs `work` in a transaction (`start` opens it) whose first statement takes the catalogue. A lost wait for that lock
 * is contention, not a failure of the work: nothing has run, so it starts over after a backoff, without spending the
 * job's retry. A claim keeps retrying until it is stopped (its deadline or a cancellation aborts the signal). Contention
 * anywhere after the catalogue is held still fails as before.
 */
export async function withQueueCatalogue<T>(
  start: <R>(work: (tx: Transaction<DB>) => Promise<R>) => Promise<R>,
  work: (tx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  const signal = jobSignal();
  for (let attempt = 1; ; attempt++) {
    let locked = false;
    try {
      return await start(async (tx) => {
        locked = false;
        await lockQueueCatalogue(tx);
        locked = true;
        return work(tx);
      });
    } catch (error) {
      if (locked || !isLockContention(error) || (!signal && attempt >= UNCLAIMED_ATTEMPTS)) throw error;
      signal?.throwIfAborted();
      const backoff = Math.min(2000, 50 * 2 ** attempt) * (0.5 + Math.random() / 2);
      await sleep(backoff, undefined, signal ? { signal } : undefined);
    }
  }
}
