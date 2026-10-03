/**
 * The one-time universal storage upgrade migration (FL-326, spec §3.6), kept free of the database so
 * its state machine can be read and tested on its own.
 *
 * The migration walks the library in four stages, each checkpointed after every batch in system
 * metadata (`SystemMetadataKey.UniversalStorageMigration`), so a restart carries on from the last
 * finished batch:
 *
 * 1. `checking`: every original is looked for on disk; a missing one is recorded as a media-health
 *    Missing finding.
 * 2. `relinking`: a missing original is relinked to a verified exact copy in its own checksum and
 *    size group, or, failing that, to the one verified exact match a managed-storage search finds.
 *    Anything else stays a finding for review in Library Care. Never a guess.
 * 3. `linking`: every duplicate group shares its oldest asset's file.
 * 4. `trashing`: originals nothing references any more go to the file trash. Never unlinked.
 *
 * A batch that is repeated after an interruption finds its earlier work already done, and every
 * counter only ever moves forward, so the progress shown never goes back.
 */

export const STORAGE_MIGRATION_STAGES = ['checking', 'relinking', 'linking', 'trashing', 'done'] as const;
export type StorageMigrationStage = (typeof STORAGE_MIGRATION_STAGES)[number];

/** How many items one batch handles before the state is checkpointed. */
export const STORAGE_MIGRATION_BATCH_SIZE = 500;
/** How many skipped (unreadable) files the state names; the rest are counted. */
export const STORAGE_MIGRATION_SKIPPED_SHOWN = 100;

/** Where the relinking stage is: in-group copies first, then the managed-storage search, then applying it. */
export type StorageMigrationRelinkPhase = 'in-group' | 'search' | 'apply';

/** A managed-storage walk that did not finish in one step (media-health `ManagedSearchProgress`). */
export type StorageMigrationManagedSearch = {
  cursor: Array<{ path: string; after?: string }>;
  matches: Record<string, Record<string, Array<'sha1' | 'sha256'>>>;
};

export type StorageMigrationState = {
  version: 1;
  stage: StorageMigrationStage;
  /** False when the library had nothing to combine at all (a fresh install): Getting Ready skips the step. */
  required: boolean;
  /** An administrator chose "Run in background instead": Getting Ready no longer waits for it. */
  background: boolean;
  /** The current stage's cursor: the last asset id, finding id or group key it finished. */
  cursor: string | null;
  /** The media-health run the migration's Missing findings belong to. */
  runId: string | null;

  checked: number;
  total: number;

  relinkPhase: StorageMigrationRelinkPhase;
  managedSearch: StorageMigrationManagedSearch | null;
  relinkDone: number;
  relinkTotal: number;
  relinked: number;
  toReview: number;

  groupsLinked: number;
  groupsTotal: number;

  trashed: number;
  trashTotal: number;
  bytesFreed: number;

  /** Files that could not be read or verified: skipped, never linked. */
  skipped: number;
  skippedAssetIds: string[];

  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** Work units a second, measured over the last batches. Null until a batch was measured. */
  rate: number | null;
  error: string | null;
};

type Counter =
  | 'checked'
  | 'total'
  | 'relinkDone'
  | 'relinkTotal'
  | 'relinked'
  | 'toReview'
  | 'groupsLinked'
  | 'groupsTotal'
  | 'trashed'
  | 'trashTotal'
  | 'bytesFreed';

const COUNTERS: readonly Counter[] = [
  'checked',
  'total',
  'relinkDone',
  'relinkTotal',
  'relinked',
  'toReview',
  'groupsLinked',
  'groupsTotal',
  'trashed',
  'trashTotal',
  'bytesFreed',
];

/** Each stage's done/total pair: a total is never shown below what is done. */
const PAIRS: Record<Exclude<StorageMigrationStage, 'done'>, [Counter, Counter]> = {
  checking: ['checked', 'total'],
  relinking: ['relinkDone', 'relinkTotal'],
  linking: ['groupsLinked', 'groupsTotal'],
  trashing: ['trashed', 'trashTotal'],
};

export const createStorageMigrationState = ({ total, now }: { total: number; now: Date }): StorageMigrationState => {
  const required = total > 0;
  return {
    version: 1,
    stage: required ? 'checking' : 'done',
    required,
    background: false,
    cursor: null,
    runId: null,
    checked: 0,
    total,
    relinkPhase: 'in-group',
    managedSearch: null,
    relinkDone: 0,
    relinkTotal: 0,
    relinked: 0,
    toReview: 0,
    groupsLinked: 0,
    groupsTotal: 0,
    trashed: 0,
    trashTotal: 0,
    bytesFreed: 0,
    skipped: 0,
    skippedAssetIds: [],
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finishedAt: required ? null : now.toISOString(),
    rate: null,
    error: null,
  };
};

export const parseStorageMigrationState = (value: unknown): StorageMigrationState | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  const state = value as Partial<StorageMigrationState>;
  if (state.version !== 1 || !STORAGE_MIGRATION_STAGES.includes(state.stage as StorageMigrationStage)) {
    return;
  }
  return state as StorageMigrationState;
};

export const advanceStorageMigrationStage = (stage: StorageMigrationStage): StorageMigrationStage => {
  const index = STORAGE_MIGRATION_STAGES.indexOf(stage);
  return STORAGE_MIGRATION_STAGES[Math.min(index + 1, STORAGE_MIGRATION_STAGES.length - 1)];
};

export type StorageMigrationBatch = {
  /** The new cursor, phase and counters. Counters below the stored ones are ignored. */
  patch: Partial<Omit<StorageMigrationState, 'version' | 'skipped' | 'skippedAssetIds'>>;
  /** Assets skipped in this batch because their file could not be read or verified. */
  skipped?: string[];
  /** Work units this batch finished, for the measured rate. */
  units: number;
  startedAt: Date;
  now: Date;
};

/** The state after one finished batch: the checkpoint the next batch (or a restart) carries on from. */
export const recordStorageMigrationBatch = (
  state: StorageMigrationState,
  { patch, skipped = [], units, startedAt, now }: StorageMigrationBatch,
): StorageMigrationState => {
  const next: StorageMigrationState = { ...state, ...patch, updatedAt: now.toISOString() };
  for (const counter of COUNTERS) {
    next[counter] = Math.max(state[counter], patch[counter] ?? state[counter]);
  }
  for (const [done, total] of Object.values(PAIRS)) {
    next[total] = Math.max(next[total], next[done]);
  }
  if (next.stage !== state.stage && state.stage !== 'done') {
    // A finished stage is complete: what was done is its total (items may have gone meanwhile).
    const [done, total] = PAIRS[state.stage];
    next[total] = next[done];
  }

  const known = new Set(state.skippedAssetIds);
  const added = [...new Set(skipped).difference(known)];
  next.skipped = state.skipped + added.length;
  next.skippedAssetIds = [...state.skippedAssetIds, ...added].slice(0, STORAGE_MIGRATION_SKIPPED_SHOWN);

  const seconds = (now.getTime() - startedAt.getTime()) / 1000;
  if (units > 0 && seconds > 0) {
    const measured = units / seconds;
    // A moving average, so one slow batch (a long video) does not swing the estimate.
    next.rate = state.rate === null ? measured : state.rate * 0.7 + measured * 0.3;
  }
  if (next.stage === 'done' && !next.finishedAt) {
    next.finishedAt = now.toISOString();
  }
  return next;
};

/** Whether Getting Ready waits on this migration: it has work, is not done, and was not sent to the background. */
export const needsGettingReady = (state: StorageMigrationState | undefined): boolean =>
  !!state && state.required && state.stage !== 'done' && !state.background;

export type StorageMigrationStageProgress = { done: number; total: number };

export type StorageMigrationStatus = {
  stage: 'pending' | StorageMigrationStage;
  required: boolean;
  background: boolean;
  showInGettingReady: boolean;
  stages: Record<Exclude<StorageMigrationStage, 'done'>, StorageMigrationStageProgress>;
  relinked: number;
  toReview: number;
  skipped: number;
  bytesFreed: number;
  estimatedSecondsLeft: number | null;
  startedAt: string | null;
  finishedAt: string | null;
};

/** What the status endpoint answers: counts only, never a path or a name. */
export const storageMigrationStatus = (state: StorageMigrationState | undefined): StorageMigrationStatus => {
  if (!state) {
    const empty = { done: 0, total: 0 };
    return {
      stage: 'pending',
      required: true,
      background: false,
      showInGettingReady: false,
      stages: { checking: empty, relinking: empty, linking: empty, trashing: empty },
      relinked: 0,
      toReview: 0,
      skipped: 0,
      bytesFreed: 0,
      estimatedSecondsLeft: null,
      startedAt: null,
      finishedAt: null,
    };
  }

  const remaining =
    state.total -
    state.checked +
    (state.relinkTotal - state.relinkDone) +
    (state.groupsTotal - state.groupsLinked) +
    (state.trashTotal - state.trashed);
  const estimatedSecondsLeft =
    state.stage === 'done' || !state.rate || state.rate <= 0 ? null : Math.ceil(Math.max(remaining, 0) / state.rate);

  return {
    stage: state.stage,
    required: state.required,
    background: state.background,
    showInGettingReady: needsGettingReady(state),
    stages: {
      checking: { done: state.checked, total: state.total },
      relinking: { done: state.relinkDone, total: state.relinkTotal },
      linking: { done: state.groupsLinked, total: state.groupsTotal },
      trashing: { done: state.trashed, total: state.trashTotal },
    },
    relinked: state.relinked,
    toReview: state.toReview,
    skipped: state.skipped,
    bytesFreed: state.bytesFreed,
    estimatedSecondsLeft,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
};
