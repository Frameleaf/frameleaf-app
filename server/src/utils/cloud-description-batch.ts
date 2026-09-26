import type { SystemConfig } from 'src/config.js';
import type { DatabaseRepository } from 'src/repositories/database.repository.js';
import type { MlDestinationRepository, MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import type { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import type { CloudCatalogEntry, CloudConsentFeatures, CloudEstimate } from 'src/utils/frameleaf-cloud.js';
import { DatabaseLock, MlAdmissionRefusal, MlDestinationKind, MlWorkload, SystemMetadataKey } from 'src/enum.js';
import { cloudRouteAllows } from 'src/utils/ml-destination.js';

/**
 * Frameleaf Cloud description batches (FL-163, `CLD-203`). The constants are documented for
 * administrators in docs/administration/workers-and-endpoints.md ("Frameleaf Cloud description
 * batches"); change both together.
 */

/** Photos in one batch, and so in one cloud job. Never one job per photo. */
export const CLOUD_DESCRIPTION_BATCH_SIZE = 200;
/** The batch size below which the 72B class is not suggested: its start fee would dominate the cost. */
export const CLOUD_DESCRIPTION_HEAVY_MIN_BATCH = 200;
/** Automatic batching waits for this many new photos of one owner before it makes a batch... */
export const CLOUD_DESCRIPTION_AUTO_MIN_BATCH = 20;
/** ...or until that owner's oldest waiting photo has waited this long. */
export const CLOUD_DESCRIPTION_AUTO_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
/** At most this many new photos wait for automatic batching; more are left to a backfill. */
export const CLOUD_DESCRIPTION_QUEUE_MAX = 10_000;
/** A backfill covers at most this many photos, newest first; run it again for the rest. */
export const CLOUD_DESCRIPTION_BACKFILL_MAX = 5000;
/** Photos prepared for the sealed sample estimate a backfill's estimate is scaled from. */
export const CLOUD_DESCRIPTION_SAMPLE_SIZE = 10;
/** How often the batch pass runs (cron): automatic batching, then every batch's next step. */
export const CLOUD_DESCRIPTION_PASS_CRON = '* * * * *';
/** How long a batch waits between two reads of its cloud job. */
export const CLOUD_DESCRIPTION_POLL_MS = 60_000;
/** A batch's claim lease; one step (preparing 200 photos and estimating them) fits well inside it. */
export const CLOUD_DESCRIPTION_LEASE_MS = 10 * 60_000;
/** Batches one pass steps at most, so a pass never runs for long. */
export const CLOUD_DESCRIPTION_STEPS_PER_PASS = 20;
/** A sealed estimate may come in at most this much above what was approved; above it, nothing is sent. */
export const CLOUD_DESCRIPTION_PRICE_TOLERANCE = 1.2;
/** How long the cloud may take over one batch before it stops it (`deadlineSeconds`). */
export const CLOUD_DESCRIPTION_DEADLINE_SECONDS = 24 * 60 * 60;
/** How often, at most, a pass reads the usage report to settle finished batches. */
export const CLOUD_DESCRIPTION_SETTLE_INTERVAL_MS = 15 * 60_000;
/** How long a backfill estimate may be accepted; after it, the backfill is estimated again. */
export const CLOUD_DESCRIPTION_ESTIMATE_TTL_MS = 30 * 60_000;
/** Backfill estimates kept at once; an older one has to be made again. */
export const CLOUD_DESCRIPTION_ESTIMATES_KEPT = 3;
/** The automatic queue is written once this many new photos wait in memory... */
export const CLOUD_DESCRIPTION_QUEUE_FLUSH_SIZE = 100;
/** ...or this long after the first of them arrived. */
export const CLOUD_DESCRIPTION_QUEUE_FLUSH_MS = 5000;

/**
 * FL-163 review P1: whether Frameleaf Cloud's published contract lets this server upload a batch's
 * photos and read its results. Until it does, no cloud job is ever created: a backfill is refused, new
 * photos are not batched, and a batch stops before `POST /v2/jobs` (estimates, which are free, still
 * run). The job broker's upload and result contract is FC-39 and is not published yet. Flip this in the
 * change that implements that contract (uploads, `progress` and `result`), never because `POST /v2/jobs`
 * stopped answering 503 `capacity`. It is an object only so specs can exercise the submit path.
 */
export const CLOUD_DESCRIPTION_CONTRACT: { uploadsPublished: boolean } = { uploadsPublished: false };

/** Why nothing is sent while the contract has no uploads (see `CLOUD_DESCRIPTION_CONTRACT`). */
export const CLOUD_DESCRIPTION_UPLOADS_UNPUBLISHED =
  'Frameleaf Cloud does not accept description uploads from this server yet, so no description job is created. Nothing was sent.';
/**
 * The `request` every description batch sends: the length only. Prompts stay in the cloud (API
 * protection measure 2), so no name, face or other text from this server is ever part of it.
 */
export const CLOUD_DESCRIPTION_REQUEST = Object.freeze({ length: 'standard' as const });

/** Where a batch is. The media operation status says whether it is running; this says what it waits for. */
export enum CloudDescriptionPhase {
  /** Created; its photos are prepared and estimated at the next step. */
  Queued = 'queued',
  /** Estimated and checked against the wallet and budgets; submitted at this step or the next. */
  Estimated = 'estimated',
  /** Admitted by Frameleaf Cloud; its job is read until it ends. */
  Submitted = 'submitted',
  /** The cloud job ended; the settlement is applied when the usage report has it. */
  Finished = 'finished',
}

/** How a batch was made. Automatic batches count against the daily budget of "Describe new photos". */
export type CloudDescriptionOrigin = 'backfill' | 'automatic';

/** What a batch pins when it is created. Never changed afterwards. */
export type CloudDescriptionSnapshot = {
  version: 1;
  origin: CloudDescriptionOrigin;
  destinationId: string;
  assetIds: string[];
  /** The model SKU (FL-183 model identity) the batch is estimated and run with. */
  modelSku: string;
  /** The job-packing key: one per model, so batches of one model can share a started worker. */
  packKey: string;
  /** The most the batch may be estimated at (p90, USD) for a backfill; null for automatic batches. */
  approvedP90Usd: number | null;
};

/** One photo of a batch: its input as the cloud sees it (a digest, never a file name), or why it left the batch. */
export type CloudDescriptionItem = {
  assetId: string;
  inputId: string;
  sha256?: string;
  bytes?: number;
  contentType?: string;
  /** Why the photo was not sent after all: `locked`, `not-found`, `no-preview`, `not-an-image`, `prepare-failed`. */
  refused?: string;
  /** Its share of the settled charge, once settled (USD). */
  costShareUsd?: number;
};

/** What happened to a batch so far. `items` is left out of job lists (`listRecentOfKind`). */
export type CloudDescriptionResult = {
  phase: CloudDescriptionPhase;
  items: CloudDescriptionItem[];
  /** The consent features recorded when the batch was estimated, for reading its results (FL-163). */
  features: CloudConsentFeatures | null;
  /** The sealed estimate and the submission it belongs to. A new estimate gets a new idempotency key. */
  submission: {
    idempotencyKey: string;
    estimate: string;
    expiresAt: string;
    modelRev: string;
    computeSku: string;
    p50Usd: number;
    p90Usd: number;
    holdUsd: number;
    startupUsd: number;
    /**
     * When `POST /v2/jobs` was first sent with this key and estimate, recorded before it is sent. A
     * batch that finds it set replays the same key and body before estimating again, so a crash after
     * the job was created never creates a second one or leaves the first unwatched.
     */
    attemptedAt?: string | null;
  } | null;
  /** How many estimates this batch has asked for; part of each idempotency key. */
  estimates: number;
  job: {
    jobId: string;
    status: string;
    holdUsd: number;
    ceilingUsd: number;
    admittedAt: string;
    meteredSeconds: number | null;
  } | null;
  settledUsd: number | null;
  /** The last refusal a step met while waiting (for example 503 `capacity`), shown in the batch. */
  waiting: { refusal: string; detail: string; at: string } | null;
};

/**
 * A backfill estimate as the server keeps it (FL-163 review P1): what was shown to the administrator,
 * with the photos it covers per owner. `POST admin/cloud/ml/descriptions/batches` takes only its id and
 * queues from this record, so nothing the browser sends can change the model, the photos or the
 * price. Once started it keeps only what the answer repeats, so a second request is answered the same.
 */
export type CloudDescriptionEstimateRecord = {
  id: string;
  createdAt: string;
  expiresAt: string;
  modelSku: string;
  perPhotoP50Usd: number;
  perPhotoP90Usd: number;
  startupUsd: number;
  photos: number;
  /** The p90 of every batch together, USD: the most the queued batches may be approved at. */
  p90Usd: number;
  /** The administrator who asked for the estimate (informational). */
  createdBy: string | null;
  /** The photos the estimate covers, per owner. Emptied once the backfill started. */
  owners: Record<string, string[]>;
  started: { at: string; batches: number; photos: number; operationIds: string[] } | null;
};

export const emptyCloudDescriptionResult = (assetIds: readonly string[]): CloudDescriptionResult => ({
  phase: CloudDescriptionPhase.Queued,
  items: assetIds.map((assetId, index) => ({ assetId, inputId: `p${index + 1}` })),
  features: null,
  submission: null,
  estimates: 0,
  job: null,
  settledUsd: null,
  waiting: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const PHASES = new Set<string>(Object.values(CloudDescriptionPhase));

/** A batch snapshot, or an error naming what is wrong: a batch that cannot be read is failed, never guessed at. */
export const parseCloudDescriptionSnapshot = (value: unknown): CloudDescriptionSnapshot => {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('This description batch was written by another version and cannot be read');
  }
  const { origin, destinationId, assetIds, modelSku, packKey, approvedP90Usd } = value;
  if (
    (origin !== 'backfill' && origin !== 'automatic') ||
    typeof destinationId !== 'string' ||
    !Array.isArray(assetIds) ||
    assetIds.some((id) => typeof id !== 'string') ||
    typeof modelSku !== 'string' ||
    typeof packKey !== 'string' ||
    (approvedP90Usd !== null && typeof approvedP90Usd !== 'number')
  ) {
    throw new Error('This description batch is incomplete and cannot be read');
  }
  return {
    version: 1,
    origin,
    destinationId,
    assetIds: assetIds as string[],
    modelSku,
    packKey,
    approvedP90Usd: approvedP90Usd as number | null,
  };
};

/** A batch result read leniently: anything missing is what a new batch has. */
export const parseCloudDescriptionResult = (value: unknown, assetIds: readonly string[]): CloudDescriptionResult => {
  const empty = emptyCloudDescriptionResult(assetIds);
  if (!isRecord(value)) {
    return empty;
  }
  const phase =
    typeof value.phase === 'string' && PHASES.has(value.phase) ? (value.phase as CloudDescriptionPhase) : empty.phase;
  return {
    phase,
    items: Array.isArray(value.items) && value.items.length > 0 ? (value.items as CloudDescriptionItem[]) : empty.items,
    features: isRecord(value.features) ? (value.features as CloudConsentFeatures) : null,
    submission: isRecord(value.submission) ? (value.submission as CloudDescriptionResult['submission']) : null,
    estimates: typeof value.estimates === 'number' ? value.estimates : 0,
    job: isRecord(value.job) ? (value.job as CloudDescriptionResult['job']) : null,
    settledUsd: typeof value.settledUsd === 'number' ? value.settledUsd : null,
    waiting: isRecord(value.waiting) ? (value.waiting as CloudDescriptionResult['waiting']) : null,
  };
};

/**
 * Group photos into batches per owner (FL-163): one owner's photos never share a batch with
 * another's, each batch holds at most `size` photos, and the order within an owner is kept.
 */
export const groupCloudDescriptionBatches = (
  candidates: ReadonlyArray<{ assetId: string; ownerId: string }>,
  size = CLOUD_DESCRIPTION_BATCH_SIZE,
): Array<{ ownerId: string; assetIds: string[] }> => {
  const perOwner = new Map<string, string[]>();
  for (const { assetId, ownerId } of candidates) {
    const list = perOwner.get(ownerId) ?? [];
    if (!list.includes(assetId)) {
      list.push(assetId);
    }
    perOwner.set(ownerId, list);
  }
  const batches: Array<{ ownerId: string; assetIds: string[] }> = [];
  for (const [ownerId, assetIds] of perOwner) {
    for (let start = 0; start < assetIds.length; start += size) {
      batches.push({ ownerId, assetIds: assetIds.slice(start, start + size) });
    }
  }
  return batches;
};

/** The job-packing key of a model: batches of one model may share a started worker (FL-163). */
export const cloudDescriptionPackKey = (modelSku: string): string => `descriptions-${modelSku}`.slice(0, 64);

/**
 * The idempotency key of one submission: the batch and which estimate it carries. A retry of the same
 * submission reuses it (the cloud answers the same admission); a new estimate is a new submission.
 */
export const cloudDescriptionIdempotencyKey = (batchId: string, estimate: number): string =>
  `desc-${batchId.replaceAll('-', '')}-${estimate}`;

const micros = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** A backfill's projected cost, scaled from one sealed sample estimate (measured by the cloud). */
export type CloudDescriptionProjection = {
  photos: number;
  batches: Array<{ ownerId: string; photos: number; p50Usd: number; p90Usd: number; holdUsd: number }>;
  p50Usd: number;
  p90Usd: number;
  holdUsd: number;
  startupUsd: number;
  perPhotoP50Usd: number;
  perPhotoP90Usd: number;
  basis: 'measured' | 'modelled';
};

/**
 * Scale a sealed estimate for `sampleSize` photos to every batch (FL-163): the GPU time per photo is
 * the sample's run cost (its p50 and p90 less the start fee) divided by its photos, so each batch costs
 * one start fee plus its photos times that. The hold is sized as the cloud sizes it, from the p90 with
 * a quarter on top, plus the start fee. The cloud's own sealed estimate at submission is what is held.
 */
export const projectCloudDescriptionCost = (
  sample: Pick<CloudEstimate, 'cost' | 'basis'>,
  sampleSize: number,
  batches: ReadonlyArray<{ ownerId: string; assetIds: readonly string[] }>,
): CloudDescriptionProjection => {
  const photosInSample = Math.max(1, sampleSize);
  const startupUsd = sample.cost.startup;
  const perPhotoP50Usd = micros(Math.max(0, sample.cost.p50 - startupUsd) / photosInSample);
  const perPhotoP90Usd = micros(Math.max(perPhotoP50Usd, Math.max(0, sample.cost.p90 - startupUsd) / photosInSample));
  const projected = batches.map(({ ownerId, assetIds }) => {
    const photos = assetIds.length;
    return {
      ownerId,
      photos,
      p50Usd: micros(startupUsd + photos * perPhotoP50Usd),
      p90Usd: micros(startupUsd + photos * perPhotoP90Usd),
      holdUsd: micros(startupUsd + photos * perPhotoP90Usd * 1.25),
    };
  });
  const sum = (key: 'p50Usd' | 'p90Usd' | 'holdUsd') =>
    micros(projected.reduce((total, batch) => total + batch[key], 0));
  return {
    photos: projected.reduce((total, batch) => total + batch.photos, 0),
    batches: projected,
    p50Usd: sum('p50Usd'),
    p90Usd: sum('p90Usd'),
    holdUsd: sum('holdUsd'),
    startupUsd,
    perPhotoP50Usd,
    perPhotoP90Usd,
    basis: sample.basis,
  };
};

/** Whether a description model is of the 72B class, told by its display name (a SKU never names it). */
export const isHeavyDescriptionModel = (entry: Pick<CloudCatalogEntry, 'display'>): boolean =>
  /(?:^|\D)72b/i.test(entry.display.model);

const isMidDescriptionModel = (entry: Pick<CloudCatalogEntry, 'display'>): boolean =>
  /(?:^|\D)(?:27|35)b/i.test(entry.display.model);

/**
 * The 72B-class guidance (FL-163): with a 72B-class model, a batch of fewer than about 200 photos pays
 * mostly for the start fee, so the 27B/35B class is suggested instead when the catalogue offers it.
 * Null when the model is not of the 72B class or every batch is large enough.
 */
export const heavyModelGuidance = (
  model: Pick<CloudCatalogEntry, 'display'>,
  batchSizes: readonly number[],
  offered: ReadonlyArray<Pick<CloudCatalogEntry, 'sku' | 'label' | 'display' | 'workload' | 'rank'>>,
): {
  minimumBatch: number;
  smallBatches: number;
  suggestedModelId: string | null;
  suggestedModelName: string | null;
} | null => {
  if (!isHeavyDescriptionModel(model)) {
    return null;
  }
  const smallBatches = batchSizes.filter((size) => size < CLOUD_DESCRIPTION_HEAVY_MIN_BATCH).length;
  if (smallBatches === 0) {
    return null;
  }
  const suggestion = offered
    .filter((entry) => entry.workload === 'descriptions' && isMidDescriptionModel(entry))
    .toSorted((a, b) => b.rank - a.rank)[0];
  return {
    minimumBatch: CLOUD_DESCRIPTION_HEAVY_MIN_BATCH,
    smallBatches,
    suggestedModelId: suggestion?.sku ?? null,
    suggestedModelName: suggestion?.label ?? null,
  };
};

/** The server's calendar day (its own time zone), which the daily budget of automatic batches counts by. */
export const serverDay = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** The start of the server's next calendar day, when a daily budget that ran out applies again. */
export const nextServerDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);

/** The cloud job states after which nothing more happens to a job (docs/cloud-ml.md state machine). */
export const CLOUD_JOB_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'cancelled_budget',
  'expired',
]);

/** Refusals that describe a passing state: the batch waits and tries again, it is never sent elsewhere. */
export const CLOUD_DESCRIPTION_TRANSIENT_REFUSALS: ReadonlySet<MlAdmissionRefusal> = new Set([
  MlAdmissionRefusal.DestinationUnhealthy,
  MlAdmissionRefusal.CloudUnavailable,
  MlAdmissionRefusal.QuotaExceeded,
]);

/** The start of the server's calendar day `date` falls on. */
export const serverDayStart = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);

type QueueDeps = {
  databaseRepository: Pick<DatabaseRepository, 'withLock'>;
  systemMetadataRepository: Pick<SystemMetadataRepository, 'get' | 'set'>;
};

type QueueItem = { assetId: string; ownerId: string; queuedAt: string };

/**
 * Add photos to the automatic description queue (FL-163) in one read-modify-write under its lock; a
 * photo already waiting keeps its place. Returns how many could not be added because the queue is full
 * (`CLOUD_DESCRIPTION_QUEUE_MAX`): those wait for a backfill, which shows its estimate first.
 */
export const queueCloudDescriptions = (deps: QueueDeps, items: readonly QueueItem[]): Promise<number> =>
  deps.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlBatchQueue, async () => {
    const queue = (await deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudDescriptionQueue)) ?? {
      items: [],
      lastBatchAt: {},
    };
    const waiting = new Set(queue.items.map(({ assetId }) => assetId));
    const added: QueueItem[] = [];
    let full = 0;
    for (const item of items) {
      if (waiting.has(item.assetId)) {
        continue;
      }
      if (queue.items.length + added.length >= CLOUD_DESCRIPTION_QUEUE_MAX) {
        full++;
        continue;
      }
      waiting.add(item.assetId);
      added.push(item);
    }
    if (added.length > 0) {
      await deps.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudDescriptionQueue, {
        ...queue,
        items: [...queue.items, ...added],
      });
    }
    return full;
  });

/**
 * FL-163 review P2: the automatic queue is written in batches, not once per photo. New photos wait in
 * memory and are written together once `CLOUD_DESCRIPTION_QUEUE_FLUSH_SIZE` wait or
 * `CLOUD_DESCRIPTION_QUEUE_FLUSH_MS` after the first arrived, and on shutdown. A photo lost from memory
 * by a crash is not described automatically; it still has no description, so the next backfill finds
 * it. Nothing is ever sent from here.
 */
export class CloudDescriptionQueueWriter {
  private pending = new Map<string, QueueItem>();
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private deps: () => QueueDeps,
    private warn: (message: string) => void,
  ) {}

  add(item: { assetId: string; ownerId: string }, now = new Date()): Promise<void> {
    if (!this.pending.has(item.assetId)) {
      this.pending.set(item.assetId, { assetId: item.assetId, ownerId: item.ownerId, queuedAt: now.toISOString() });
    }
    if (this.pending.size >= CLOUD_DESCRIPTION_QUEUE_FLUSH_SIZE) {
      return this.flush();
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush().catch((error) => this.warn(`The Frameleaf Cloud description queue was not written: ${error}`));
      }, CLOUD_DESCRIPTION_QUEUE_FLUSH_MS);
      this.timer.unref?.();
    }
    return Promise.resolve();
  }

  /** Write every waiting photo now, after any write already under way. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const items = this.pending.values().toArray();
    this.pending.clear();
    // a write that failed was already reported to its caller; it never stops the next one
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        if (items.length === 0) {
          return;
        }
        const full = await queueCloudDescriptions(this.deps(), items);
        if (full > 0) {
          this.warn(`The Frameleaf Cloud description queue is full; ${full} new photos wait for a backfill`);
        }
      });
    return this.writing;
  }
}

/**
 * FL-163: the Frameleaf Cloud destination descriptions go to: the one named (a plan's pinned
 * destination), else the routed one; undefined when they go to this server or a home-network worker.
 * Only rows are read; nothing is admitted or contacted.
 */
export const cloudDescriptionDestination = async (
  repository: Pick<MlDestinationRepository, 'getRoute' | 'getById'>,
  destinationId?: string | null,
  cloudMl?: Pick<SystemConfig['frameleafCloud']['cloudMl'], 'enabled' | 'routing'>,
): Promise<MlDestinationRow | undefined> => {
  // with the settings given, descriptions only go to Frameleaf Cloud while processing is on for them
  if (cloudMl && !(cloudMl.enabled && cloudRouteAllows(cloudMl, MlWorkload.Enrichment))) {
    return;
  }
  const id = destinationId ?? (await repository.getRoute(MlWorkload.Enrichment))?.destinationId;
  if (!id) {
    return;
  }
  const destination = await repository.getById(id);
  if (destination?.kind === MlDestinationKind.FrameleafCloud) {
    return destination;
  }
};
