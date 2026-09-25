import {
  MediaOperationBulkAction,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  type MediaOperationDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { bulkActionTitleKey } from '$lib/frameleaf/bulk-actions';
import type { BulkOperationRecord } from '$lib/frameleaf/library-session';
import type { DownloadState } from '$lib/managers/download-manager.svelte';
import { UploadState, type UploadAsset } from '$lib/types';

/**
 * The Activity page's view model (FL-104), ported from the prototype's `Activity.jsx` and the job
 * normaliser in `state.mjs`.
 *
 * The prototype advanced its jobs on a one-second timer and stored them in local storage. None of
 * that survives here: a render's state is a row on the server, and this module only turns what the
 * server said — plus the transfers this browser tab is genuinely running — into one list.
 *
 * Four sources, one shape:
 *
 * - **Server jobs.** Durable renders, restorations and edits. Real progress, real destination,
 *   cancel and retry that reach the server.
 * - **Uploads** and **downloads.** Genuinely browser-local: they belong to this tab and disappear
 *   with it, which the page says rather than implying they will carry on.
 * - **Bulk operations.** FL-32's durable `bulk` jobs are server jobs like any other and arrive with
 *   the first source, carrying their counts. The library session's own records only cover the part
 *   a tab does before handing a job over — finding the matching set — and show up here meanwhile.
 */

/** Where an item came from. Decides which actions it can offer. */
export type ActivitySource = 'job' | 'upload' | 'download' | 'bulk';

/** How the row reads. Colour never carries meaning on its own; the status key does. */
export type ActivityTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export type ActivityFilter = 'all' | 'running' | 'done' | 'failed';

export const ACTIVITY_FILTERS: readonly ActivityFilter[] = ['all', 'running', 'done', 'failed'];

/** Server statuses where the job is still the server's problem. */
const RUNNING_STATUSES: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
]);

const STATUS_TONE: Record<MediaOperationStatus, ActivityTone> = {
  [MediaOperationStatus.Queued]: 'neutral',
  [MediaOperationStatus.Preparing]: 'info',
  [MediaOperationStatus.Rendering]: 'info',
  [MediaOperationStatus.Validating]: 'info',
  [MediaOperationStatus.Cancelling]: 'warning',
  [MediaOperationStatus.Completed]: 'success',
  [MediaOperationStatus.Cancelled]: 'neutral',
  [MediaOperationStatus.Failed]: 'danger',
  // Held by its owner (FL-104). The prototype's Activity reads a pause in the warning tone: nothing
  // is wrong, but nothing will happen until somebody resumes it.
  [MediaOperationStatus.Paused]: 'warning',
};

/** Statuses a pause may be asked for from; the server refuses the rest (FL-104). */
const PAUSABLE_STATUSES: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
]);

/** Statuses a worker is on the job in; a pause asked for here lands at its next checkpoint. */
const WORKING_STATUSES: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
]);

/**
 * What a job's pause control does (FL-104, owner request September 23, 2026).
 *
 * - `paused`: the job is held; the control resumes it.
 * - `pausePending`: the owner asked, and the worker has not reached its checkpoint yet. The row
 *   says "Pausing" and the control resumes, which withdraws the request.
 * - `canPause`: a pausable kind in a state the server will pause from.
 * - `pauseBlockedKey`: why the control is shown disabled — a one-shot kind, a job validating its
 *   output, a job stopping. Absent when the job is finished and there is no control at all.
 *
 * These only mirror the server's rules so the control is not offered pointlessly; the server
 * decides, and the row changes when it answers.
 */
export type ActivityPauseState = {
  paused: boolean;
  pausePending: boolean;
  canPause: boolean;
  canResume: boolean;
  pauseBlockedKey?: Translations;
};

export const mediaOperationPauseState = (
  operation: Pick<MediaOperationDto, 'status' | 'pausable' | 'pauseRequestedAt' | 'cancelRequestedAt'>,
): ActivityPauseState => {
  const status = operation.status;
  const paused = status === MediaOperationStatus.Paused;
  const pausePending = !paused && !!operation.pauseRequestedAt && WORKING_STATUSES.has(status);
  const canResume = paused || pausePending;
  const canPause = !canResume && !!operation.pausable && PAUSABLE_STATUSES.has(status) && !operation.cancelRequestedAt;

  let pauseBlockedKey: Translations | undefined;
  if (!canPause && !canResume && RUNNING_STATUSES.has(status)) {
    if (!operation.pausable) {
      pauseBlockedKey = 'frameleaf_running_pause_unavailable_kind';
    } else if (status === MediaOperationStatus.Cancelling || operation.cancelRequestedAt) {
      pauseBlockedKey = 'frameleaf_running_pause_unavailable_stopping';
    } else {
      pauseBlockedKey = 'frameleaf_running_pause_unavailable_finishing';
    }
  }

  return { paused, pausePending, canPause, canResume, ...(pauseBlockedKey && { pauseBlockedKey }) };
};

/** A count the server sends as a string; null when absent or not a real number. */
const asCount = (value: string | number | null | undefined): number | null => {
  if ((value ?? '') === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

export type ActivityItem = {
  /** Unique across every source; server ids are prefixed so they cannot collide with a filename. */
  id: string;
  source: ActivitySource;
  /** The server job id, when there is one. What cancel, retry and dismiss act on. */
  operationId?: string;
  /** i18n key for the kind of work, e.g. `frameleaf_activity_kind_studio_export`. */
  kindKey: Translations;
  /** i18n key for the state, e.g. `frameleaf_activity_status_rendering`. */
  statusKey: Translations;
  tone: ActivityTone;
  /** What the person recognises: a project name, a filename, an archive name. */
  title: string;
  /** Used instead of `title` when the name is a translated label rather than the user's own text. */
  titleKey?: Translations;
  /** A Locked item this session may not see (FL-43): named generically and never shown by thumbnail. */
  withheld?: boolean;
  /** Percent complete, or null when the total is not known and a bar would be a guess. */
  progress: number | null;
  /** Still working. Drives the indicator's count and the presence of Cancel. */
  running: boolean;
  /** Held by its owner (FL-104). Neither running nor finished: it can be resumed or cancelled. */
  paused: boolean;
  /** Asked to pause, but its worker has not reached a checkpoint yet (FL-104). */
  pausePending: boolean;
  /** The server will pause it now. */
  canPause: boolean;
  /** Paused, or pausing: the control resumes it. */
  canResume: boolean;
  /** i18n key for why pausing is not possible right now, when the job is unfinished. */
  pauseBlockedKey?: Translations;
  /** Units of work done and in total, when the server counts them; null when it does not. */
  done: number | null;
  total: number | null;
  /** Finished one way or another. */
  finished: boolean;
  /** Finished badly, or finished with failures inside it. */
  failed: boolean;
  /** i18n key for where the work runs; absent for browser-local transfers. */
  destinationKey?: Translations;
  /** Already-translated settings fragments shown under the title, e.g. "3840×2160 · MP4". */
  details: string[];
  /** Operator detail from the server. Shown as given; never invented. */
  error?: string;
  /** Stable server code, so the client can translate a known failure. */
  errorCode?: string;
  /** Sort key: newest first. */
  startedAt: number;
  assetId?: string;
  canCancel: boolean;
  canRetry: boolean;
  canDismiss: boolean;
  /** True when the work only exists in this browser tab and will not survive leaving it. */
  browserLocal: boolean;
  /**
   * A bulk job's running totals. Counts only: which items were refused, and what they are, is not
   * shown here, so a Locked or sensitive item never appears on this page by name or thumbnail.
   */
  bulk?: { requested: number; succeeded: number; failed: number; skipped: number; retried: number };
  /**
   * Set on a completed portable Studio bundle job (FL-91): an export offers its file, an import the
   * project it created; both are looked up through the owner-scoped bundle routes when asked for.
   */
  studioBundle?: 'export' | 'import';
  /** A Studio export or preview (FL-104): the project it renders, so the row can open it in Studio. */
  projectId?: string;
  /** The server's measured estimate of the time left, in seconds, when it has one. */
  estimateSeconds?: number;
  /** The server's estimate of the output size, in bytes, when it has one (prototype "Done · 12 MB"). */
  sizeBytes?: number;
};

const DESTINATION_KEY: Record<MediaOperationDestination, Translations> = {
  [MediaOperationDestination.Local]: 'frameleaf_activity_destination_local',
  [MediaOperationDestination.Lan]: 'frameleaf_activity_destination_lan',
  [MediaOperationDestination.Runpod]: 'frameleaf_activity_destination_runpod',
};

/** Settings the prototype showed under a job title, in its order, skipping whatever is absent. */
const SETTINGS_FIELDS = ['resolution', 'format', 'mode', 'preset'] as const;

const asText = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim().slice(0, 80);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
};

/**
 * The settings fragments for a job's meta line.
 *
 * Deliberately conservative: only the known fields, only when they carry a value. An arbitrary
 * settings object from the server is not spilled into the interface.
 */
export const activitySettingsDetails = (settings: Record<string, unknown> | undefined): string[] => {
  if (!settings) {
    return [];
  }

  const details = SETTINGS_FIELDS.map((field) => asText(settings[field])).filter(
    (value): value is string => value !== null,
  );

  const upscale = asText(settings.upscale);
  if (upscale && !details.includes(upscale)) {
    details.push(`${upscale}×`);
  }

  return details;
};

const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

/**
 * A job back in the queue for its automatic retry (FL-104). Every job gets one before a failure is
 * reported, so a job in this state has failed once and will run again by itself; it reads as
 * retrying, with the failure it is retrying after, rather than as freshly queued.
 */
export const isRetryingMediaOperation = (operation: Pick<MediaOperationDto, 'status' | 'autoRetries' | 'retryAt'>) =>
  operation.status === MediaOperationStatus.Queued && ((operation.autoRetries ?? 0) > 0 || !!operation.retryAt);

/** Statuses an iCloud sync's worker is on it in; "Rendering" means nothing for a sync (FL-68). */
const ICLOUD_WORKING: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
]);

/**
 * An iCloud sync back in the queue to wait out the provider or items on their own back-off (FL-68).
 * It holds a retry time but has not used its automatic retry, so nothing has failed.
 */
export const isWaitingICloudSync = (operation: Pick<MediaOperationDto, 'status' | 'autoRetries' | 'retryAt'>) =>
  operation.status === MediaOperationStatus.Queued && !!operation.retryAt && (operation.autoRetries ?? 0) === 0;

/** A physical deduplication plan's name, `PD-` and eight characters, or nothing. */
const asPlanName = (value: unknown): string | null =>
  typeof value === 'string' && /^PD-[\dA-F]{8}$/.test(value) ? value : null;

/**
 * One durable server job as a row.
 *
 * `progress` is null while the job is queued and nothing has been counted: an empty bar is honest
 * where a bar sitting at zero looks stalled.
 */
export const fromMediaOperation = (operation: MediaOperationDto): ActivityItem => {
  if (operation.kind === MediaOperationKind.Bulk) {
    return fromBulkMediaOperation(operation);
  }

  const status = operation.status;
  const running = RUNNING_STATUSES.has(status);
  const pause = mediaOperationPauseState(operation);
  const finished = !running && !pause.paused;
  const failed = status === MediaOperationStatus.Failed;
  const counted = Number(operation.totalUnits ?? 0) > 0 || operation.progress > 0;
  const icloud = operation.kind === MediaOperationKind.IcloudSync;
  // An iCloud sync hands itself back to wait out a provider back-off without failing (FL-68): a
  // delayed queued run that has not failed is waiting, not retrying.
  const waiting = icloud && isWaitingICloudSync(operation);
  const retrying = !waiting && isRetryingMediaOperation(operation);
  // A physical deduplication job is titled by what it is and names its plan, which reads the same in
  // every language (FL-73).
  const dedup = operation.kind === MediaOperationKind.PhysicalDeduplication;
  const dedupPlan = dedup ? asPlanName(operation.settings?.planId) : null;
  // FL-74: a preservation job copies and checks files; "Rendering" would say something untrue.
  const workingKey: Translations =
    isPreservationKind(operation.kind) && BULK_WORKING.has(status)
      ? 'frameleaf_activity_bulk_running'
      : `frameleaf_activity_status_${status}`;

  return {
    id: `job:${operation.id}`,
    source: 'job',
    operationId: operation.id,
    kindKey: `frameleaf_activity_kind_${operation.kind}`,
    statusKey: pause.pausePending
      ? 'frameleaf_activity_status_pausing'
      : waiting
        ? 'frameleaf_activity_status_waiting'
        : retrying
          ? 'frameleaf_activity_status_retrying'
          : icloud && ICLOUD_WORKING.has(status)
            ? 'frameleaf_activity_icloud_syncing'
            : workingKey,
    tone: retrying || pause.pausePending ? 'warning' : STATUS_TONE[status],
    title: operation.label,
    ...(dedup && { titleKey: 'frameleaf_activity_title_physical_deduplication' }),
    // A job about a Locked item a locked session may not see comes without its file name (FL-43).
    ...(operation.withheld && { titleKey: 'frameleaf_activity_title_locked_item', withheld: true }),
    progress: status === MediaOperationStatus.Completed ? 100 : counted ? clampPercent(operation.progress) : null,
    running,
    ...pause,
    done: asCount(operation.processedUnits),
    total: asCount(operation.totalUnits) || null,
    finished,
    failed,
    destinationKey: DESTINATION_KEY[operation.destination],
    details: dedup ? (dedupPlan ? [dedupPlan] : []) : activitySettingsDetails(operation.settings),
    error: operation.error ?? undefined,
    errorCode: operation.errorCode ?? undefined,
    startedAt: Date.parse(operation.startedAt ?? operation.createdAt),
    assetId: operation.resultAssetId ?? operation.assetId ?? undefined,
    // The server decides; these only mirror its rules so the buttons are not offered pointlessly.
    canCancel: running || pause.paused,
    // A Library Care scan or search is started again from Library Care, not copied (FL-69); a
    // deduplication plan is reviewed again on its page and applied as a new plan (FL-73).
    // A library scan is started again from Libraries, which checks its folders and owner first (FL-78).
    canRetry:
      operation.kind !== MediaOperationKind.MediaHealth &&
      operation.kind !== MediaOperationKind.LibraryScan &&
      !dedup &&
      (status === MediaOperationStatus.Failed || status === MediaOperationStatus.Cancelled),
    canDismiss: finished,
    browserLocal: false,
    ...(status === MediaOperationStatus.Completed && studioBundleOf(operation.kind)),
    ...(operation.projectId && STUDIO_RENDER_KINDS.has(operation.kind) && { projectId: operation.projectId }),
    ...estimateOf(operation),
  };
};

/** Renders of a Studio project, which Activity can open in Studio (FL-104, `Activity.jsx` Open in Studio). */
const STUDIO_RENDER_KINDS: ReadonlySet<MediaOperationKind> = new Set([
  MediaOperationKind.StudioExport,
  MediaOperationKind.StudioPreview,
]);

/** The server's measured estimate, when it sent one; nothing is invented when it did not. */
const estimateOf = (
  operation: Pick<MediaOperationDto, 'estimate'>,
): Pick<ActivityItem, 'estimateSeconds' | 'sizeBytes'> => {
  const seconds = operation.estimate?.seconds;
  const size = asCount(operation.estimate?.sizeBytes);
  return {
    ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && { estimateSeconds: seconds }),
    ...(size !== null && size > 0 && { sizeBytes: size }),
  };
};

/** The four preservation kinds (FL-74), which Activity lists beside every other job. */
const PRESERVATION_KINDS: ReadonlySet<MediaOperationKind> = new Set([
  MediaOperationKind.PreservationExport,
  MediaOperationKind.PreservationVerify,
  MediaOperationKind.PreservationReview,
  MediaOperationKind.PreservationRestore,
]);

const isPreservationKind = (kind: MediaOperationKind) => PRESERVATION_KINDS.has(kind);

/** A finished bundle job's follow-up (FL-91), or nothing for every other kind. */
const studioBundleOf = (kind: MediaOperationKind): Pick<ActivityItem, 'studioBundle'> => {
  if (kind === MediaOperationKind.StudioBundleExport) {
    return { studioBundle: 'export' };
  }
  if (kind === MediaOperationKind.StudioBundleImport) {
    return { studioBundle: 'import' };
  }
  return {};
};

/** Server statuses a bulk job passes through while the worker has it. */
const BULK_WORKING: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
]);

/**
 * One durable bulk job (FL-32) as a row.
 *
 * Titled by its action, which is what the person chose, and described by its counts. "Rendering"
 * means nothing for a favourite, so a working job reads as running. A job that finished with
 * failures inside it needs attention and offers Retry, which the server turns into a new job over
 * exactly the items that did not go through; so does one that stopped before reaching the end.
 */
/** Bulk actions only Library Care queues, with gates a copied retry would skip (FL-69). */
const LIBRARY_CARE_BULK_ACTIONS: ReadonlySet<MediaOperationBulkAction> = new Set([
  MediaOperationBulkAction.RelinkMissingMedia,
  MediaOperationBulkAction.RecoverDamagedMedia,
  MediaOperationBulkAction.TrashDamagedMedia,
]);

export const fromBulkMediaOperation = (operation: MediaOperationDto): ActivityItem => {
  const status = operation.status;
  const running = RUNNING_STATUSES.has(status);
  const pause = mediaOperationPauseState(operation);
  const bulk = operation.bulk;
  const requested = bulk?.requested ?? Number(operation.totalUnits ?? 0);
  const answered = bulk ? bulk.succeeded + bulk.failed + bulk.skipped : Number(operation.processedUnits ?? 0);
  const unfinished = !running && !pause.paused && answered < requested;
  const failed = status === MediaOperationStatus.Failed || (!running && (bulk?.failed ?? 0) > 0);
  const retrying = isRetryingMediaOperation(operation);

  return {
    id: `job:${operation.id}`,
    source: 'job',
    operationId: operation.id,
    kindKey: 'frameleaf_activity_kind_bulk',
    statusKey: pause.pausePending
      ? 'frameleaf_activity_status_pausing'
      : retrying
        ? 'frameleaf_activity_status_retrying'
        : BULK_WORKING.has(status)
          ? 'frameleaf_activity_bulk_running'
          : `frameleaf_activity_status_${status}`,
    tone: failed ? 'danger' : retrying || pause.pausePending ? 'warning' : STATUS_TONE[status],
    title: operation.label,
    ...(bulk && { titleKey: bulkActionTitleKey(bulk.action) }),
    progress:
      status === MediaOperationStatus.Completed
        ? 100
        : requested > 0 && (running || answered > 0)
          ? clampPercent((answered / requested) * 100)
          : null,
    running,
    ...pause,
    // Items answered of items requested: the count a person reads as "120 of 400".
    done: requested > 0 ? Math.min(answered, requested) : null,
    total: requested > 0 ? requested : null,
    finished: !running && !pause.paused,
    failed,
    // Bulk work runs on this server; the destination adds nothing a person needs to read.
    details: [],
    error: operation.error ?? undefined,
    errorCode: operation.errorCode ?? undefined,
    startedAt: Date.parse(operation.startedAt ?? operation.createdAt),
    canCancel: (running && status !== MediaOperationStatus.Cancelling) || pause.paused,
    // Library Care relinks, recoveries and trash are reviewed again in Library Care (FL-69).
    canRetry:
      !LIBRARY_CARE_BULK_ACTIONS.has(bulk?.action as MediaOperationBulkAction) &&
      !running &&
      !pause.paused &&
      (failed || unfinished || status === MediaOperationStatus.Cancelled),
    canDismiss: !running && !pause.paused,
    browserLocal: false,
    ...(bulk && {
      bulk: {
        requested,
        succeeded: bulk.succeeded,
        failed: bulk.failed,
        skipped: bulk.skipped,
        // Failed items get one automatic retry before they count as failed (FL-104).
        retried: bulk.retried ?? 0,
      },
    }),
  };
};

const UPLOAD_TONE: Record<UploadState, ActivityTone> = {
  [UploadState.PENDING]: 'neutral',
  [UploadState.STARTED]: 'info',
  [UploadState.DONE]: 'success',
  [UploadState.ERROR]: 'danger',
  [UploadState.DUPLICATED]: 'warning',
};

/** `UploadState` is a numeric enum, so the i18n key comes from a name map, not the value. */
const UPLOAD_STATUS_KEY: Record<UploadState, Translations> = {
  [UploadState.PENDING]: 'frameleaf_activity_upload_pending',
  [UploadState.STARTED]: 'frameleaf_activity_upload_started',
  [UploadState.DONE]: 'frameleaf_activity_upload_done',
  [UploadState.ERROR]: 'frameleaf_activity_upload_error',
  [UploadState.DUPLICATED]: 'frameleaf_activity_upload_duplicated',
};

/**
 * An upload this tab is running.
 *
 * Marked `browserLocal` so the page can say plainly that leaving the page stops it — unlike a
 * render, which does not care whether anybody is watching.
 */
export const fromUpload = (upload: UploadAsset): ActivityItem => {
  const state = upload.state ?? UploadState.PENDING;
  const running = state === UploadState.PENDING || state === UploadState.STARTED;

  return {
    id: `upload:${upload.id}`,
    source: 'upload',
    kindKey: 'frameleaf_activity_kind_upload',
    statusKey: UPLOAD_STATUS_KEY[state] ?? 'frameleaf_activity_upload_pending',
    tone: UPLOAD_TONE[state] ?? 'neutral',
    title: upload.file?.name ?? upload.id,
    progress: running ? clampPercent(upload.progress ?? 0) : state === UploadState.DONE ? 100 : null,
    running,
    paused: false,
    pausePending: false,
    canPause: false,
    canResume: false,
    done: null,
    total: null,
    finished: !running,
    failed: state === UploadState.ERROR,
    details: [],
    // The manager stores an arbitrary thrown value; only a message is fit to show.
    error: upload.message ?? (typeof upload.error === 'string' ? upload.error : undefined),
    startedAt: upload.startDate ?? 0,
    assetId: upload.assetId ?? undefined,
    canCancel: false,
    canRetry: false,
    canDismiss: false,
    browserLocal: true,
  };
};

const DOWNLOAD_STATUS_KEY: Record<DownloadState['status'], Translations> = {
  preparing: 'frameleaf_activity_download_running',
  ready: 'frameleaf_activity_download_done',
  error: 'frameleaf_activity_download_failed',
};

const DOWNLOAD_TONE: Record<DownloadState['status'], ActivityTone> = {
  preparing: 'info',
  ready: 'success',
  error: 'danger',
};

/** A file this tab is receiving from the server (FL-45), or has received and not yet saved. */
export const fromDownload = (key: string, download: DownloadState): ActivityItem => ({
  id: `download:${key}`,
  source: 'download',
  kindKey: 'frameleaf_activity_kind_download',
  statusKey: DOWNLOAD_STATUS_KEY[download.status],
  tone: DOWNLOAD_TONE[download.status],
  title: download.archiveName || key,
  progress: download.status === 'error' ? null : clampPercent(download.progress),
  running: download.status === 'preparing',
  paused: false,
  pausePending: false,
  canPause: false,
  canResume: false,
  done: null,
  total: null,
  finished: download.status !== 'preparing',
  failed: download.status === 'error',
  details: [],
  startedAt: 0,
  canCancel: false,
  canRetry: false,
  canDismiss: false,
  browserLocal: true,
});

const BULK_TONE: Record<BulkOperationRecord['status'], ActivityTone> = {
  resolving: 'neutral',
  running: 'info',
  completed: 'success',
  cancelled: 'neutral',
  failed: 'danger',
};

/**
 * One of FL-32's background bulk operations.
 *
 * A completed operation with failures inside it counts as needing attention: reporting "done" for
 * a run where a hundred items failed would be the dishonest answer.
 */
export const fromBulkOperation = (operation: BulkOperationRecord): ActivityItem => {
  const running = operation.status === 'resolving' || operation.status === 'running';

  return {
    id: `bulk:${operation.requestId}`,
    source: 'bulk',
    kindKey: 'frameleaf_activity_kind_bulk',
    statusKey: `frameleaf_activity_bulk_${operation.status}`,
    tone: BULK_TONE[operation.status],
    // A bulk operation has no name of its own; the action it performs is what identifies it.
    title: operation.requestId,
    titleKey: bulkActionTitleKey(operation.action),
    progress:
      operation.total && operation.total > 0 ? clampPercent((operation.processed / operation.total) * 100) : null,
    running,
    paused: false,
    pausePending: false,
    canPause: false,
    canResume: false,
    done: operation.total && operation.total > 0 ? operation.processed : null,
    total: operation.total && operation.total > 0 ? operation.total : null,
    finished: !running,
    failed: operation.status === 'failed' || operation.failed > 0,
    details: [],
    startedAt: operation.startedAt,
    canCancel: running,
    canRetry: false,
    canDismiss: !running,
    browserLocal: false,
  };
};

/**
 * Everything, newest first.
 *
 * Running work sorts above finished work regardless of age, because a page whose first row is a
 * render that finished yesterday is not showing you what is happening now.
 */
export const buildActivityList = (sources: {
  operations?: MediaOperationDto[];
  uploads?: UploadAsset[];
  downloads?: [string, DownloadState][];
  bulk?: BulkOperationRecord[];
}): ActivityItem[] => {
  const items = [
    ...(sources.operations ?? []).map((operation) => fromMediaOperation(operation)),
    ...(sources.uploads ?? []).map((upload) => fromUpload(upload)),
    ...(sources.downloads ?? []).map(([key, download]) => fromDownload(key, download)),
    ...(sources.bulk ?? []).map((operation) => fromBulkOperation(operation)),
  ];

  // A paused job is unfinished too, so it stays up with the running ones (FL-104).
  return items.sort((a, b) => {
    if (a.finished !== b.finished) {
      return a.finished ? 1 : -1;
    }
    return b.startedAt - a.startedAt;
  });
};

export const matchesActivityFilter = (item: ActivityItem, filter: ActivityFilter): boolean => {
  switch (filter) {
    case 'all': {
      return true;
    }
    case 'running': {
      // Paused work is still in hand: it has not finished and it is not a failure (FL-104).
      return item.running || item.paused;
    }
    case 'done': {
      return item.finished && !item.failed;
    }
    case 'failed': {
      return item.failed;
    }
  }
};

export type ActivityCounts = Record<ActivityFilter, number>;

export const activityCounts = (items: readonly ActivityItem[]): ActivityCounts => ({
  all: items.length,
  running: items.filter((item) => matchesActivityFilter(item, 'running')).length,
  done: items.filter((item) => matchesActivityFilter(item, 'done')).length,
  failed: items.filter((item) => matchesActivityFilter(item, 'failed')).length,
});

/**
 * What the top-bar indicator reports.
 *
 * The average is over items that actually have a figure: mixing an unknown into an average as a
 * zero makes the whole thing read as stalled.
 */
export const activityIndicatorState = (items: readonly ActivityItem[]) => {
  const running = items.filter((item) => item.running);
  const measured = running.filter((item) => item.progress !== null);
  const progress =
    measured.length > 0
      ? clampPercent(measured.reduce((total, item) => total + (item.progress as number), 0) / measured.length)
      : null;

  return { count: running.length, progress };
};

/** Seconds left at the rate so far, or null when there is no honest estimate yet. */
export const activityEtaSeconds = (
  item: Pick<ActivityItem, 'progress' | 'startedAt' | 'running' | 'estimateSeconds'>,
  now: number,
): number | null => {
  // The server's own measurement wins over a guess from elapsed time.
  if (item.running && item.estimateSeconds !== undefined) {
    return item.estimateSeconds > 0 ? Math.ceil(item.estimateSeconds) : null;
  }
  const progress = item.progress;
  const elapsed = (now - item.startedAt) / 1000;
  if (!item.running || progress === null || progress <= 0 || progress >= 100 || item.startedAt <= 0 || elapsed <= 0) {
    return null;
  }
  return Math.ceil((elapsed * (100 - progress)) / progress);
};

/**
 * A row's status line (prototype `Activity.jsx` `statusText`): the state, then how far along it
 * is, then about how long is left while it runs; "Paused at N%" and "Cancelled at N%" where it
 * stopped; "Waiting for connection · N%" while the server cannot be reached. Nothing is estimated
 * without a measured percentage, and a failure's reason is added by the page, as given.
 */
export const activityStatusText = (
  item: Pick<
    ActivityItem,
    'statusKey' | 'progress' | 'startedAt' | 'running' | 'paused' | 'finished' | 'estimateSeconds' | 'sizeBytes'
  >,
  {
    translate,
    online = true,
    now = Date.now(),
    formatDuration,
    formatSize,
  }: {
    translate: (key: Translations, options?: { values?: Record<string, unknown> }) => string;
    online?: boolean;
    now?: number;
    /** "3 minutes", in the reader's language. */
    formatDuration: (seconds: number) => string;
    /** "12 MB", in the reader's language. */
    formatSize?: (bytes: number) => string;
  },
): string => {
  const status = translate(item.statusKey);
  const progress = item.progress === null ? null : Math.round(item.progress);
  if (item.finished) {
    if (item.statusKey === 'frameleaf_activity_status_completed' && item.sizeBytes && formatSize) {
      return translate('frameleaf_activity_status_done_size', { values: { status, size: formatSize(item.sizeBytes) } });
    }
    return item.statusKey === 'frameleaf_activity_status_cancelled' && progress !== null && progress < 100
      ? translate('frameleaf_activity_status_at', { values: { status, progress } })
      : status;
  }
  if (item.paused) {
    return progress === null ? status : translate('frameleaf_activity_status_at', { values: { status, progress } });
  }
  // Prototype: every unfinished job that is not paused waits for the connection, queued or running.
  if (!online) {
    return progress === null
      ? translate('frameleaf_activity_status_offline')
      : translate('frameleaf_activity_status_offline_progress', { values: { progress } });
  }
  if (progress === null) {
    return status;
  }
  const eta = activityEtaSeconds(item, now);
  return eta === null
    ? translate('frameleaf_activity_status_progress', { values: { status, progress } })
    : translate('frameleaf_activity_status_eta', { values: { status, progress, time: formatDuration(eta) } });
};

/** "about 3 minutes" style durations: seconds under a minute, minutes under an hour, then hours. */
export const formatActivityDuration = (seconds: number, locale?: string): string => {
  const [value, unit] =
    seconds < 60
      ? [Math.max(1, Math.ceil(seconds)), 'second']
      : seconds < 3600
        ? [Math.ceil(seconds / 60), 'minute']
        : [Math.round(seconds / 360) / 10, 'hour'];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
};

/**
 * What the page's live region says when a server job finishes on its own (`Activity.jsx`:
 * "Export of Lake trip finished." / "… failed."). Compares the previous statuses with the current
 * items; returns null when nothing finished since, and the first finished job otherwise.
 */
export const activityCompletion = (
  previous: ReadonlyMap<string, Translations>,
  items: readonly Pick<ActivityItem, 'id' | 'source' | 'statusKey' | 'finished' | 'failed'>[],
): { id: string; outcome: 'finished' | 'failed' } | null => {
  for (const item of items) {
    const before = previous.get(item.id);
    if (item.source !== 'job' || !item.finished || before === undefined || before === item.statusKey) {
      continue;
    }
    if (item.statusKey === 'frameleaf_activity_status_completed') {
      return { id: item.id, outcome: 'finished' };
    }
    if (item.failed) {
      return { id: item.id, outcome: 'failed' };
    }
  }
  return null;
};
