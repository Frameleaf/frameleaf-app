import { Kysely, type Transaction, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { MediaOperationDestination, MediaOperationStatus } from 'src/enum.js';
import {
  ACTIVE_MEDIA_OPERATION_STATUSES,
  CLAIMED_MEDIA_OPERATION_STATUSES,
  MEDIA_OPERATION_AUTO_RETRIES,
  MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
  SAFE_MEDIA_OPERATION_REPLAY_KINDS,
} from 'src/utils/media-operation.js';

/** Restore runs with application writers stopped. Never inherit an execution lease from a backup. */
export const resetMediaOperationsAfterRestore = async (db: Kysely<DB> | Transaction<DB>): Promise<void> => {
  await sql`
    WITH previous AS (
      SELECT id, status,
        ("claimToken" IS NOT NULL OR status = ANY(${[...CLAIMED_MEDIA_OPERATION_STATUSES]}::text[])) AS interrupted,
        (kind = ANY(${[...SAFE_MEDIA_OPERATION_REPLAY_KINDS]}::text[])
          AND destination = ${MediaOperationDestination.Local} AND "remoteJobId" IS NULL) AS repeatable
      FROM public.media_operation WHERE status = ANY(${[...ACTIVE_MEDIA_OPERATION_STATUSES]}::text[])
      FOR UPDATE
    ), decisions AS (
      SELECT previous.id, previous.interrupted,
        CASE
          WHEN NOT previous.repeatable THEN ${MediaOperationStatus.Failed}
          WHEN operation."cancelRequestedAt" IS NOT NULL THEN ${MediaOperationStatus.Cancelled}
          WHEN previous.status = ${MediaOperationStatus.Paused} OR operation."pauseRequestedAt" IS NOT NULL
            THEN ${MediaOperationStatus.Paused}
          WHEN previous.interrupted AND operation."autoRetries" >= ${MEDIA_OPERATION_AUTO_RETRIES}
            THEN ${MediaOperationStatus.Failed}
          ELSE ${MediaOperationStatus.Queued}
        END AS status
      FROM previous JOIN public.media_operation operation ON operation.id = previous.id
    )
    UPDATE public.media_operation operation SET
      status = decisions.status,
      "autoRetries" = operation."autoRetries" + CASE
        WHEN decisions.interrupted AND decisions.status = ${MediaOperationStatus.Queued} THEN 1 ELSE 0 END,
      "retryAt" = CASE WHEN decisions.status = ${MediaOperationStatus.Queued} THEN
        CASE WHEN decisions.interrupted THEN clock_timestamp() + ${MEDIA_OPERATION_AUTO_RETRY_DELAY_MS} * interval '1 millisecond'
          ELSE operation."retryAt" END ELSE NULL END,
      "errorCode" = CASE WHEN decisions.status = ${MediaOperationStatus.Failed} THEN 'restore_needs_attention'
        WHEN decisions.interrupted AND decisions.status = ${MediaOperationStatus.Queued} THEN 'restore_retry'
        ELSE operation."errorCode" END,
      error = CASE WHEN decisions.status = ${MediaOperationStatus.Failed}
        THEN 'Restored execution requires review before replay; destination and remote identity were preserved'
        WHEN decisions.interrupted AND decisions.status = ${MediaOperationStatus.Queued}
        THEN 'Restored safe local work will resume from its durable checkpoint'
        ELSE operation.error END,
      "finishedAt" = CASE WHEN decisions.status IN (${MediaOperationStatus.Failed}, ${MediaOperationStatus.Cancelled})
        THEN clock_timestamp() ELSE operation."finishedAt" END
    FROM decisions WHERE operation.id = decisions.id
  `.execute(db);
  // Terminal outcomes and remote cancellation acknowledgements remain historical facts. Only leases are transient.
  await sql`UPDATE public.media_operation SET "claimToken" = NULL, "claimedBy" = NULL,
    "claimExpiresAt" = NULL, "heartbeatAt" = NULL, "attemptStartedAt" = NULL
    WHERE "claimToken" IS NOT NULL OR "claimedBy" IS NOT NULL OR "claimExpiresAt" IS NOT NULL
      OR "heartbeatAt" IS NOT NULL OR "attemptStartedAt" IS NOT NULL
  `.execute(db);
};
