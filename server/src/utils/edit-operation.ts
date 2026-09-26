import { sql } from 'kysely';
import type { JobItem } from 'src/types.js';
import { JobName, JobStatus, MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';

/**
 * Edits inside the durable job contract (FL-43).
 *
 * A saved photo edit, a photo version render and a video edit or export are rendered by the job
 * queue, exactly as before: `MediaService` and `AssetDevelopService` stay the executors. What
 * changes is that each render now has a `media_operation` row, written when it is queued, so it
 * shows in Activity, survives a reload and a restart, and follows the same claim, cancel, retry and
 * recovery rules as every other job.
 *
 * The row is held by the job queue rather than by a worker that polls for it. That is what
 * `claimedBy = 'job-queue'` on a queued row means: nothing else may claim it (a render worker that
 * serves quick edits never sees it), and the queued job carries the row's id. When the job runs it
 * takes a real claim on the row (`beginJobQueueRun`), heartbeats while it works, and settles it.
 * A row that goes back to the queue without a holder (its automatic retry, or recovery of a lapsed
 * claim) is dispatched to the job queue again by `MediaOperationSweepService`.
 */

/** `snapshot.executor` of a row the job queue runs. */
export const JOB_QUEUE_EXECUTOR = 'job_queue';

/** `claimedBy` of a job-queue row: queued with its job, or claimed by the run of that job. */
export const JOB_QUEUE_CLAIMANT = 'job-queue';

/** Rows the job queue runs are never offered to a polling worker or a render worker. */
export const notJobQueueExecuted = () => sql<boolean>`coalesce("snapshot"->>'executor', '') <> ${JOB_QUEUE_EXECUTOR}`;

/** How long a run's claim lasts without a heartbeat; a run heartbeats at a third of it. */
export const EDIT_OPERATION_LEASE_MS = 5 * 60 * 1000;

/**
 * A job-queue row still queued with its job this long after it was last touched is dispatched again:
 * the queue lost the job (a flushed queue, a restart before it was stored). A duplicate delivery is
 * harmless, because only one run can claim the row.
 */
export const EDIT_OPERATION_REDISPATCH_MS = 15 * 60 * 1000;

/** What was edited. Stored in `settings.edit`; Activity names the row by it. */
export enum EditOperationEdit {
  /** A saved crop, rotate or mirror of a photo: its edited previews are rendered again. */
  PhotoEdit = 'photo_edit',
  /** A photo version (FL-113): a develop recipe rendered from the original into a new master. */
  PhotoVersion = 'photo_version',
  /** A saved or restored video edit (FL-39): a new master and playback proxy. */
  VideoEdit = 'video_edit',
  /** A video version rendered for download (FL-39). */
  VideoExport = 'video_export',
}

const EDITS = new Set<string>(Object.values(EditOperationEdit));

export const asEditOperationEdit = (value: unknown): EditOperationEdit | undefined =>
  typeof value === 'string' && EDITS.has(value) ? (value as EditOperationEdit) : undefined;

/** The edit a row records, when it is a job-queue edit row. */
export const editOperationEdit = (operation: {
  kind: string;
  settings: unknown;
  snapshot?: unknown;
}): EditOperationEdit | undefined => {
  if (operation.kind !== MediaOperationKind.QuickEdit) {
    return undefined;
  }
  const settings = operation.settings as Record<string, unknown> | null;
  return asEditOperationEdit(settings?.edit);
};

/**
 * Edits that can be stopped once queued (FL-43, "cancel only where the underlying job supports it").
 *
 * A photo version checks for a cancel between its stages and publishes only at the end, so it can
 * stop anywhere and the previous version stays current. A photo edit's previews and a video edit's
 * master are the rendering of edits that are already saved: stopping one would leave the saved edit
 * showing stale previews, and the video encoder has no stop, so neither is offered a cancel.
 */
export const CANCELLABLE_EDITS: ReadonlySet<EditOperationEdit> = new Set([EditOperationEdit.PhotoVersion]);

/**
 * Edits that can be retried after they failed. Every edit can: a photo edit renders the saved edit
 * again, a photo version renders its revision again, a video edit renders the requested version
 * again and a video export its version. Only a failed job is retried, and a cancelled photo version.
 */
export const RETRYABLE_EDITS: ReadonlySet<EditOperationEdit> = new Set(Object.values(EditOperationEdit));

export const canCancelEdit = (edit: EditOperationEdit) => CANCELLABLE_EDITS.has(edit);

export const canRetryEdit = (edit: EditOperationEdit, status: MediaOperationStatus) =>
  RETRYABLE_EDITS.has(edit) &&
  (status === MediaOperationStatus.Failed ||
    (status === MediaOperationStatus.Cancelled && CANCELLABLE_EDITS.has(edit)));

/** The job an edit row runs. Only these are ever queued from a row's snapshot. */
export type EditOperationJob =
  | { name: JobName.AssetEditThumbnailGeneration; data: { id: string } }
  | { name: JobName.AssetVideoEditGeneration; data: { id: string; versionId?: string } }
  | { name: JobName.AssetDevelopRender; data: { id: string } };

const EDIT_JOB_NAMES = new Set<string>([
  JobName.AssetEditThumbnailGeneration,
  JobName.AssetVideoEditGeneration,
  JobName.AssetDevelopRender,
]);

/**
 * The job a row's snapshot names, with the row's id attached, or undefined when the snapshot is not
 * an edit job. The snapshot is data written by this server, but it is read defensively all the same:
 * only the three edit jobs, and only their id fields, are ever queued from it.
 */
export const editOperationJobItem = (operationId: string, snapshot: unknown): JobItem | undefined => {
  const value = snapshot as Record<string, unknown> | null;
  if (value?.executor !== JOB_QUEUE_EXECUTOR) {
    return undefined;
  }
  const job = value.job as { name?: unknown; data?: Record<string, unknown> } | undefined;
  if (typeof job?.name !== 'string' || !EDIT_JOB_NAMES.has(job.name) || typeof job.data?.id !== 'string') {
    return undefined;
  }
  const data: Record<string, unknown> = { id: job.data.id, operationId };
  if (job.name === JobName.AssetVideoEditGeneration && typeof job.data.versionId === 'string') {
    data.versionId = job.data.versionId;
  }
  return { name: job.name, data } as JobItem;
};

export type EditOperationInput = {
  ownerId: string;
  edit: EditOperationEdit;
  assetId: string;
  /** The asset's file name; what the owner recognises in Activity, withheld while it is Locked. */
  label: string;
  /** The develop revision or video version rendered, when there is one. */
  revisionId?: string | null;
  job: EditOperationJob;
};

/** The row an edit is recorded as when it is queued. Local, because the job queue runs here. */
export const editOperationCreate = (input: EditOperationInput) => ({
  ownerId: input.ownerId,
  kind: MediaOperationKind.QuickEdit,
  destination: MediaOperationDestination.Local,
  destinationDetail: null,
  label: input.label,
  assetId: input.assetId,
  resultAssetId: null,
  retryOfId: null,
  projectId: null,
  revisionId: input.revisionId ?? null,
  snapshot: {
    executor: JOB_QUEUE_EXECUTOR,
    edit: input.edit,
    assetId: input.assetId,
    revisionId: input.revisionId ?? null,
    job: input.job,
  },
  settings: { edit: input.edit },
  estimate: null,
  claimedBy: JOB_QUEUE_CLAIMANT,
});

/**
 * What a finished executor said, as the row's outcome.
 *
 * - `Success`: the edit was published; the row completes with the asset as its result.
 * - `Skipped`: there was nothing to publish — the version was already rendered, or a newer edit
 *   superseded it before it could be published. The row completes without replacing anything.
 * - `Failed`: the row fails, with its one automatic retry when it has one left.
 */
export const editOperationOutcome = (status: JobStatus): 'published' | 'nothing' | 'failed' => {
  switch (status) {
    case JobStatus.Success: {
      return 'published';
    }
    case JobStatus.Failed: {
      return 'failed';
    }
    default: {
      return 'nothing';
    }
  }
};
