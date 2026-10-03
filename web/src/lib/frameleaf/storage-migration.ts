/**
 * FL-326 (spec §5.1): Getting Ready's "Combining duplicate files" step and Library Care's status card,
 * ported from the prototype's `storage-migration-data.mjs` (`design/frameleaf/template`).
 *
 * After the safety copy (FL-295) and the upgrade, the server runs the one-time universal storage
 * migration: one file per checksum and size, missing originals relinked only to exact verified
 * copies, extra copies moved to the file trash. Its status is public (counts only), because Getting
 * Ready shows it before anyone signs in; sending it to the background is an administrator's choice.
 *
 * Read with plain `fetch`, like the rest of Getting Ready: the page has to work before the app's
 * normal start-up (`init`) has run.
 */

export const STORAGE_MIGRATION_STATUS_URL = '/api/server/storage-migration';
export const STORAGE_MIGRATION_BACKGROUND_URL = '/api/server/storage-migration/background';
export const STORAGE_MIGRATION_POLL_MS = 2000;

export const STORAGE_MIGRATION_STAGE_IDS = ['checking', 'relinking', 'linking', 'trashing'] as const;
export type StorageMigrationStageId = (typeof STORAGE_MIGRATION_STAGE_IDS)[number];

export type StorageMigrationStatus = {
  stage: 'pending' | StorageMigrationStageId | 'done';
  required: boolean;
  background: boolean;
  showInGettingReady: boolean;
  stages: Record<StorageMigrationStageId, { done: number; total: number }>;
  relinked: number;
  toReview: number;
  skipped: number;
  bytesFreed: number;
  estimatedSecondsLeft: number | null;
  startedAt: string | null;
  finishedAt: string | null;
};

/** The status, or undefined when the server does not answer it (an older server, or not up yet). */
export const fetchStorageMigrationStatus = async (
  fetchFn: typeof fetch = fetch,
): Promise<StorageMigrationStatus | undefined> => {
  try {
    const response = await fetchFn(STORAGE_MIGRATION_STATUS_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return;
    }
    return (await response.json()) as StorageMigrationStatus;
  } catch {
    return;
  }
};

export type BackgroundResult =
  | { kind: 'ok'; status: StorageMigrationStatus }
  /** Not signed in as an administrator: sign in, then come back here. */
  | { kind: 'sign-in' }
  | { kind: 'error' };

export const runStorageMigrationInBackground = async (fetchFn: typeof fetch = fetch): Promise<BackgroundResult> => {
  try {
    const response = await fetchFn(STORAGE_MIGRATION_BACKGROUND_URL, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403) {
      return { kind: 'sign-in' };
    }
    if (!response.ok) {
      return { kind: 'error' };
    }
    return { kind: 'ok', status: (await response.json()) as StorageMigrationStatus };
  } catch {
    return { kind: 'error' };
  }
};

export type StorageMigrationTaskStatus = 'done' | 'running' | 'queued';

export type StorageMigrationTask = {
  id: StorageMigrationStageId;
  status: StorageMigrationTaskStatus;
  done: number;
  total: number;
  percent: number;
};

export type StorageMigrationView = {
  /** working: no Continue; done / review: finished; background: an administrator let it run on. */
  kind: 'working' | 'done' | 'review' | 'background';
  canContinue: boolean;
  tasks: StorageMigrationTask[];
  /** The whole migration, 0-100, never going back as stages hand over. */
  percent: number;
  relinked: number;
  toReview: number;
  bytesFreed: number;
  estimatedSecondsLeft: number | null;
};

export const storageMigrationView = (status: StorageMigrationStatus): StorageMigrationView => {
  const index =
    status.stage === 'done'
      ? STORAGE_MIGRATION_STAGE_IDS.length
      : Math.max(0, STORAGE_MIGRATION_STAGE_IDS.indexOf(status.stage as StorageMigrationStageId));
  const tasks = STORAGE_MIGRATION_STAGE_IDS.map((id, position): StorageMigrationTask => {
    const { done, total } = status.stages[id];
    const taskStatus: StorageMigrationTaskStatus =
      position < index ? 'done' : position === index ? 'running' : 'queued';
    return {
      id,
      status: taskStatus,
      done,
      total,
      percent: total > 0 ? Math.floor((Math.min(done, total) / total) * 100) : taskStatus === 'done' ? 100 : 0,
    };
  });
  const current = tasks[index];
  const fraction = current && current.total > 0 ? Math.min(current.done, current.total) / current.total : 0;
  const percent =
    status.stage === 'done' ? 100 : Math.floor(((index + fraction) / STORAGE_MIGRATION_STAGE_IDS.length) * 100);

  const base = {
    tasks,
    percent,
    relinked: status.relinked,
    toReview: status.toReview,
    bytesFreed: status.bytesFreed,
    estimatedSecondsLeft: status.stage === 'done' ? null : status.estimatedSecondsLeft,
  };
  if (status.stage === 'done') {
    return { ...base, kind: status.toReview > 0 ? 'review' : 'done', canContinue: true };
  }
  if (status.background) {
    return { ...base, kind: 'background', canContinue: true };
  }
  return { ...base, kind: 'working', canContinue: false };
};

/** Time left as whole minutes and hours (rounded up), or "under a minute". */
export const timeLeftParts = (
  seconds: number | null,
):
  | { kind: 'none' }
  | { kind: 'under-minute' }
  | { kind: 'minutes'; minutes: number }
  | { kind: 'hours'; hours: number; minutes: number } => {
  if (seconds === null || seconds < 0) {
    return { kind: 'none' };
  }
  if (seconds < 60) {
    return { kind: 'under-minute' };
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return { kind: 'minutes', minutes };
  }
  return { kind: 'hours', hours: Math.floor(minutes / 60), minutes: minutes % 60 };
};

/** Getting Ready and the app's start-up: should this page wait for the migration? */
export const gettingReadyWaitsFor = (status: StorageMigrationStatus | undefined) => !!status?.showInGettingReady;
