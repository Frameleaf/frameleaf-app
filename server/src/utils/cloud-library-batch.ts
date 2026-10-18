import type { DatabaseRepository } from 'src/repositories/database.repository.js';
import type { MlDestinationRepository, MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import type { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import type { FrameleafCloudLibraryQueue } from 'src/types.js';
import type { CloudJobUploadState } from 'src/utils/frameleaf-cloud-job-client.js';
import { DatabaseLock, MlDestinationKind, MlWorkload, SystemMetadataKey } from 'src/enum.js';
import {
  type CloudClipResult,
  type CloudFaceResult,
  CLOUD_LIBRARY_FAILURE_WARNINGS,
  decodeCloudEmbedding,
} from 'src/utils/frameleaf-cloud.js';

/**
 * Frameleaf Cloud smart search and faces batches (FL-455). Smart search (`clip`, image embeddings) and faces
 * (`face`, detection and recognition) routed to the Frameleaf Cloud destination are never sent one photo at a
 * time: each photo's own job leaves it in a queue, and batches of one owner's photos go as one cloud job. A
 * result is stored only when it was made by this server's own model (`cloud-model-identity.ts`), exactly as
 * this server's own result would be. Search text is never part of it.
 */

/** The kinds of work a library batch runs, as the cloud names them. */
export type CloudLibraryWorkload = 'clip' | 'face';

export const cloudLibraryWorkloadOf = (workload: MlWorkload): CloudLibraryWorkload | null =>
  workload === MlWorkload.Clip ? 'clip' : workload === MlWorkload.Face ? 'face' : null;

export const appWorkloadOfLibrary = (workload: CloudLibraryWorkload): MlWorkload.Clip | MlWorkload.Face =>
  workload === 'clip' ? MlWorkload.Clip : MlWorkload.Face;

/** Photos in one batch, and so in one cloud job (the cloud takes 1 to 1,000 per job). */
export const CLOUD_LIBRARY_BATCH_SIZE = 500;
/** A batch is made once an owner has this many photos waiting for one kind of work... */
export const CLOUD_LIBRARY_MIN_BATCH = 50;
/** ...or once the oldest of them has waited this long. */
export const CLOUD_LIBRARY_MAX_WAIT_MS = 10 * 60 * 1000;
/** At most this many photos wait; more are left to the next run of the photos' own jobs. */
export const CLOUD_LIBRARY_QUEUE_MAX = 50_000;
/** How often the batch pass runs (cron). */
export const CLOUD_LIBRARY_PASS_CRON = '* * * * *';
/** Batches one pass steps at most. */
export const CLOUD_LIBRARY_STEPS_PER_PASS = 20;
/** A batch's claim lease: preparing 500 previews and estimating them fits well inside it. */
export const CLOUD_LIBRARY_LEASE_MS = 10 * 60_000;
/** How long a batch waits between two reads of its cloud job without a `Retry-After`, and at most. */
export const CLOUD_LIBRARY_POLL_MS = 30_000;
export const CLOUD_LIBRARY_POLL_MAX_MS = 5 * 60_000;
/** How long the cloud may take over one batch before it stops it (`deadlineSeconds`). */
export const CLOUD_LIBRARY_DEADLINE_SECONDS = 6 * 60 * 60;
/** The queue is written once this many photos wait in memory, or this long after the first. */
export const CLOUD_LIBRARY_QUEUE_FLUSH_SIZE = 100;
export const CLOUD_LIBRARY_QUEUE_FLUSH_MS = 5000;
/** The largest preview sent (the cloud refuses more than 16 MiB). */
export const CLOUD_LIBRARY_INPUT_MAX_BYTES = 16 * 1024 * 1024;

/** Where a batch is; the media operation status says whether it runs. */
export enum CloudLibraryPhase {
  Queued = 'queued',
  Estimated = 'estimated',
  Submitted = 'submitted',
  Finished = 'finished',
}

/** What a batch pins when it is made; never changed afterwards. */
export type CloudLibrarySnapshot = {
  version: 1;
  workload: CloudLibraryWorkload;
  destinationId: string;
  assetIds: string[];
  /** The catalogue model SKU matching this server's own model when the batch was made. */
  modelSku: string;
  /** This server's model name (`machineLearning.clip.modelName`, `facialRecognition.modelName`). */
  modelName: string;
  packKey: string;
};

/** One photo of a batch: what was sent (a digest, never a file name) and what became of it. */
export type CloudLibraryItem = {
  assetId: string;
  inputId: string;
  sha256?: string;
  bytes?: number;
  contentType?: string;
  /** The preview file sent, and the original's checksum then: a result is stored only while both still hold. */
  previewPath?: string;
  checksum?: string;
  /** Why the photo was not sent: `locked`, `not-found`, `hidden`, `no-preview`, `unsupported`, `prepare-failed`. */
  refused?: string;
  /** `stored` (the result was written), `local` (refused and left to this server) or `failed`. */
  outcome?: 'stored' | 'local' | 'failed';
  warnings?: string[];
  error?: string;
  costShareUsd?: number;
};

export type CloudLibraryResult = {
  phase: CloudLibraryPhase;
  items: CloudLibraryItem[];
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
    request: CloudLibraryRequest;
    attemptedAt: string | null;
  } | null;
  estimates: number;
  job: {
    jobId: string;
    status: string;
    holdUsd: number;
    ceilingUsd: number;
    admittedAt: string;
    meteredSeconds: number | null;
    started: boolean;
    etag: string | null;
  } | null;
  uploads: CloudJobUploadState;
  settledUsd: number | null;
  waiting: { refusal: string; detail: string; at: string } | null;
};

export const emptyCloudLibraryResult = (assetIds: readonly string[]): CloudLibraryResult => ({
  phase: CloudLibraryPhase.Queued,
  items: assetIds.map((assetId, index) => ({ assetId, inputId: `p${index + 1}` })),
  submission: null,
  estimates: 0,
  job: null,
  uploads: {},
  settledUsd: null,
  waiting: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const PHASES = new Set<string>(Object.values(CloudLibraryPhase));

/** A batch snapshot, or an error: a batch that cannot be read fails, never guessed at. */
export const parseCloudLibrarySnapshot = (value: unknown): CloudLibrarySnapshot => {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('This smart search or faces batch was written by another version and cannot be read');
  }
  const { workload, destinationId, assetIds, modelSku, modelName, packKey } = value;
  if (
    (workload !== 'clip' && workload !== 'face') ||
    typeof destinationId !== 'string' ||
    !Array.isArray(assetIds) ||
    assetIds.length === 0 ||
    assetIds.some((id) => typeof id !== 'string') ||
    typeof modelSku !== 'string' ||
    typeof modelName !== 'string' ||
    typeof packKey !== 'string'
  ) {
    throw new Error('This smart search or faces batch is incomplete and cannot be read');
  }
  return { version: 1, workload, destinationId, assetIds: assetIds as string[], modelSku, modelName, packKey };
};

/** A batch result read leniently: anything missing is what a new batch has. */
export const parseCloudLibraryResult = (value: unknown, assetIds: readonly string[]): CloudLibraryResult => {
  const empty = emptyCloudLibraryResult(assetIds);
  if (!isRecord(value)) {
    return empty;
  }
  return {
    phase:
      typeof value.phase === 'string' && PHASES.has(value.phase) ? (value.phase as CloudLibraryPhase) : empty.phase,
    items: Array.isArray(value.items) && value.items.length > 0 ? (value.items as CloudLibraryItem[]) : empty.items,
    submission: isRecord(value.submission) ? (value.submission as CloudLibraryResult['submission']) : null,
    estimates: typeof value.estimates === 'number' ? value.estimates : 0,
    job: isRecord(value.job) ? (value.job as CloudLibraryResult['job']) : null,
    uploads: isRecord(value.uploads) ? (value.uploads as CloudJobUploadState) : {},
    settledUsd: typeof value.settledUsd === 'number' ? value.settledUsd : null,
    waiting: isRecord(value.waiting) ? (value.waiting as CloudLibraryResult['waiting']) : null,
  };
};

/** The job-packing key of a model: batches of one model may share a started worker. */
export const cloudLibraryPackKey = (workload: CloudLibraryWorkload, modelSku: string): string =>
  `${workload}-${modelSku}`.slice(0, 64);

/** One key per batch and estimate; a retry of the same submission reuses it. */
export const cloudLibraryIdempotencyKey = (workload: CloudLibraryWorkload, batchId: string, estimate: number) =>
  `${workload}-${batchId.replaceAll('-', '')}-${estimate}`;

/** The `request` of a batch: the model this server expects, and for faces its detection threshold. */
export type CloudLibraryRequest = { model?: string; minScore?: number };
export const cloudLibraryRequest = (
  workload: CloudLibraryWorkload,
  modelName: string,
  minScore: number,
): CloudLibraryRequest => (workload === 'face' ? { model: modelName, minScore } : { model: modelName });

/** The `POST /v2/estimates` body of a batch, typed for its kind of work. */
export const cloudLibraryEstimateBody = (
  workload: CloudLibraryWorkload,
  modelSku: string,
  inputs: Array<{ inputId: string; contentType: string; bytes: number; sha256: string }>,
  request: CloudLibraryRequest,
) =>
  workload === 'clip'
    ? { workload: 'clip' as const, modelSku, inputs, request: { model: request.model } }
    : { workload: 'face' as const, modelSku, inputs, request };

/** One owner's photos per batch, at most `size` each, the order kept. */
export const groupCloudLibraryBatches = (
  candidates: ReadonlyArray<{ assetId: string; ownerId: string }>,
  size = CLOUD_LIBRARY_BATCH_SIZE,
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

/* ------------------------------------------------------------------ */
/* Results in this server's own shapes                                 */
/* ------------------------------------------------------------------ */

type ClipItem = CloudClipResult['items'][number];
type FaceItem = CloudFaceResult['items'][number];

const failedItem = (warnings: readonly string[]) =>
  warnings.some((warning) => CLOUD_LIBRARY_FAILURE_WARNINGS.includes(warning));

/**
 * A smart search item as this server's ML service would have answered it (`parseBoundClipResult`): the
 * embedding as the same JSON list of float32 values, with the image size. Null for an item that failed.
 */
export const toBoundClipResult = (item: ClipItem) => {
  if (failedItem(item.warnings) || !item.embedding || !item.image) {
    return null;
  }
  return {
    clip: JSON.stringify(decodeCloudEmbedding(item.embedding)),
    imageWidth: item.image.width,
    imageHeight: item.image.height,
  };
};

/**
 * A face item as this server's ML service would have answered it (`parseBoundFaceResult`): the image size,
 * and each face's box, score and embedding (the same JSON list of float32 values). Null for an item that
 * failed; a photo without faces has an empty list.
 */
export const toBoundFaceResult = (item: FaceItem) => {
  if (failedItem(item.warnings) || !item.image) {
    return null;
  }
  return {
    imageWidth: item.image.width,
    imageHeight: item.image.height,
    'facial-recognition': item.faces.map((face) => ({
      boundingBox: face.boundingBox,
      embedding: JSON.stringify(decodeCloudEmbedding(face.embedding)),
      score: face.score,
    })),
  };
};

/* ------------------------------------------------------------------ */
/* The queue                                                           */
/* ------------------------------------------------------------------ */

type QueueDeps = {
  databaseRepository: Pick<DatabaseRepository, 'withLock'>;
  systemMetadataRepository: Pick<SystemMetadataRepository, 'get' | 'set'>;
};
type QueueItem = FrameleafCloudLibraryQueue['items'][number];

/** Add photos to the queue in one read-modify-write under its lock; a photo already waiting keeps its place. */
export const queueCloudLibraryItems = (deps: QueueDeps, items: readonly QueueItem[]): Promise<number> =>
  deps.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlBatchQueue, async () => {
    const queue = (await deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudLibraryQueue)) ?? {
      items: [],
    };
    const key = (item: Pick<QueueItem, 'assetId' | 'workload'>) => `${item.workload}:${item.assetId}`;
    const waiting = new Set(queue.items.map((item) => key(item)));
    const added: QueueItem[] = [];
    let full = 0;
    for (const item of items) {
      if (waiting.has(key(item))) {
        continue;
      }
      if (queue.items.length + added.length >= CLOUD_LIBRARY_QUEUE_MAX) {
        full++;
        continue;
      }
      waiting.add(key(item));
      added.push(item);
    }
    if (added.length > 0) {
      await deps.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudLibraryQueue, {
        items: [...queue.items, ...added],
      });
    }
    return full;
  });

/**
 * The queue is written in batches, not once per photo: photos wait in memory and are written together once
 * `CLOUD_LIBRARY_QUEUE_FLUSH_SIZE` wait or `CLOUD_LIBRARY_QUEUE_FLUSH_MS` after the first arrived, and on
 * shutdown. A photo lost from memory by a crash has no result yet, so its job's next run finds it again.
 */
export class CloudLibraryQueueWriter {
  private pending = new Map<string, QueueItem>();
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private deps: () => QueueDeps,
    private warn: (message: string) => void,
  ) {}

  add(item: Omit<QueueItem, 'queuedAt'>, now = new Date()): Promise<void> {
    const key = `${item.workload}:${item.assetId}`;
    if (!this.pending.has(key)) {
      this.pending.set(key, { ...item, queuedAt: now.toISOString() });
    }
    if (this.pending.size >= CLOUD_LIBRARY_QUEUE_FLUSH_SIZE) {
      return this.flush();
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush().catch((error) =>
          this.warn(`The Frameleaf Cloud smart search and faces queue was not written: ${error}`),
        );
      }, CLOUD_LIBRARY_QUEUE_FLUSH_MS);
      this.timer.unref?.();
    }
    return Promise.resolve();
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const items = [...this.pending.values()];
    this.pending.clear();
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        if (items.length === 0) {
          return;
        }
        const full = await queueCloudLibraryItems(this.deps(), items);
        if (full > 0) {
          this.warn(`The Frameleaf Cloud smart search and faces queue is full; ${full} photos wait for their next run`);
        }
      });
    return this.writing;
  }
}

/**
 * The Frameleaf Cloud destination `workload` is routed to, or undefined when it runs on this server or a
 * home-network worker. Only rows are read; nothing is admitted or contacted. FL-456 replaces the single
 * route with an ordered list of sources and calls `frameleafCloudEligibility` for the cloud one.
 */
export const cloudLibraryDestination = async (
  repository: Pick<MlDestinationRepository, 'getRoute' | 'getById'>,
  workload: MlWorkload.Clip | MlWorkload.Face,
): Promise<MlDestinationRow | undefined> => {
  const id = (await repository.getRoute(workload))?.destinationId;
  if (!id) {
    return;
  }
  const destination = await repository.getById(id);
  return destination?.kind === MlDestinationKind.FrameleafCloud ? destination : undefined;
};
