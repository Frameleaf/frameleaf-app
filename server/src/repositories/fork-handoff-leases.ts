import { Kysely, sql } from 'kysely';
import { DB } from 'src/schema/index.js';

/**
 * FL-44 (FN-304): the transient leases Frameleaf features hold in the public schema. None of them is
 * portable — a lease names a worker process, a render-worker credential or one browser tab — so a
 * handoff must not carry a live one across: the official server would never release it, and the
 * fork would come back to a lease whose holder is gone.
 *
 * - A media operation's claim (`claimToken`/`claimExpiresAt`) covers every durable job: renders,
 *   restorations, Takeout imports and preservation packaging all run as media operations. A claimed
 *   chunk (`media_operation_checkpoint.claimToken`) is live only while its operation's claim is.
 *   An expired claim is left as it is: the operation, its settings and its checkpoints are portable,
 *   and the media-operation sweep requeues (or pauses, retries, fails) it when the fork returns.
 * - A render-worker session is a credential; handoff preparation revokes the live ones, and a
 *   worker admits itself again after the return.
 * - A Studio editor lease is one tab's ninety-second write lock; preparation releases it, and the
 *   project, its revisions and its comments stay as they are.
 */
export type HandoffLeaseSummary = {
  operations: Array<{ kind: string; count: number }>;
  checkpoints: number;
  renderWorkerSessions: number;
  studioLeases: number;
  /** When the last live lease lapses on its own, if nothing renews it. */
  lapsesAt: Date | null;
};

export const getLiveHandoffLeases = async (db: Kysely<DB>): Promise<HandoffLeaseSummary> => {
  const operations = await sql<{ kind: string; count: number; lapsesAt: Date | null }>`
    SELECT kind, count(*)::int AS count, max("claimExpiresAt") AS "lapsesAt"
    FROM public.media_operation
    WHERE "claimToken" IS NOT NULL AND "claimExpiresAt" > now()
    GROUP BY kind
    ORDER BY kind
  `.execute(db);
  const others = await sql<{
    checkpoints: number;
    renderWorkerSessions: number;
    studioLeases: number;
    sessionsLapseAt: Date | null;
    studioLapsesAt: Date | null;
  }>`
    SELECT
      (
        SELECT count(*)::int FROM public.media_operation_checkpoint checkpoint
        JOIN public.media_operation operation ON operation.id = checkpoint."operationId"
        WHERE checkpoint."claimToken" IS NOT NULL
          AND checkpoint."claimToken" = operation."claimToken"
          AND operation."claimExpiresAt" > now()
      ) AS checkpoints,
      (
        SELECT count(*)::int FROM public.render_worker_session
        WHERE "revokedAt" IS NULL AND "expiresAt" > now()
      ) AS "renderWorkerSessions",
      (
        SELECT max("expiresAt") FROM public.render_worker_session
        WHERE "revokedAt" IS NULL AND "expiresAt" > now()
      ) AS "sessionsLapseAt",
      (
        SELECT count(*)::int FROM public.studio_project
        WHERE "leaseHolderId" IS NOT NULL AND "leaseExpiresAt" > now()
      ) AS "studioLeases",
      (
        SELECT max("leaseExpiresAt") FROM public.studio_project
        WHERE "leaseHolderId" IS NOT NULL AND "leaseExpiresAt" > now()
      ) AS "studioLapsesAt"
  `.execute(db);
  const row = others.rows[0];
  const lapses = [
    ...operations.rows.map(({ lapsesAt }) => lapsesAt),
    row?.sessionsLapseAt ?? null,
    row?.studioLapsesAt ?? null,
  ]
    .filter((value): value is Date => !!value)
    .map((value) => new Date(value).getTime());
  return {
    operations: operations.rows.map(({ kind, count }) => ({ kind, count: Number(count) })),
    checkpoints: Number(row?.checkpoints ?? 0),
    renderWorkerSessions: Number(row?.renderWorkerSessions ?? 0),
    studioLeases: Number(row?.studioLeases ?? 0),
    lapsesAt: lapses.length > 0 ? new Date(Math.max(...lapses)) : null,
  };
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The refusal an administrator can act on, or null when nothing live would cross the handoff. */
export const describeLiveHandoffLeases = (leases: HandoffLeaseSummary): string | null => {
  const parts: string[] = [];
  const operationCount = leases.operations.reduce((total, { count }) => total + count, 0);
  if (operationCount > 0) {
    const kinds = leases.operations.map(({ kind, count }) => `${kind} x${count}`).join(', ');
    const chunks =
      leases.checkpoints > 0 ? `, ${plural(leases.checkpoints, 'render chunk', 'render chunks')} in flight` : '';
    parts.push(`${plural(operationCount, 'job is', 'jobs are')} still claimed by a worker (${kinds}${chunks})`);
  }
  if (leases.renderWorkerSessions > 0) {
    parts.push(`${plural(leases.renderWorkerSessions, 'render worker is', 'render workers are')} signed in`);
  }
  if (leases.studioLeases > 0) {
    parts.push(`${plural(leases.studioLeases, 'Studio project is', 'Studio projects are')} open for editing`);
  }
  if (parts.length === 0) {
    return null;
  }
  const lapse = leases.lapsesAt ? ` The last lease lapses at ${leases.lapsesAt.toISOString()} if not renewed.` : '';
  return (
    `Official handoff refused: ${parts.join('; ')}. Let running jobs finish or cancel them in Activity, ` +
    `sign render workers out and close Studio editors, then retry.${lapse}`
  );
};

/** Refuses the handoff while any lease that names a live holder exists. */
export const assertNoLiveHandoffLeases = async (db: Kysely<DB>): Promise<void> => {
  const message = describeLiveHandoffLeases(await getLiveHandoffLeases(db));
  if (message) {
    throw new Error(message);
  }
};

/**
 * Releases the leases the handoff may take over itself — render-worker sessions are revoked and
 * Studio editor leases released — and leaves every portable row (operations, checkpoints, projects,
 * revisions) untouched. Runs inside handoff preparation's transaction, before its audit starts.
 */
export const releaseTransientHandoffLeases = async (
  db: Kysely<DB>,
): Promise<{ renderWorkerSessions: number; studioLeases: number }> => {
  const sessions = await sql`
    UPDATE public.render_worker_session SET "revokedAt" = now()
    WHERE "revokedAt" IS NULL AND "expiresAt" > now()
  `.execute(db);
  const studio = await sql`
    UPDATE public.studio_project
    SET "leaseHolderId" = NULL, "leaseClientId" = NULL, "leaseExpiresAt" = NULL
    WHERE "leaseHolderId" IS NOT NULL OR "leaseClientId" IS NOT NULL OR "leaseExpiresAt" IS NOT NULL
  `.execute(db);
  return {
    renderWorkerSessions: Number(sessions.numAffectedRows ?? 0n),
    studioLeases: Number(studio.numAffectedRows ?? 0n),
  };
};
