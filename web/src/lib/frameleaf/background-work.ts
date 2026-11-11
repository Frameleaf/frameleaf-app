import {
  QueueName,
  type DurableJobRun,
  type DurableJobState,
  type DurableQueueRun,
  type DurableRunningJobs,
} from '@frameleaf/sdk';
import type { MessageFormatter, Translations } from 'svelte-i18n';
import { ACTIVITY_STAGE_KEYS } from '$lib/frameleaf/activity';
import { isImportRunKind, isRunSettled, runStateKey, settledItems } from '$lib/frameleaf/durable-runs';
import { JOB_QUEUES } from '$lib/frameleaf/job-queues';
import { leftOver } from '$lib/frameleaf/run-failures';
import { runHeadline } from '$lib/frameleaf/run-headline';
import { WORK_FEATURES, type WorkFeature } from '$lib/frameleaf/work-features';

/**
 * Activity's "Background work" cards (SHARING-P1; prototype Activity.jsx `BackgroundRow` and
 * activity-feed.mjs `summariseBackgroundQueues`).
 *
 * One card per kind of work the server is busy with: Thumbnails, Metadata, Face detection, Search
 * indexing… Each says only what a household needs: whether it is waiting (for tonight, when quiet hours
 * save it for the overnight window), running or paused, how many
 * items are waiting and running, and how far the running work has got. Stage totals, prerequisites,
 * destinations and run ids stay on the Background work settings page, which every card opens.
 *
 * The server sends queues and durable runs to administrators only, so everybody else gets no cards.
 * A queue and an unfinished durable run of the same kind make one card. Idle kinds make none.
 */

export type BackgroundWorkStage = 'queued' | 'running' | 'paused';

export type BackgroundWorkCard = {
  id: string;
  queueName: QueueName;
  stage: BackgroundWorkStage;
  /**
   * What the card says. Work that is not running says why when the server knows (waiting for another
   * step, scheduled, retrying, no worker) rather than reading as freshly queued.
   */
  statusKey: Translations;
  /** Nothing will move until somebody or something else acts: a missing worker or a failed step. */
  stuck: boolean;
  /** The server state a queue's card says instead of its stage, if any. A run's card says its headline. */
  reason: DurableJobState | null;
  /**
   * FL-1409: a run's one reason, as its Recent work card gives it ("The external library “Family archive” can’t be
   * reached…"), for a row that shows the run by itself.
   */
  why?: { key: Translations; values?: Record<string, string | number> };
  /** Items waiting their turn, including paused and scheduled ones. */
  waiting: number;
  /** Items being worked on now. */
  running: number;
  /** 0–100 while running, when the server counts a total; otherwise null. */
  progress: number | null;
  /** Items finished and in all, when the server counts them; null when it does not. */
  done: number | null;
  total: number | null;
  /**
   * FL-711: quiet hours saved this work for the overnight window, and when it starts again by itself
   * (null when the schedule never starts). Absent for work nothing is holding back for the night.
   */
  tonight?: { startsAt: string | null };
};

/** Starts before this hour of the morning after still belong to tonight. */
const OVERNIGHT_CUTOFF_HOUR = 12;

/**
 * FL-711: how to say when quiet hours start saved work again, judged by the viewer's local calendar
 * days (never a fixed 24 hours, which a daylight-saving day is not): `tonight` for a start later
 * today or before noon tomorrow, `day` for a start further off, `unscheduled` when there is none.
 */
export const tonightStart = (startsAt: string | null, now: Date = new Date()): 'tonight' | 'day' | 'unscheduled' => {
  const at = startsAt ? new Date(startsAt) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return 'unscheduled';
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  if (day.getTime() === today.getTime()) {
    return 'tonight';
  }
  return day.getTime() === tomorrow.getTime() && at.getHours() < OVERNIGHT_CUTOFF_HOUR ? 'tonight' : 'day';
};

/**
 * FL-711: work quiet hours saved for the overnight window starts again by itself, so it says when, never "Paused".
 * Tonight's start reads as a time; a start further off names its day as well.
 */
export const tonightLabel = (startsAt: string | null, $t: MessageFormatter, locale: string | undefined): string => {
  const when = tonightStart(startsAt);
  if (when === 'unscheduled' || !startsAt) {
    return $t('frameleaf_activity_bg_tonight_unscheduled');
  }
  const at = new Date(startsAt);
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at);
  if (when === 'tonight') {
    return $t('frameleaf_activity_bg_tonight', { values: { time } });
  }
  const day = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(at);
  return $t('frameleaf_activity_bg_tonight_day', { values: { day, time } });
};

/**
 * States that say more than "queued" about work nothing is running yet, most telling first. A queue the server
 * could not read is unavailable whatever its last counts said, running included: those counts may be stale.
 */
const WAITING_REASONS: ReadonlySet<DurableJobState> = new Set(['unavailable', 'blocked', 'retrying', 'delayed']);

const statusOf = (stage: BackgroundWorkStage, state: DurableJobState | null | undefined) => {
  const reason = state === 'unavailable' || (stage === 'queued' && state && WAITING_REASONS.has(state)) ? state : null;
  return {
    statusKey: reason ? runStateKey(reason) : ACTIVITY_STAGE_KEYS[stage],
    stuck: reason === 'blocked' || reason === 'unavailable',
    reason,
  };
};

const percent = (done: number, total: number) =>
  total > 0 ? Math.min(100, Math.max(0, Math.floor((done / total) * 100))) : null;

const fromQueue = (queue: DurableQueueRun): BackgroundWorkCard | null => {
  const running = queue.active;
  const waiting = queue.waiting;
  // A queue the server could not read has no counts to go on: it still shows, or Activity says nothing runs.
  if (running + waiting <= 0 && !queue.unavailable) {
    return null;
  }
  // Work quiet hours hold is waiting for tonight, not paused until someone starts it again (FL-711). FL-1265: quiet
  // hours no longer pause the queue, so a queue someone paused says paused even at night.
  const tonight = !!queue.heldForNight && !queue.isPaused;
  const paused = !tonight && (queue.isPaused || queue.state === 'paused');
  const stage: BackgroundWorkStage = paused ? 'paused' : running > 0 && !tonight ? 'running' : 'queued';
  const total = Math.max(queue.total, queue.processed + running + waiting);
  return {
    id: `queue:${queue.name}`,
    queueName: queue.name,
    stage,
    ...statusOf(stage, queue.unavailable ? 'unavailable' : queue.state),
    // The server could not read this queue: say so, not that its worker is missing.
    ...(queue.unavailable && { statusKey: 'frameleaf_activity_bg_unreadable' as Translations }),
    waiting,
    running,
    progress: stage === 'running' && !queue.unavailable ? percent(Math.min(queue.processed, total), total) : null,
    done: queue.unavailable ? null : Math.min(queue.processed, total),
    total: queue.unavailable ? null : total,
    ...(tonight && { tonight: { startsAt: queue.resumesAt ?? null } }),
  };
};

/**
 * FL-1177: an import's released work is on the cards of the queues it feeds (Thumbnails, Face detection…), so its own
 * card counts only the photos its first setup still holds back: waiting for the file check, or a paused setup.
 */
const fromImportRun = (run: DurableJobRun): BackgroundWorkCard | null => {
  const held = run.held ?? 0;
  if (held <= 0) {
    return null;
  }
  const stage: BackgroundWorkStage = run.state === 'paused' ? 'paused' : 'queued';
  return {
    id: `run:${run.id}`,
    queueName: run.kind as QueueName,
    stage,
    statusKey: stage === 'paused' ? ACTIVITY_STAGE_KEYS.paused : 'frameleaf_activity_bg_import_check',
    stuck: false,
    reason: null,
    waiting: held,
    running: 0,
    progress: null,
    done: null,
    total: null,
  };
};

/**
 * Headlines that say nothing moves until somebody or something else acts. A set of plain strings: a `Set` of the
 * translation keys' own type sends TypeScript 7's checker into a spin (the keys are a union of some 19,000).
 */
const STUCK_HEADLINES: ReadonlySet<string> = new Set([
  'frameleaf_job_runs_state_unavailable',
  'frameleaf_job_runs_state_blocked',
  'frameleaf_job_runs_status_waiting_drive',
] satisfies Translations[]);

/**
 * FL-1409: a run's card says what its Recent work card says. The state, its reason and whether it is stuck all come
 * from `runHeadline`, so Activity can't read "Running" while Recent work reads "Paused" or "Waiting for a drive".
 */
const fromRun = (run: DurableJobRun): BackgroundWorkCard | null => {
  if (isRunSettled(run)) {
    return null;
  }
  if (isImportRunKind(run.kind)) {
    return fromImportRun(run);
  }
  const running = run.active;
  const waiting = run.waiting + run.delayed + run.paused + run.blocked + run.retrying;
  if (running + waiting <= 0) {
    return null;
  }
  const headline = runHeadline(run);
  const stage: BackgroundWorkStage =
    headline.status === 'frameleaf_job_runs_state_paused'
      ? 'paused'
      : headline.status === 'frameleaf_job_runs_state_running'
        ? 'running'
        : 'queued';
  return {
    id: `run:${run.id}`,
    queueName: run.kind as QueueName,
    stage,
    statusKey: headline.status,
    stuck: STUCK_HEADLINES.has(headline.status),
    reason: null,
    ...(headline.why && { why: { key: headline.why, values: headline.values } }),
    waiting,
    running,
    progress: stage === 'running' && run.enumerationDone ? percent(settledItems(run), run.total) : null,
    done: run.enumerationDone ? settledItems(run) : null,
    total: run.enumerationDone ? run.total : null,
  };
};

const order = (name: QueueName) => {
  const index = JOB_QUEUES.findIndex((queue) => queue.name === name);
  return index === -1 ? JOB_QUEUES.length : index;
};

/**
 * The cards, in the Background work page's order of kinds. A busy queue speaks for its kind; a run
 * only adds a card for a kind whose queue is idle, so the same items are never counted twice.
 */
export const buildBackgroundWorkCards = (summary: DurableRunningJobs | null | undefined): BackgroundWorkCard[] => {
  if (!summary) {
    return [];
  }
  const queues = summary.canManageQueues ? summary.queues.map((queue) => fromQueue(queue)) : [];
  const runs = summary.canReadJobRuns ? (summary.durableRuns ?? []) : [];
  const runTotals = new Map<QueueName, { settled: number; total: number; enumerated: boolean }>();

  const byKind = new Map<QueueName, BackgroundWorkCard>();
  for (const card of queues) {
    if (card) {
      byKind.set(card.queueName, card);
    }
  }
  for (const run of runs) {
    const card = fromRun(run);
    if (!card) {
      continue;
    }
    const totals = runTotals.get(card.queueName) ?? { settled: 0, total: 0, enumerated: true };
    totals.settled += settledItems(run);
    totals.total += run.total;
    totals.enumerated &&= run.enumerationDone;
    runTotals.set(card.queueName, totals);
    const existing = byKind.get(card.queueName);
    if (!existing) {
      byKind.set(card.queueName, card);
    } else if (existing.id.startsWith('run:')) {
      // Two unfinished runs of one kind: one card with both runs' items.
      // Whatever order the runs arrive in: running, then paused, then queued.
      const stage: BackgroundWorkStage =
        existing.stage === 'running' || card.stage === 'running'
          ? 'running'
          : existing.stage === 'paused' || card.stage === 'paused'
            ? 'paused'
            : 'queued';
      // What the one card says: the headline of a run at the card's stage; of two waiting runs, the stuck one's.
      const lead =
        (stage === 'queued' && [existing, card].find((run) => run.stuck)) ||
        (existing.stage === stage ? existing : card);
      byKind.set(card.queueName, {
        ...existing,
        stage,
        statusKey: lead.statusKey,
        stuck: lead.stuck,
        why: lead.why,
        waiting: existing.waiting + card.waiting,
        running: existing.running + card.running,
        progress: stage === 'running' && totals.enumerated ? percent(totals.settled, totals.total) : null,
        done: totals.enumerated ? totals.settled : null,
        total: totals.enumerated ? totals.total : null,
      });
    }
  }
  return [...byKind.values()].sort((a, b) => order(a.queueName) - order(b.queueName));
};

/**
 * Activity's In progress, by feature (UI review 2026-11-10, A1; prototype `ActivityWorkV3.jsx` "By feature").
 *
 * People see the eight features of Settings › Background work ("Faces & identity"), never the server's own
 * kinds of work: each row adds up the cards of its feature's tasks. The prototype's other view, "By what came
 * in", is not built: the server keeps no record of what a batch came in as (FL-1388 says what is missing).
 */
export type WorkFeatureState = 'stuck' | 'running' | 'waiting' | 'tonight' | 'paused' | 'idle';

export type WorkFeatureRow = {
  feature: WorkFeature;
  /** The most telling state of its tasks: stuck, then running, waiting, saved for tonight, paused. */
  state: WorkFeatureState;
  /** What a stuck or waiting feature says when the server knows more than "waiting". */
  statusKey: Translations | null;
  /** Items finished and in all across its counted tasks; null when none is counted. */
  done: number | null;
  total: number | null;
  /** Items still running or waiting. */
  left: number;
  /** FL-711: when quiet hours start its saved work again (the earliest of its tasks). */
  tonight?: { startsAt: string | null };
};

const featureOfCard = (card: BackgroundWorkCard) =>
  WORK_FEATURES.find((feature) => feature.queues.includes(card.queueName));

/**
 * Work that is no feature's task: a run with no task of its own (FL-1177: a Manager import; a folder scan).
 * It keeps its own row and name under the features.
 */
export const otherWorkCards = (cards: readonly BackgroundWorkCard[]) => cards.filter((card) => !featureOfCard(card));

/** One row per feature, in the order people meet them; a feature with nothing to do is idle. */
export const buildWorkFeatureRows = (cards: readonly BackgroundWorkCard[]): WorkFeatureRow[] =>
  WORK_FEATURES.map((feature) => {
    const own = cards.filter((card) => featureOfCard(card)?.id === feature.id);
    if (own.length === 0) {
      return { feature, state: 'idle', statusKey: null, done: null, total: null, left: 0 };
    }
    const stuck = own.find((card) => card.stuck);
    const queued = own.filter((card) => card.stage === 'queued');
    const waiting = queued.filter((card) => !card.tonight);
    const state: WorkFeatureState = stuck
      ? 'stuck'
      : own.some((card) => card.stage === 'running')
        ? 'running'
        : waiting.length > 0
          ? 'waiting'
          : queued.length > 0
            ? 'tonight'
            : 'paused';
    // A waiting task that says more than "queued": retrying, scheduled, waiting for another step.
    const says =
      stuck ??
      (state === 'waiting' ? waiting.find((card) => card.statusKey !== ACTIVITY_STAGE_KEYS.queued) : undefined);
    const counted = own.filter((card) => card.total !== null);
    const starts = queued.flatMap((card) => (card.tonight?.startsAt ? [card.tonight.startsAt] : [])).sort();
    return {
      feature,
      state,
      statusKey: says?.statusKey ?? null,
      done: counted.length > 0 ? counted.reduce((sum, card) => sum + (card.done ?? 0), 0) : null,
      total: counted.length > 0 ? counted.reduce((sum, card) => sum + (card.total ?? 0), 0) : null,
      left: own.reduce((sum, card) => sum + card.waiting + card.running, 0),
      ...(state === 'tonight' && { tonight: { startsAt: starts[0] ?? null } }),
    };
  });

const FACE_QUEUES: ReadonlySet<QueueName> = new Set([QueueName.FaceDetection, QueueName.FacialRecognition]);

/**
 * FL-1408: where face recognition itself stands, for People's "nobody found yet" page, read from the
 * queue state Activity and Background work show, so People never says "working" while they say
 * "Paused". Pets share the "Faces & identity" feature and are left out. Idle when its queues are, and
 * for anyone the server sends no queues to.
 */
export const faceRecognitionWork = (summary: DurableRunningJobs | null | undefined): WorkFeatureRow | undefined =>
  buildWorkFeatureRows(buildBackgroundWorkCards(summary).filter((card) => FACE_QUEUES.has(card.queueName))).find(
    (row) => row.feature.id === 'faces',
  );

/**
 * FL-1409: finished work that left photos over, as Recent work shows it ("312 photos need a look"). Activity drops
 * settled runs from its rows, so without these it would say "Everything is up to date" beside that card. The nightly
 * schedule's work comes back every night with the same photos: only its newest run counts, as Recent work folds it.
 */
export const leftOverRuns = (summary: DurableRunningJobs | null | undefined): DurableJobRun[] => {
  const runs = summary?.canReadJobRuns ? (summary.durableRuns ?? []) : [];
  const newestNightly = runs.find((run) => run.nightly);
  return runs.filter((run) => isRunSettled(run) && leftOver(run) > 0 && (!run.nightly || run.id === newestNightly?.id));
};

/** What Activity's first line says, most urgent first (prototype `summaryFor`). */
export type ActivityWorkStatus = 'paused' | 'attention' | 'working' | 'unread' | 'tonight' | 'jobs' | 'idle';

export const activityWorkStatus = ({
  rows,
  needsLook,
  jobs,
}: {
  rows: readonly WorkFeatureRow[];
  /** Jobs that failed. */
  needsLook: number;
  /** The viewer's own jobs in progress, and cloud backups or restores. */
  jobs: number;
}): ActivityWorkStatus => {
  const busy = rows.filter((row) => row.state !== 'idle');
  if (busy.length > 0 && busy.every((row) => row.state === 'paused')) {
    return 'paused';
  }
  if (needsLook > 0) {
    return 'attention';
  }
  const moving = busy.filter((row) => row.state !== 'paused' && row.state !== 'tonight');
  if (moving.some((row) => row.left > 0)) {
    return 'working';
  }
  // Only work whose counts the server could not read: never "up to date", and never "0 items".
  if (moving.length > 0) {
    return 'unread';
  }
  if (busy.some((row) => row.state === 'tonight')) {
    return 'tonight';
  }
  return jobs > 0 ? 'jobs' : 'idle';
};

/**
 * About how long the moving work will take, at the pace each task has kept since it started. Tasks run side by
 * side, so the slowest one is the answer. Null when a moving task has not finished an item yet (a guess is not
 * an estimate); paused work and work saved for tonight is not moving and is left out.
 */
export const workEtaSeconds = (summary: DurableRunningJobs | null | undefined, now: number = Date.now()) => {
  const moving = (summary?.canManageQueues ? summary.queues : []).filter(
    (queue) => !queue.unavailable && !queue.isPaused && !queue.heldForNight && queue.active + queue.waiting > 0,
  );
  let slowest = 0;
  for (const queue of moving) {
    const elapsed = (now - (queue.startedAt ? Date.parse(queue.startedAt) : NaN)) / 1000;
    if (!(queue.processed > 0) || !(elapsed > 0)) {
      return null;
    }
    slowest = Math.max(slowest, (elapsed * (queue.active + queue.waiting)) / queue.processed);
  }
  return moving.length > 0 ? Math.ceil(slowest) : null;
};
