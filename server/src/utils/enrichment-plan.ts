import { createHash } from 'node:crypto';
import { EnrichmentItemState, EnrichmentStage, EnrichmentStaleReason, MediaOperationStatus } from 'src/enum.js';

/**
 * The durable rules for enrichment plans and the moment index (FL-59, `REC-101`), kept free of the
 * database and of NestJS so they can be read and tested on their own.
 *
 * - **Stages.** Which stages a plan runs, in which order, and which ones a chosen stage pulls in.
 *   Moment captions are never chosen for anybody: a new or default plan leaves them off.
 * - **The plan's record.** `EnrichmentPlanSnapshot` is the immutable request (the frozen asset set,
 *   the resolved stages, the pinned destinations and the pinned configuration);
 *   `EnrichmentPlanResult` is what happened, per asset and per stage, written after every asset.
 * - **Per-asset state.** `enrichmentItemStates` turns the two into the queued / running / skipped /
 *   failed / completed / cancelled state the workbench shows, including after a reload.
 * - **Provenance.** Fingerprints of the source, the confirmed names and the configuration, and
 *   the rule that decides which generated result a change makes stale.
 */

/** The largest frozen set one plan accepts. Enrichment is model work; a plan is a deliberate choice. */
export const ENRICHMENT_PLAN_MAX_ASSETS = 1000;

/** Samples one preview may run. Previews are synchronous and run one at a time. */
export const ENRICHMENT_PREVIEW_MAX_SAMPLES = 6;

/** Reusable frames cut per video. Fixed: six evenly spaced frames give every video the same overview. */
export const VIDEO_MOMENT_FRAME_COUNT = 6;

/** The sampling policy the frames were cut with. A new policy is a visible refresh, never a silent one. */
export const VIDEO_MOMENT_EXTRACTOR_VERSION = 'even-6-v1';

/** Videos longer than this are not cut: six seeks into hours of footage would monopolise the worker. */
export const VIDEO_MOMENT_MAX_DURATION_MS = 3 * 60 * 60 * 1000;

/** The order stages run in, per asset. The Locked-content check comes before the description it informs. */
export const ENRICHMENT_STAGE_ORDER: readonly EnrichmentStage[] = [
  EnrichmentStage.Frames,
  EnrichmentStage.LockedCheck,
  EnrichmentStage.Description,
  EnrichmentStage.MomentIndex,
  EnrichmentStage.MomentCaptions,
];

/** What each stage needs to have run first. */
export const ENRICHMENT_STAGE_REQUIRES: Readonly<Record<EnrichmentStage, readonly EnrichmentStage[]>> = {
  [EnrichmentStage.Frames]: [],
  [EnrichmentStage.LockedCheck]: [],
  [EnrichmentStage.Description]: [],
  [EnrichmentStage.MomentIndex]: [EnrichmentStage.Frames],
  [EnrichmentStage.MomentCaptions]: [EnrichmentStage.Frames],
};

/** Stages that only apply to videos; a photo in the plan skips them. */
export const VIDEO_ONLY_STAGES: ReadonlySet<EnrichmentStage> = new Set([
  EnrichmentStage.Frames,
  EnrichmentStage.MomentIndex,
  EnrichmentStage.MomentCaptions,
]);

/** Stages that only apply to photos. The Locked-content classifier is calibrated for single images. */
export const IMAGE_ONLY_STAGES: ReadonlySet<EnrichmentStage> = new Set([EnrichmentStage.LockedCheck]);

/**
 * A new plan's stages when the person has not chosen any: descriptions and the Locked-content check.
 * Moment captions are never in a default: they add a model request per frame.
 */
export const DEFAULT_ENRICHMENT_STAGES: readonly EnrichmentStage[] = [
  EnrichmentStage.LockedCheck,
  EnrichmentStage.Description,
];

export type ResolvedEnrichmentStages = {
  /** Every stage the plan runs, in `ENRICHMENT_STAGE_ORDER`. */
  stages: EnrichmentStage[];
  /** Stages the plan runs only because a chosen stage needs them. */
  added: EnrichmentStage[];
};

/** The stages a plan runs for the ones chosen: the choice plus what it needs, in running order. */
export const resolveEnrichmentStages = (requested: readonly EnrichmentStage[]): ResolvedEnrichmentStages => {
  const chosen = new Set(requested.filter((stage) => ENRICHMENT_STAGE_ORDER.includes(stage)));
  const all = new Set(chosen);
  for (const stage of chosen) {
    for (const required of ENRICHMENT_STAGE_REQUIRES[stage]) {
      all.add(required);
    }
  }

  const stages = ENRICHMENT_STAGE_ORDER.filter((stage) => all.has(stage));
  return { stages, added: stages.filter((stage) => !chosen.has(stage)) };
};

/** Whether a stage has anything to do for an asset of this kind. */
export const stageAppliesTo = (stage: EnrichmentStage, isVideo: boolean): boolean =>
  isVideo ? !IMAGE_ONLY_STAGES.has(stage) : !VIDEO_ONLY_STAGES.has(stage);

/* -------------------------------------------------------------------------------------------- */
/* The plan's record                                                                            */
/* -------------------------------------------------------------------------------------------- */

/** The configuration a plan was pinned to. Written once, used for every asset of the plan. */
export type EnrichmentPinnedConfig = {
  description: {
    modelName: string;
    fallbackModelName: string;
    device: string;
    acceleration: string;
    prompt: Record<string, unknown>;
  };
  lockedCheck: { modelName: string; threshold: number; device: string };
  search: { modelName: string };
};

/** The immutable request, as stored in `media_operation.snapshot`. */
export type EnrichmentPlanSnapshot = {
  version: 1;
  /** The frozen set, in the order it is worked through. Order is the resume cursor. */
  assetIds: string[];
  /** What the person ticked. */
  requestedStages: EnrichmentStage[];
  /** What runs: the choice and the stages it needs. */
  stages: EnrichmentStage[];
  /**
   * The destinations the plan was admitted against (FL-110). Every request of the plan goes to
   * these and nowhere else; if one is gone or refuses, the stage fails in place. Null when no
   * chosen stage needs that workload.
   */
  destinations: { enrichment: string | null; search: string | null };
  config: EnrichmentPinnedConfig;
  /** Digest of `config`, recorded on every generated result the plan writes. */
  configHash: string;
  /** Client idempotency key: a repeated submit answers with the first plan. */
  requestKey: string | null;
  /** True when submitted from an unlocked session; Locked items may only be included then. */
  elevated: boolean;
};

/** One stage of one asset. */
export type EnrichmentStageOutcome = {
  state: EnrichmentItemState;
  /** Stable key the client turns into a message, e.g. `not-a-video`, `source-changed`. */
  reasonKey?: string | null;
  /** Operator detail, e.g. a refusal from the destination. */
  message?: string | null;
  at?: string;
};

/** Everything that happened to one asset of the plan. Only assets the plan has reached are here. */
export type EnrichmentPlanItem = {
  id: string;
  stages: Partial<Record<EnrichmentStage, EnrichmentStageOutcome>>;
};

/** The mutable record, as stored in `media_operation.result`. */
export type EnrichmentPlanResult = {
  version: 1;
  items: EnrichmentPlanItem[];
  /** The asset a worker had in hand when it last wrote. A new claim runs it again. */
  inFlight: string | null;
  /** The one automatic retry of the assets that failed, with its own cursor. */
  retry: { ids: string[]; processed: number } | null;
};

export const emptyEnrichmentPlanResult = (): EnrichmentPlanResult => ({
  version: 1,
  items: [],
  inFlight: null,
  retry: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const STAGE_VALUES = new Set<string>(Object.values(EnrichmentStage));
const STATE_VALUES = new Set<string>(Object.values(EnrichmentItemState));

const asStages = (value: unknown): EnrichmentStage[] =>
  Array.isArray(value) ? value.filter((stage): stage is EnrichmentStage => STAGE_VALUES.has(stage as string)) : [];

const asIdList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];

/** Read a stored snapshot. Throws when it cannot be a plan: running a malformed plan is worse than failing it. */
export const parseEnrichmentPlanSnapshot = (value: unknown): EnrichmentPlanSnapshot => {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('Enrichment plan snapshot is missing or has an unknown version');
  }

  const assetIds = asIdList(value.assetIds);
  const stages = asStages(value.stages);
  if (assetIds.length === 0 || stages.length === 0) {
    throw new Error('Enrichment plan snapshot has no assets or no stages');
  }

  const destinations = isRecord(value.destinations) ? value.destinations : {};
  const config = isRecord(value.config) ? value.config : undefined;
  if (!config || !isRecord(config.description) || !isRecord(config.lockedCheck) || !isRecord(config.search)) {
    throw new Error('Enrichment plan snapshot has no pinned configuration');
  }

  return {
    version: 1,
    assetIds,
    requestedStages: asStages(value.requestedStages),
    stages: ENRICHMENT_STAGE_ORDER.filter((stage) => stages.includes(stage)),
    destinations: {
      enrichment: typeof destinations.enrichment === 'string' ? destinations.enrichment : null,
      search: typeof destinations.search === 'string' ? destinations.search : null,
    },
    config: config as unknown as EnrichmentPinnedConfig,
    configHash: typeof value.configHash === 'string' ? value.configHash : '',
    requestKey: typeof value.requestKey === 'string' ? value.requestKey : null,
    elevated: value.elevated === true,
  };
};

const parseOutcome = (value: unknown): EnrichmentStageOutcome | undefined => {
  if (!isRecord(value) || typeof value.state !== 'string' || !STATE_VALUES.has(value.state)) {
    return undefined;
  }
  return {
    state: value.state as EnrichmentItemState,
    reasonKey: typeof value.reasonKey === 'string' ? value.reasonKey : null,
    message: typeof value.message === 'string' ? value.message : null,
    at: typeof value.at === 'string' ? value.at : undefined,
  };
};

/** Read a stored result leniently: whatever cannot be read is treated as not reached yet. */
export const parseEnrichmentPlanResult = (value: unknown): EnrichmentPlanResult => {
  if (!isRecord(value)) {
    return emptyEnrichmentPlanResult();
  }

  const items: EnrichmentPlanItem[] = [];
  for (const raw of Array.isArray(value.items) ? value.items : []) {
    if (!isRecord(raw) || typeof raw.id !== 'string') {
      continue;
    }
    const stages: EnrichmentPlanItem['stages'] = {};
    if (isRecord(raw.stages)) {
      for (const [stage, outcome] of Object.entries(raw.stages)) {
        const parsed = STAGE_VALUES.has(stage) ? parseOutcome(outcome) : undefined;
        if (parsed) {
          stages[stage as EnrichmentStage] = parsed;
        }
      }
    }
    items.push({ id: raw.id, stages });
  }

  const retry = isRecord(value.retry)
    ? {
        ids: asIdList(value.retry.ids),
        processed: Math.max(0, Math.trunc(Number(value.retry.processed) || 0)),
      }
    : null;

  return {
    version: 1,
    items,
    inFlight: typeof value.inFlight === 'string' ? value.inFlight : null,
    retry,
  };
};

/** Record an asset's outcome, replacing what an earlier attempt recorded for it. */
export const mergeEnrichmentItem = (result: EnrichmentPlanResult, item: EnrichmentPlanItem): EnrichmentPlanResult => {
  const existing = result.items.findIndex(({ id }) => id === item.id);
  if (existing === -1) {
    return { ...result, items: [...result.items, item] };
  }

  const items = [...result.items];
  items[existing] = { id: item.id, stages: { ...items[existing].stages, ...item.stages } };
  return { ...result, items };
};

/** One asset's overall state from its stages: any failure fails it, all skipped skips it. */
export const enrichmentItemOutcome = (item: EnrichmentPlanItem): EnrichmentItemState => {
  const states = Object.values(item.stages).map((outcome) => outcome?.state);
  if (states.includes(EnrichmentItemState.Failed)) {
    return EnrichmentItemState.Failed;
  }
  if (states.length > 0 && states.every((state) => state === EnrichmentItemState.Skipped)) {
    return EnrichmentItemState.Skipped;
  }
  return EnrichmentItemState.Completed;
};

/**
 * The stages a retry of this asset runs: those that failed and those skipped only because a stage
 * they need failed. Stages that completed or were skipped for their own reasons are not run again,
 * so a retry never applies an asset's work twice.
 */
export const stagesToRetry = (
  item: EnrichmentPlanItem | undefined,
  stages: readonly EnrichmentStage[],
): EnrichmentStage[] => {
  if (!item) {
    return [...stages];
  }
  return stages.filter((stage) => {
    const outcome = item.stages[stage];
    if (!outcome) {
      return true;
    }
    return (
      outcome.state === EnrichmentItemState.Failed ||
      (outcome.state === EnrichmentItemState.Skipped && outcome.reasonKey === 'dependency-failed')
    );
  });
};

/**
 * Plan the one automatic retry of the assets that failed (owner decision, September 22, 2026).
 * Returns null when there is nothing to retry or the pass has already been planned.
 */
export const planEnrichmentRetryPass = (
  snapshot: Pick<EnrichmentPlanSnapshot, 'assetIds'>,
  result: EnrichmentPlanResult,
): EnrichmentPlanResult | null => {
  if (result.retry) {
    return null;
  }

  const failed = new Set(
    result.items.filter((item) => enrichmentItemOutcome(item) === EnrichmentItemState.Failed).map(({ id }) => id),
  );
  if (failed.size === 0) {
    return null;
  }

  return { ...result, retry: { ids: snapshot.assetIds.filter((id) => failed.has(id)), processed: 0 } };
};

/** Assets of the automatic retry pass it has not reached yet. */
export const enrichmentRetryPending = (result: Pick<EnrichmentPlanResult, 'retry'>): string[] =>
  result.retry ? result.retry.ids.slice(result.retry.processed) : [];

/**
 * What a manual retry covers: assets that failed, assets never reached, and assets still waiting
 * for the automatic retry. Assets that completed or were skipped are not run again.
 */
export const enrichmentResumeIds = (
  snapshot: Pick<EnrichmentPlanSnapshot, 'assetIds'>,
  result: EnrichmentPlanResult,
  processed: number,
): string[] => {
  const failed = new Set(
    result.items.filter((item) => enrichmentItemOutcome(item) === EnrichmentItemState.Failed).map(({ id }) => id),
  );
  const cursor = Math.max(0, Math.min(processed, snapshot.assetIds.length));
  const unreached = new Set(snapshot.assetIds.slice(cursor));
  for (const id of enrichmentRetryPending(result)) {
    unreached.add(id);
  }
  return snapshot.assetIds.filter((id) => failed.has(id) || unreached.has(id));
};

/**
 * The record a manual retry starts from: the same pinned stages, destinations and configuration
 * over exactly the assets that did not finish, each carrying the stage outcomes it already has so
 * the retry only runs what failed. A retry is a new submission, so it has no idempotency key.
 */
export const enrichmentRetryRecord = (
  snapshot: EnrichmentPlanSnapshot,
  result: EnrichmentPlanResult,
  remaining: readonly string[],
): { snapshot: EnrichmentPlanSnapshot; result: EnrichmentPlanResult } => {
  const keep = new Set(remaining);
  return {
    snapshot: { ...snapshot, assetIds: [...remaining], requestKey: null },
    result: { ...emptyEnrichmentPlanResult(), items: result.items.filter(({ id }) => keep.has(id)) },
  };
};

const RUNNING_STATUSES: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
]);

const STOPPED_STATUSES: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Cancelled,
  MediaOperationStatus.Failed,
]);

export type EnrichmentItemView = {
  id: string;
  state: EnrichmentItemState;
  stages: Partial<Record<EnrichmentStage, EnrichmentStageOutcome>>;
  /** Waiting for its one automatic retry. */
  retryPending: boolean;
};

/**
 * Every asset of the plan with the state the workbench shows. Derived from the durable row alone,
 * so a reload, another tab or another device all see the same thing.
 *
 * - An asset the plan has not reached is `queued` while the plan can still get to it, and
 *   `cancelled` once the plan stopped (cancelled or failed as a whole) before it did.
 * - The asset a running worker has in hand is `running`.
 * - A failed asset waiting for its automatic retry is `queued` again, with its stages kept.
 * - An asset a manual retry carried over with its earlier outcomes is `queued` until the cursor
 *   reaches it (`processedUnits`): what it carries is history, not this plan's answer yet.
 */
export const enrichmentItemStates = (
  snapshot: Pick<EnrichmentPlanSnapshot, 'assetIds'>,
  result: EnrichmentPlanResult,
  operation: { status: MediaOperationStatus; processedUnits?: number | string | null },
): EnrichmentItemView[] => {
  const recorded = new Map(result.items.map((item) => [item.id, item]));
  const pending = new Set(enrichmentRetryPending(result));
  const running = RUNNING_STATUSES.has(operation.status);
  const stopped = STOPPED_STATUSES.has(operation.status);
  const cursor =
    operation.processedUnits === undefined || operation.processedUnits === null
      ? snapshot.assetIds.length
      : Math.max(0, Number(operation.processedUnits) || 0);

  return snapshot.assetIds.map((id, index) => {
    const item = recorded.get(id);
    const stages = item?.stages ?? {};
    if (running && result.inFlight === id) {
      return { id, state: EnrichmentItemState.Running, stages, retryPending: pending.has(id) };
    }
    if (pending.has(id)) {
      return {
        id,
        state: stopped ? EnrichmentItemState.Failed : EnrichmentItemState.Queued,
        stages,
        retryPending: !stopped,
      };
    }
    if (item && index < cursor) {
      return { id, state: enrichmentItemOutcome(item), stages, retryPending: false };
    }
    return {
      id,
      state: stopped ? EnrichmentItemState.Cancelled : EnrichmentItemState.Queued,
      stages,
      retryPending: false,
    };
  });
};

export type EnrichmentPlanCounts = Record<EnrichmentItemState, number> & { total: number };

export const countEnrichmentItems = (items: readonly Pick<EnrichmentItemView, 'state'>[]): EnrichmentPlanCounts => {
  const counts: EnrichmentPlanCounts = {
    total: items.length,
    [EnrichmentItemState.Queued]: 0,
    [EnrichmentItemState.Running]: 0,
    [EnrichmentItemState.Skipped]: 0,
    [EnrichmentItemState.Failed]: 0,
    [EnrichmentItemState.Completed]: 0,
    [EnrichmentItemState.Cancelled]: 0,
  };
  for (const item of items) {
    counts[item.state]++;
  }
  return counts;
};

/** Percent of assets the plan has answered for; the retry pass is counted inside the same total. */
export const enrichmentPlanProgress = (processed: number, total: number): number =>
  total <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((processed / total) * 1000) / 10));

/** What Activity shows as the job's title. Customer wording; no identifiers. */
export const enrichmentPlanLabel = (count: number): string => `Enrichment (${count} ${count === 1 ? 'item' : 'items'})`;

/* -------------------------------------------------------------------------------------------- */
/* Provenance                                                                                   */
/* -------------------------------------------------------------------------------------------- */

const digest = (value: string, length: number) => createHash('sha256').update(value).digest('hex').slice(0, length);

/** JSON with keys sorted at every level, so equal configurations always digest the same. */
export const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

/** Digest of a pinned configuration. */
export const enrichmentConfigHash = (config: unknown): string => digest(stableStringify(config), 16);

/**
 * Digest of the original a result was made from: its checksum and when it was last modified. A
 * replaced original, a re-imported file or an edited-in-place file all change it. Where the file
 * lives does not: a storage-template move or a library path change keeps every generated result.
 */
export const sourceFingerprint = (source: {
  checksum: Buffer | string | null;
  fileModifiedAt: Date | string | null;
}): string => {
  let checksum = '';
  if (source.checksum !== null) {
    checksum = Buffer.isBuffer(source.checksum) ? source.checksum.toString('hex') : source.checksum;
  }
  const modified =
    source.fileModifiedAt === null
      ? ''
      : source.fileModifiedAt instanceof Date
        ? source.fileModifiedAt.toISOString()
        : new Date(source.fileModifiedAt).toISOString();
  return digest(`${checksum}|${modified}`, 32);
};

/** Digest of the confirmed names a prompt was given. Order and duplicates do not matter. */
export const identityHash = (names: readonly string[]): string =>
  digest(
    JSON.stringify([...new Set(names.map((name) => name.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))),
    16,
  );

export type EnrichmentProvenance = {
  sourceFingerprint?: string | null;
  identityHash?: string | null;
  configHash?: string | null;
};

/**
 * Whether a generated result is stale against the current state. A value the result did not
 * record is not held against it: results written before provenance was pinned are not all stale.
 */
export const enrichmentStaleReason = (
  pinned: EnrichmentProvenance | null | undefined,
  current: EnrichmentProvenance,
): EnrichmentStaleReason | null => {
  if (!pinned) {
    return null;
  }
  if (pinned.sourceFingerprint && current.sourceFingerprint && pinned.sourceFingerprint !== current.sourceFingerprint) {
    return EnrichmentStaleReason.SourceChanged;
  }
  if (pinned.identityHash && current.identityHash && pinned.identityHash !== current.identityHash) {
    return EnrichmentStaleReason.IdentityChanged;
  }
  if (pinned.configHash && current.configHash && pinned.configHash !== current.configHash) {
    return EnrichmentStaleReason.ConfigChanged;
  }
  return null;
};

/* -------------------------------------------------------------------------------------------- */
/* Frames                                                                                       */
/* -------------------------------------------------------------------------------------------- */

const FRAME_START_PADDING_MS = 100;
const FRAME_END_PADDING_MS = 500;
const FRAME_END_PADDING_FRACTION = 0.02;

/**
 * Where to cut the reusable frames: `count` evenly spaced times, kept clear of the first tenth of a
 * second and of the very end (where a seek can land after the last keyframe and yield nothing).
 * Returns fewer, or none, for a video too short to hold them apart.
 */
export const videoMomentFrameTimestamps = (durationMs: number, count = VIDEO_MOMENT_FRAME_COUNT): number[] => {
  if (!Number.isFinite(durationMs) || durationMs <= FRAME_START_PADDING_MS || count < 1) {
    return [];
  }

  const latest = durationMs - Math.max(FRAME_END_PADDING_MS, durationMs * FRAME_END_PADDING_FRACTION);
  if (latest <= FRAME_START_PADDING_MS) {
    return [Math.round(durationMs / 2)];
  }

  const times = Array.from({ length: count }, (_, index) =>
    Math.round(Math.min(Math.max((durationMs * (index + 1)) / (count + 1), FRAME_START_PADDING_MS), latest)),
  );
  return [...new Set(times)].filter((time) => time > 0);
};

/** Rank frames best first by score; ties go to the earlier frame. Returns `frameIndex -> rank`. */
export const rankVideoFrames = (frames: readonly { frameIndex: number; score: number }[]): Map<number, number> => {
  const ordered = [...frames].sort((a, b) => b.score - a.score || a.frameIndex - b.frameIndex);
  return new Map(ordered.map((frame, index) => [frame.frameIndex, index + 1]));
};

/**
 * The frame that stands for the owner's chosen cover time: the nearest one. With no chosen time,
 * the best-ranked frame. Undefined when there are no frames.
 */
export const coverFrameFor = <T extends { timestampMs: number; rank: number }>(
  frames: readonly T[],
  coverTimestampMs: number | null,
): T | undefined => {
  if (frames.length === 0) {
    return undefined;
  }
  if (coverTimestampMs === null) {
    return [...frames].sort((a, b) => a.rank - b.rank)[0];
  }
  return [...frames].sort(
    (a, b) =>
      Math.abs(a.timestampMs - coverTimestampMs) - Math.abs(b.timestampMs - coverTimestampMs) || a.rank - b.rank,
  )[0];
};
