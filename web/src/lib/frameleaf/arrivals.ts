import type { DurableJobCounts, DurableJobRun, DurableRunningJobs, QueueName } from '@frameleaf/sdk';
import type { MessageFormatter, Translations } from 'svelte-i18n';
import { isRunSettled } from '$lib/frameleaf/durable-runs';
import { runHeadline, type Headline } from '$lib/frameleaf/run-headline';
import { featureOfQueue, WORK_FEATURES, type WorkFeature } from '$lib/frameleaf/work-features';

/**
 * FL-1459: Activity's In progress, "By what came in" (prototype `ActivityWorkV3.jsx`, work-v3.mjs `BATCHES`).
 *
 * One card for each run the server says brought photos in (`origin`): a phone's or computer's uploads (one run per
 * device per burst), an app's, a shared link's, a folder scan or an import. Each says what came in, from where and
 * when, its state in Recent work's words (`runHeadline`), and how far each feature has got with it.
 */

/** Origins of photos sent up by a device or app. Their work is on the queues' own rows in "By feature". */
export const UPLOAD_ORIGINS: ReadonlySet<string> = new Set(['phone', 'computer', 'client', 'link']);

export type ArrivalStepState = 'done' | 'running' | 'waiting' | 'tonight' | 'paused' | 'failed';

export type ArrivalStep = {
  feature: WorkFeature;
  state: ArrivalStepState;
  /** Tasks finished (failed ones included) and in all: tasks, not photos (Faces counts each face). */
  done: number;
  total: number;
  failed: number;
};

export type Arrival = {
  run: DurableJobRun;
  origin: string;
  /** The phone, computer, app or library by its own name; null when it gave none. */
  name: string | null;
  ownerName: string | null;
  ownerId: string | null;
  /** Photos and videos that came in. */
  count: number;
  headline: Headline;
  steps: ArrivalStep[];
};

const stepState = (counts: DurableJobCounts): ArrivalStepState => {
  if (counts.active + counts.retrying > 0) {
    return 'running';
  }
  // Waiting on an earlier step (blocked) is up next too
  if (counts.waiting + counts.blocked > 0) {
    return 'waiting';
  }
  if (counts.delayed > 0) {
    return 'tonight';
  }
  if (counts.paused > 0) {
    return 'paused';
  }
  return counts.failed + counts.needsAttention > 0 ? 'failed' : 'done';
};

const sum = (a: DurableJobCounts, b: DurableJobCounts): DurableJobCounts => ({
  total: a.total + b.total,
  completed: a.completed + b.completed,
  failed: a.failed + b.failed,
  needsAttention: a.needsAttention + b.needsAttention,
  cancelled: a.cancelled + b.cancelled,
  active: a.active + b.active,
  retrying: a.retrying + b.retrying,
  delayed: a.delayed + b.delayed,
  paused: a.paused + b.paused,
  waiting: a.waiting + b.waiting,
  blocked: a.blocked + b.blocked,
});

/** A run's steps by feature, in the order people meet the features. */
export const arrivalSteps = (steps: ReadonlyArray<DurableJobCounts & { queue: QueueName }>): ArrivalStep[] => {
  const byFeature = new Map<string, DurableJobCounts>();
  for (const { queue, ...counts } of steps) {
    const id = featureOfQueue(queue)?.id;
    if (id) {
      const before = byFeature.get(id);
      byFeature.set(id, before ? sum(before, counts) : counts);
    }
  }
  return WORK_FEATURES.flatMap((feature) => {
    const counts = byFeature.get(feature.id);
    if (!counts || counts.total === 0) {
      return [];
    }
    const failed = counts.failed + counts.needsAttention;
    return [
      {
        feature,
        state: stepState(counts),
        done: counts.completed + failed + counts.cancelled,
        total: counts.total,
        failed,
      },
    ];
  });
};

/** "1,240 photos from Pixel 8"; one with no name says what it was. */
export const arrivalTitle = (
  { origin, name, count }: Pick<Arrival, 'origin' | 'name' | 'count'>,
  $t: MessageFormatter,
): string => {
  if (name) {
    return $t('frameleaf_activity_arrival_from', { values: { count, name } });
  }
  const key: Translations =
    origin === 'link'
      ? 'frameleaf_activity_arrival_from_link'
      : origin === 'library'
        ? 'frameleaf_activity_arrival_scan'
        : origin === 'import'
          ? 'frameleaf_activity_arrival_imported'
          : 'frameleaf_activity_arrival_uploaded';
  return $t(key, { values: { count } });
};

/** An upload's run by what came in, for Recent work's card; null for other work, which keeps its own title. */
export const uploadRunTitle = (run: DurableJobRun, $t: MessageFormatter): string | null =>
  run.origin && UPLOAD_ORIGINS.has(run.origin)
    ? arrivalTitle({ origin: run.origin, name: run.label ?? null, count: run.itemCount ?? run.total }, $t)
    : null;

/** What came in and is not finished yet, newest first. Sent to administrators only, as every run is. */
export const buildArrivals = (summary: DurableRunningJobs | null | undefined): Arrival[] => {
  const runs = summary?.canReadJobRuns ? (summary.durableRuns ?? []) : [];
  return runs
    .filter((run) => !!run.origin && !isRunSettled(run))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((run) => ({
      run,
      origin: run.origin!,
      name: run.label ?? (run.origin === 'library' ? (run.libraryName ?? null) : null),
      ownerName: run.ownerName ?? null,
      ownerId: run.ownerId ?? null,
      count: run.itemCount ?? run.total,
      headline: runHeadline(run),
      steps: arrivalSteps(run.steps ?? []),
    }));
};
