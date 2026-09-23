import {
  MemoryExportStatus,
  type QueueName,
  type MemoryExportResponseDto,
  type QueueRunDto,
  type RunningJobsResponseDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { fromMediaOperation, type ActivityTone } from '$lib/frameleaf/activity';
import { Route } from '$lib/route';

/**
 * The running-jobs section of the notifications panel (FL-104, owner request September 23, 2026;
 * FL-72 for the server queues).
 *
 * One summary from the server becomes one list of rows, each with a progress bar and a pause/play
 * control. Three sources:
 *
 * - **Media operations** the viewer owns: bulk changes, restorations, Studio renders and bundles.
 *   Their status, progress and pause rules come from Activity's own view model, so the panel and
 *   the Activity page can never disagree about a job.
 * - **Highlight exports** the viewer owns. They run in one go on the background queue and cannot
 *   pause; the control is shown disabled with the reason.
 * - **Server queues**, for administrators only — the server sends none to anybody else. Thumbnail
 *   generation, metadata extraction, face detection and the rest, with the progress of their
 *   current run. A queue's total grows while it runs; the bar is done ÷ total as the server counts
 *   it, and the server guarantees the total never shrinks within a run.
 *
 * Nothing here invents a number. A total the server does not know is an indeterminate bar.
 */

export type RunningJobSource = 'operation' | 'memoryExport' | 'queue';

/** What the row's pause/play control does, if anything. */
export type RunningJobControl =
  | { kind: 'pause' }
  | { kind: 'resume' }
  /** Shown, disabled, with the reason as its tooltip and description. */
  | { kind: 'unavailable'; reasonKey: Translations };

export type RunningJobRow = {
  /** Unique across sources. */
  id: string;
  source: RunningJobSource;
  /** The viewer's own words (a job label, a memory title), when the row has them. */
  title?: string;
  /** i18n key for a translated title, e.g. a bulk action's name. */
  titleKey?: Translations;
  /** For a queue row: the queue, whose title and icon come from the admin Jobs page's catalogue. */
  queueName?: QueueName;
  /** i18n key for the kind of work, shown under the title. */
  kindKey: Translations;
  /** i18n key for the state, shown as a chip as on the prototype's Activity rows. */
  statusKey: Translations;
  /** The chip's and the bar's tone: info while working, warning while paused or pausing. */
  tone: ActivityTone;
  /** Work is moving right now: the chip carries the prototype's pulsing dot. */
  live: boolean;
  /** Units done and in total, or null when the server does not count them yet. */
  done: number | null;
  total: number | null;
  /** 0–100, or null for an indeterminate bar. */
  percent: number | null;
  /** Held: the bar stops and reads as paused. */
  paused: boolean;
  /** Asked to pause, not there yet. */
  pausing: boolean;
  control: RunningJobControl;
  /** Where a click on the row goes: Activity for the viewer's jobs, the Jobs page for a queue. */
  href: string;
  /** The server job id, for pause and resume. */
  operationId?: string;
  /** For a queue row: what the server reported now, for the waiting/active line. */
  active?: number;
  waiting?: number;
  /** Sort key: newest first within a source. */
  startedAt: number;
};

const percentOf = (done: number | null, total: number | null): number | null => {
  if (done === null || total === null || total <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
};

const timeOf = (value: string | Date | null | undefined, fallback = 0) => {
  if (!value) {
    return fallback;
  }
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : fallback;
};

/** The viewer's own server job, read exactly as Activity reads it. */
export const operationRow = (operation: RunningJobsResponseDto['operations'][number]): RunningJobRow => {
  const item = fromMediaOperation(operation);
  const control: RunningJobControl = item.canResume
    ? { kind: 'resume' }
    : item.canPause
      ? { kind: 'pause' }
      : { kind: 'unavailable', reasonKey: item.pauseBlockedKey ?? 'frameleaf_running_pause_unavailable_kind' };

  return {
    id: `operation:${operation.id}`,
    source: 'operation',
    title: item.title,
    ...(item.titleKey && { titleKey: item.titleKey }),
    kindKey: item.kindKey,
    statusKey: item.statusKey,
    tone: item.tone,
    live: item.running && item.tone === 'info',
    done: item.done,
    total: item.total,
    percent: item.total === null ? item.progress : percentOf(item.done, item.total),
    paused: item.paused,
    pausing: item.pausePending,
    control,
    href: Route.activity({ filter: 'running' }),
    operationId: operation.id,
    startedAt: item.startedAt,
  };
};

const MEMORY_EXPORT_STATUS_KEY: Partial<Record<MemoryExportStatus, Translations>> = {
  [MemoryExportStatus.Pending]: 'frameleaf_activity_status_queued',
  [MemoryExportStatus.Running]: 'frameleaf_activity_bulk_running',
  [MemoryExportStatus.Cancelling]: 'frameleaf_activity_status_cancelling',
};

const MEMORY_EXPORT_TONE: Partial<Record<MemoryExportStatus, ActivityTone>> = {
  [MemoryExportStatus.Pending]: 'neutral',
  [MemoryExportStatus.Running]: 'info',
  [MemoryExportStatus.Cancelling]: 'warning',
};

/** One of the viewer's highlight exports still being written. */
export const memoryExportRow = (run: MemoryExportResponseDto): RunningJobRow => {
  const total = run.assetCount > 0 ? run.assetCount : null;
  const done = total === null ? null : Math.min(run.processedAssets, total);

  return {
    id: `memory-export:${run.id}`,
    source: 'memoryExport',
    title: run.title,
    kindKey: 'frameleaf_running_kind_memory_export',
    statusKey: MEMORY_EXPORT_STATUS_KEY[run.status] ?? 'frameleaf_activity_bulk_running',
    tone: MEMORY_EXPORT_TONE[run.status] ?? 'info',
    live: run.status === MemoryExportStatus.Running,
    done,
    total,
    percent: percentOf(done, total),
    paused: false,
    pausing: false,
    control: { kind: 'unavailable', reasonKey: 'frameleaf_running_pause_unavailable_export' },
    href: Route.viewMemory({ id: run.memoryId }),
    startedAt: timeOf(run.startedAt ?? run.createdAt),
  };
};

/** One server queue's current run. Administrators only; the server sends none to anybody else. */
export const queueRow = (queue: QueueRunDto): RunningJobRow => {
  // The server's own sum, but never less than what is visibly in hand right now.
  const total = Math.max(queue.total, queue.processed + queue.active + queue.waiting);
  const done = Math.min(queue.processed, total);

  return {
    id: `queue:${queue.name}`,
    source: 'queue',
    queueName: queue.name,
    kindKey: 'frameleaf_running_kind_queue',
    statusKey: queue.isPaused
      ? 'frameleaf_activity_status_paused'
      : queue.active > 0
        ? 'frameleaf_activity_bulk_running'
        : 'frameleaf_activity_status_queued',
    tone: queue.isPaused ? 'warning' : queue.active > 0 ? 'info' : 'neutral',
    live: !queue.isPaused && queue.active > 0,
    done: total > 0 ? done : null,
    total: total > 0 ? total : null,
    percent: percentOf(done, total),
    paused: queue.isPaused,
    pausing: false,
    control: queue.isPaused
      ? { kind: 'resume' }
      : queue.canPause
        ? { kind: 'pause' }
        : { kind: 'unavailable', reasonKey: 'frameleaf_running_pause_unavailable_queue' },
    href: Route.viewQueue({ name: queue.name }),
    active: queue.active,
    waiting: queue.waiting,
    startedAt: timeOf(queue.startedAt),
  };
};

/**
 * Every row, the viewer's own work first — it is what they came to look at — then the server's
 * queues. Newest first within each.
 */
export const buildRunningJobRows = (summary: RunningJobsResponseDto | null | undefined): RunningJobRow[] => {
  if (!summary) {
    return [];
  }

  const byNewest = (a: RunningJobRow, b: RunningJobRow) => b.startedAt - a.startedAt;
  const own = [
    ...summary.operations.map((operation) => operationRow(operation)),
    ...summary.memoryExports.map((run) => memoryExportRow(run)),
  ].sort(byNewest);
  // The server lists queues in their declared order, which is also the admin page's order.
  const queues = summary.canManageQueues ? summary.queues.map((queue) => queueRow(queue)) : [];

  return [...own, ...queues];
};

/**
 * How many rows are actually doing something. Paused work is not counted: the bell's running badge
 * should go quiet when everything is on hold.
 */
export const countActiveRunningJobs = (rows: readonly RunningJobRow[]) => rows.filter((row) => !row.paused).length;
