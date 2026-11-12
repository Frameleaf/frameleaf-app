import { QueueName, type DurableJobRun, type DurableRunningJobs } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import { UPLOAD_ORIGINS } from '$lib/frameleaf/arrivals';
import { workEtaSeconds } from '$lib/frameleaf/background-work';
import { isRunSettled } from '$lib/frameleaf/durable-runs';
import { runHeadline, type Headline } from '$lib/frameleaf/run-headline';

/**
 * FL-1409 (M5): the progress line for any large import, not only the first-run one (`SetupBar.svelte`).
 *
 * What the server reports, and so what the line can say:
 *
 * - The thumbnails queue counts how many photos it has made ready and how many wait, whatever brought them in: an
 *   external-library scan, a large upload, a phone backup. That is "N of M ready", and its pace gives the time left.
 * - An external-library scan has a run (`library_scan`) with a state, the queues it waits on and the libraries it
 *   can't reach. When the photos are not getting ready, the line says why in the run's own words (`runHeadline`,
 *   as its Recent work card does) and offers the card's Resume or Release.
 * - FL-1459: a large upload is a run too, with the phone, computer or app it came from (`origin`, `label`), so the
 *   line names it ("Adding photos from Pixel 8"). A scan's run names its library.
 *
 * Queues and runs are sent to administrators only: nobody else gets a line.
 */

/** Fewer photos than this get ready before a line would be worth reading. */
export const LARGE_IMPORT = 500;

export type ImportProgress = {
  /** An external-library scan is behind it: its library's name when known, else null. Absent for other imports. */
  scan?: { name: string | null };
  /** FL-1459: a large upload is behind it: its phone's, computer's or app's name when it gave one. */
  upload?: { name: string | null };
  /** Photos made ready of those that came in, while the thumbnails queue counts them. */
  ready?: { done: number; total: number };
  /** A scan still reading its folder with nothing waiting for a thumbnail: photos found so far. */
  found?: number;
  /**
   * The photos are not getting ready, and why: Recent work's state and reason for the scan's run, or the paused
   * thumbnails queue. `queues` are what Resume resumes; `run` is what Release releases.
   */
  stopped?: Pick<Headline, 'status' | 'why' | 'values' | 'action'> & { queues: QueueName[]; run?: DurableJobRun };
  /** Quiet hours saved it for the night, and when it starts again (no run to say so in its own words). */
  tonight?: { startsAt: string | null };
  /** About how long is left at the pace so far; null when it isn't moving or nothing has finished yet. */
  etaSeconds: number | null;
};

/** The run states in which a scan's photos are not getting ready. Plain strings, as `STUCK_HEADLINES` is. */
const HOLDING: ReadonlySet<string> = new Set([
  'frameleaf_job_runs_state_paused',
  'frameleaf_job_runs_status_waiting_drive',
  'frameleaf_job_runs_state_waiting',
  'frameleaf_job_runs_status_waiting_setup',
  'frameleaf_job_runs_state_delayed',
  // FL-1457: work that can't go on by itself (another step it waits for, a worker that is gone), as Activity says.
  'frameleaf_job_runs_state_blocked',
  'frameleaf_job_runs_state_unavailable',
] satisfies Translations[]);

export const importProgress = (
  summary: DurableRunningJobs | null | undefined,
  now: number = Date.now(),
): ImportProgress | null => {
  if (!summary) {
    return null;
  }
  const queue = summary.canManageQueues
    ? summary.queues.find((row) => row.name === QueueName.ThumbnailGeneration && !row.unavailable)
    : undefined;
  const run = summary.canReadJobRuns
    ? (summary.durableRuns ?? []).find(
        (candidate) => candidate.kind === 'library_scan' && !isRunSettled(candidate) && candidate.total >= LARGE_IMPORT,
      )
    : undefined;
  // The thumbnails queue counts every upload's photos: a device is named only when its upload is the one under way
  const uploads = summary.canReadJobRuns
    ? (summary.durableRuns ?? []).filter(
        (candidate) =>
          !!candidate.origin &&
          UPLOAD_ORIGINS.has(candidate.origin) &&
          !isRunSettled(candidate) &&
          (candidate.itemCount ?? candidate.total) >= LARGE_IMPORT,
      )
    : [];
  const upload = uploads.length === 1 ? uploads[0] : undefined;
  const total = queue ? Math.max(queue.total, queue.processed + queue.active + queue.waiting) : 0;
  const counted = !!queue && total >= LARGE_IMPORT;
  // Thumbnails done and the scan's folder read: what is left (search, faces) is Activity's to show.
  if (!counted && (!run || run.enumerationDone)) {
    return null;
  }

  const scan = run && {
    name: run.libraryName ?? summary.operations.find((operation) => operation.id === run.id)?.label ?? null,
  };
  const ready = counted && queue ? { done: Math.min(queue.processed, total), total } : undefined;
  const base: ImportProgress = {
    ...(scan && { scan }),
    ...(!scan && counted && upload && { upload: { name: upload.label ?? null } }),
    ...(ready ? { ready } : run && { found: run.total }),
    etaSeconds: null,
  };

  const held = !!queue?.heldForNight && !queue.isPaused;
  const headline = run ? runHeadline(run) : undefined;
  const holding = !!run && !!headline && HOLDING.has(headline.status);
  /*
   * FL-1457: moving by Activity's rule (`workEtaSeconds`): photos wait and nothing holds them. A poll that lands
   * between two thumbnail jobs (none active for a moment) keeps the time left instead of dropping it.
   */
  const moving =
    counted && !!queue && !queue.isPaused && !held && (queue.active > 0 || (queue.waiting > 0 && !holding));
  if (moving) {
    return { ...base, etaSeconds: workEtaSeconds({ ...summary, queues: [queue] }, now) };
  }
  if (run && headline && holding) {
    return {
      ...base,
      stopped: {
        status: headline.status,
        why: headline.why,
        values: headline.values,
        action: headline.action,
        queues: [...new Set(run.pausedQueues)],
        run,
      },
    };
  }
  if (queue?.isPaused) {
    return {
      ...base,
      stopped: {
        status: 'frameleaf_job_runs_state_paused',
        why: 'frameleaf_job_runs_why_paused',
        action: queue.canPause ? 'resume' : null,
        queues: [queue.name],
      },
    };
  }
  return held ? { ...base, tonight: { startsAt: queue?.resumesAt ?? null } } : base;
};
