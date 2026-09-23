import type { BulkOperationRecord } from '$lib/frameleaf/library-session';
import type { DownloadState } from '$lib/managers/download-manager.svelte';
import { UploadState, type UploadAsset } from '$lib/types';
import { MediaOperationDestination, MediaOperationStatus, type MediaOperationDto } from '@immich/sdk';

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
 * - **Bulk operations.** FL-32's session records, so a "select everything matching" job shows up
 *   next to everything else instead of only in the library's own strip.
 */

/** Where an item came from. Decides which actions it can offer. */
export type ActivitySource = 'job' | 'upload' | 'download' | 'bulk';

/** How the row reads. Colour never carries meaning on its own; the status key does. */
export type ActivityTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export type ActivityFilter = 'all' | 'running' | 'done' | 'failed';

export const ACTIVITY_FILTERS: readonly ActivityFilter[] = ['all', 'running', 'done', 'failed'];

/** Server statuses where the job is still the server's problem. */
const RUNNING_STATUSES: readonly MediaOperationStatus[] = [
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
];

const STATUS_TONE: Record<MediaOperationStatus, ActivityTone> = {
  [MediaOperationStatus.Queued]: 'neutral',
  [MediaOperationStatus.Preparing]: 'info',
  [MediaOperationStatus.Rendering]: 'info',
  [MediaOperationStatus.Validating]: 'info',
  [MediaOperationStatus.Cancelling]: 'warning',
  [MediaOperationStatus.Completed]: 'success',
  [MediaOperationStatus.Cancelled]: 'neutral',
  [MediaOperationStatus.Failed]: 'danger',
};

export type ActivityItem = {
  /** Unique across every source; server ids are prefixed so they cannot collide with a filename. */
  id: string;
  source: ActivitySource;
  /** The server job id, when there is one. What cancel, retry and dismiss act on. */
  operationId?: string;
  /** i18n key for the kind of work, e.g. `frameleaf_activity_kind_studio_export`. */
  kindKey: string;
  /** i18n key for the state, e.g. `frameleaf_activity_status_rendering`. */
  statusKey: string;
  tone: ActivityTone;
  /** What the person recognises: a project name, a filename, an archive name. */
  title: string;
  /** Used instead of `title` when the name is a translated label rather than the user's own text. */
  titleKey?: string;
  /** Percent complete, or null when the total is not known and a bar would be a guess. */
  progress: number | null;
  /** Still working. Drives the indicator's count and the presence of Cancel. */
  running: boolean;
  /** Finished one way or another. */
  finished: boolean;
  /** Finished badly, or finished with failures inside it. */
  failed: boolean;
  /** i18n key for where the work runs; absent for browser-local transfers. */
  destinationKey?: string;
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
};

const DESTINATION_KEY: Record<MediaOperationDestination, string> = {
  [MediaOperationDestination.Local]: 'frameleaf_activity_destination_local',
  [MediaOperationDestination.Lan]: 'frameleaf_activity_destination_lan',
  [MediaOperationDestination.RunPod]: 'frameleaf_activity_destination_runpod',
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
 * One durable server job as a row.
 *
 * `progress` is null while the job is queued and nothing has been counted: an empty bar is honest
 * where a bar sitting at zero looks stalled.
 */
export const fromMediaOperation = (operation: MediaOperationDto): ActivityItem => {
  const status = operation.status;
  const running = RUNNING_STATUSES.includes(status);
  const finished = !running;
  const failed = status === MediaOperationStatus.Failed;
  const counted = Number(operation.totalUnits ?? 0) > 0 || operation.progress > 0;

  return {
    id: `job:${operation.id}`,
    source: 'job',
    operationId: operation.id,
    kindKey: `frameleaf_activity_kind_${operation.kind}`,
    statusKey: `frameleaf_activity_status_${status}`,
    tone: STATUS_TONE[status],
    title: operation.label,
    progress: status === MediaOperationStatus.Completed ? 100 : counted ? clampPercent(operation.progress) : null,
    running,
    finished,
    failed,
    destinationKey: DESTINATION_KEY[operation.destination],
    details: activitySettingsDetails(operation.settings),
    error: operation.error ?? undefined,
    errorCode: operation.errorCode ?? undefined,
    startedAt: Date.parse(operation.startedAt ?? operation.createdAt),
    assetId: operation.resultAssetId ?? operation.assetId ?? undefined,
    // The server decides; these only mirror its rules so the buttons are not offered pointlessly.
    canCancel: running,
    canRetry: status === MediaOperationStatus.Failed || status === MediaOperationStatus.Cancelled,
    canDismiss: finished,
    browserLocal: false,
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
const UPLOAD_STATUS_KEY: Record<UploadState, string> = {
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

/** An archive this tab asked the server to prepare and is still receiving. */
export const fromDownload = (key: string, download: DownloadState): ActivityItem => ({
  id: `download:${key}`,
  source: 'download',
  kindKey: 'frameleaf_activity_kind_download',
  statusKey: download.downloaded ? 'frameleaf_activity_download_done' : 'frameleaf_activity_download_running',
  tone: download.downloaded ? 'success' : 'info',
  title: download.archiveName || key,
  progress: download.downloaded ? 100 : null,
  running: !download.downloaded,
  finished: download.downloaded,
  failed: false,
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
    titleKey: `frameleaf_bulk_${operation.action.replaceAll('-', '_')}`,
    progress: operation.total && operation.total > 0 ? clampPercent((operation.processed / operation.total) * 100) : null,
    running,
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

  return items.sort((a, b) => {
    if (a.running !== b.running) {
      return a.running ? -1 : 1;
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
      return item.running;
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
