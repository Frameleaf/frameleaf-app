import { Kysely, Transaction, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { DB } from 'src/schema/index.js';
import { AttemptDirectoryWindows } from 'src/utils/attempt-directory.js';
import { ATTEMPT_EVIDENCE_PREFIX, pruneAttemptEvidence } from 'src/utils/attempt-evidence.js';
import { ATTEMPT_GRACE_MS, AttemptCursor, emptyAttemptCursor, sweepAttemptTree } from 'src/utils/attempt-tree.js';

const STATE_KEY = 'frameleaf-attempt-cleanup-v1';
type Pass = { id: string; startedAt: number; clock: 'database'; complete: boolean; incomplete: boolean };
type SweepState = { roots: string[]; cursor: AttemptCursor; pass: Pass; owner: string | null; expires: number };
type Remove = (tx: Transaction<DB>, path: string, unlink: () => Promise<boolean>) => Promise<boolean>;
const windows = new AttemptDirectoryWindows();
let windowsPass: string | undefined;
export const closeAttemptSweep = () => windows.close();
const newPass = (now: number): Pass => ({
  id: randomUUID(),
  startedAt: now,
  clock: 'database',
  complete: false,
  incomplete: false,
});

/** Short durable lease; no reserved SQL connection while walking the filesystem. */
export async function sweepAttemptOutputs(db: Kysely<DB>, roots: string[], remove: Remove) {
  const owner = randomUUID();
  const acquisition = await db.transaction().execute(async (tx) => {
    await sql`SET LOCAL lock_timeout='1s'`.execute(tx);
    const {
      rows: [lock],
    } = await sql<{ acquired: boolean; now: number }>`SELECT pg_try_advisory_xact_lock(-333, 2) acquired,
      (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS now`.execute(tx);
    if (!lock.acquired) return;
    const initial: SweepState = {
      roots,
      cursor: emptyAttemptCursor(),
      pass: newPass(Number(lock.now)),
      owner: null,
      expires: 0,
    };
    await sql`INSERT INTO system_metadata (key, value) VALUES (${STATE_KEY}, ${JSON.stringify(initial)}::text::jsonb)
      ON CONFLICT (key) DO NOTHING`.execute(tx);
    const {
      rows: [row],
    } = await sql<{ value: SweepState; now: number }>`SELECT value,
      (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS now FROM system_metadata WHERE key=${STATE_KEY} FOR UPDATE`.execute(
      tx,
    );
    if (row.value.expires > Number(row.now)) return;
    const sameRoots = JSON.stringify(row.value.roots) === JSON.stringify(roots);
    // Legacy boundaries used the application clock. Their unseen-evidence cutoff is
    // unknowable, so restart the traversal instead of pruning with that saved pass.
    const resumable = sameRoots && row.value.pass?.clock === 'database';
    const state: SweepState = {
      roots,
      cursor: resumable ? row.value.cursor : emptyAttemptCursor(),
      pass: resumable ? row.value.pass : newPass(Number(row.now)),
      owner,
      expires: Number(row.now) + 60_000,
    };
    await sql`UPDATE system_metadata SET value=${JSON.stringify(state)}::text::jsonb WHERE key=${STATE_KEY}`.execute(
      tx,
    );
    return { state, now: Number(row.now) };
  });
  if (!acquisition) return;
  const { state, now } = acquisition;
  if (windowsPass !== state.pass.id) {
    await windows.close();
    windowsPass = state.pass.id;
  }
  const withLease = <T>(work: (tx: Transaction<DB>) => Promise<T>) =>
    db.transaction().execute(async (tx) => {
      await sql`SET LOCAL lock_timeout='1s'`.execute(tx);
      await sql`SET LOCAL statement_timeout='3s'`.execute(tx);
      const lease = await sql`SELECT key FROM system_metadata WHERE key=${STATE_KEY}
      AND value->>'owner'=${owner} AND (value->>'expires')::numeric > extract(epoch FROM clock_timestamp()) * 1000
      FOR UPDATE`.execute(tx);
      if (lease.rows.length !== 1) throw new Error('Attempt cleanup lease lost');
      return work(tx);
    });
  try {
    if (state.pass.complete) {
      const removed = await withLease((tx) => pruneAttemptEvidence(tx, state.pass));
      if (removed < 250) state.pass = newPass(now);
      await save();
      return { deleted: 0, visited: 0, examined: 0, done: true, incomplete: false };
    }
    const result = await sweepAttemptTree({
      roots,
      cursor: state.cursor,
      windows,
      remove: async (path, identity, unlink) => {
        return withLease(async (tx) => {
          // Mark every encountered attempt file, including recent/published files. Evidence
          // may not be discarded merely because that output is not currently age-eligible.
          await sql`UPDATE system_metadata SET value=jsonb_set(value,'{seenPass}',to_jsonb(${state.pass.id}::text))
          WHERE key=${ATTEMPT_EVIDENCE_PREFIX + identity.token} AND value->>'jobId'=${identity.jobId}`.execute(tx);
          // A concurrent retention transaction may be deleting this row. SKIP LOCKED is
          // fail-closed: absence is usable only with compact positive stopped evidence.
          const {
            rows: [job],
          } = await sql<{ state: string }>`SELECT state FROM job
          WHERE id=${identity.jobId}::uuid FOR UPDATE SKIP LOCKED`.execute(tx);
          if (job && ['active', 'needs_attention'].includes(job.state)) return false;
          if (!job) {
            const exists = await sql`SELECT 1 FROM job WHERE id=${identity.jobId}::uuid`.execute(tx);
            if (exists.rows.length > 0) return false;
          }
          const proof =
            await sql`SELECT 1 FROM system_metadata m WHERE m.key=${ATTEMPT_EVIDENCE_PREFIX + identity.token}
          AND m.value->>'jobId'=${identity.jobId}
          AND (m.value->>'stoppedAt')::numeric < extract(epoch FROM clock_timestamp())*1000-${ATTEMPT_GRACE_MS}
          UNION ALL SELECT 1 FROM job_attempt a LEFT JOIN system_metadata worker
            ON worker.key='frameleaf-worker-stopped:' || a."workerId"::text
          WHERE a."jobId"=${identity.jobId}::uuid AND a.token=${identity.token}::uuid
            AND a."finishedAt" < clock_timestamp()-${ATTEMPT_GRACE_MS}*interval '1 millisecond'
            AND (a.outcome='completed' OR ((worker.value->>'stoppedAt')::numeric <
              extract(epoch FROM clock_timestamp())*1000-${ATTEMPT_GRACE_MS} AND worker.value->>'workerId'=a."workerId"::text))`.execute(
              tx,
            );
          if (proof.rows.length === 0) return false;
          return remove(tx, path, unlink);
        });
      },
    });
    state.cursor = result.cursor;
    state.pass.incomplete ||= result.incomplete;
    if (result.done) {
      // A missing/symlink/depth-limited subtree cannot prove absence. Keep its evidence.
      state.pass = state.pass.incomplete ? newPass(now) : { ...state.pass, complete: true };
    }
    await save();
    return result;
  } catch (error) {
    await windows.close();
    await sql`UPDATE system_metadata SET value=jsonb_set(jsonb_set(value,'{owner}','null'::jsonb),'{expires}','0'::jsonb)
      WHERE key=${STATE_KEY} AND value->>'owner'=${owner}`.execute(db);
    throw error;
  }
  async function save() {
    await sql`UPDATE system_metadata SET value=${JSON.stringify({ ...state, owner: null, expires: 0 })}::text::jsonb
      WHERE key=${STATE_KEY} AND value->>'owner'=${owner}`.execute(db);
  }
}
