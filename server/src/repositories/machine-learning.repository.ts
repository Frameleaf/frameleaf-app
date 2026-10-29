import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import z from 'zod';
import type { Transaction } from 'kysely';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { DB } from 'src/schema/index.js';
import type { DesktopModelProfile } from 'src/utils/desktop-model-catalogue.js';
import type { CloudProbeFacts } from 'src/utils/frameleaf-cloud.js';
import type { MlContainerReport } from 'src/utils/hardware-check.js';
import { MachineLearningConfig } from 'src/dtos/config.dto.js';
import {
  RESTORATION_MAX_OUTPUT_EDGE,
  RESTORATION_PROTOCOL,
  RESTORATION_RESULT_HEADER,
  RestorationCapabilityReport,
  RestorationCapabilityReportSchema,
  RestorationModelState,
  RestorationWorkerErrorCode,
  RestorationWorkerErrorSchema,
  RestorationWorkerRequest,
  RestorationWorkerRequestSchema,
  RestorationWorkerResult,
  RestorationWorkerResultSchema,
} from 'src/dtos/restoration-inference.dto.js';
import { MachineLearningHardwareResponseDto } from 'src/dtos/system-config.dto.js';
import {
  CLOUD_ML_DESTINATION_KINDS,
  LIBRARY_ML_WORKLOADS,
  MachineLearningHardwareAcceleration,
  MlDestinationKind,
  MlWorkload,
} from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { JobDependencyUnavailable, deferJobUntilDependency } from 'src/queue/dependency.js';
import { fetchJobText } from 'src/queue/http.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { parseBoundClipResult } from 'src/utils/clip-embedding.js';
import { readConfig } from 'src/utils/config.js';
import { faceEntries } from 'src/utils/desktop-face.js';
import { ocrEntries } from 'src/utils/desktop-ocr.js';
import { parseBoundFaceResult } from 'src/utils/face-result.js';
import { canonicalJson } from 'src/utils/object.js';
import { parseBoundOcrResult } from 'src/utils/ocr-result.js';
import { recoveryMlRefusal } from 'src/utils/recovery-ml-authority.js';
import {
  RestorationInference,
  RestorationInferenceInput,
  RestorationInferenceOptions,
  RestorationInferenceResult,
  RestorationSelection,
  restorationAdmissionOf,
  workloadForMode,
} from 'src/utils/restoration.js';

export interface BoundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export enum ModelTask {
  FACIAL_RECOGNITION = 'facial-recognition',
  SEARCH = 'clip',
  OCR = 'ocr',
  IMAGE_DESCRIPTION = 'image-description-tagging',
  NSFW_DETECTION = 'nsfw-detection',
}

export enum ModelType {
  CLASSIFICATION = 'classification',
  DETECTION = 'detection',
  PIPELINE = 'pipeline',
  RECOGNITION = 'recognition',
  TEXTUAL = 'textual',
  VISUAL = 'visual',
  OCR = 'ocr',
}

export type ModelPayload = { imagePath: string } | { text: string };

type ModelOptions = { modelName: string };

export type FaceDetectionOptions = ModelOptions & { minScore: number };
export type OcrOptions = ModelOptions & {
  minDetectionScore: number;
  minRecognitionScore: number;
  maxResolution: number;
};
export type ImageDescriptionOptions = ModelOptions & {
  acceleration: MachineLearningHardwareAcceleration;
  fallbackModelName: string;
  device: string;
};
export type NsfwDetectionOptions = ModelOptions & {
  threshold: number;
  device: string;
};
type VisualResponse = { imageHeight: number; imageWidth: number };
export type ClipVisualRequest = { [ModelTask.SEARCH]: { [ModelType.VISUAL]: ModelOptions } };
export type ClipVisualResponse = { [ModelTask.SEARCH]: string } & VisualResponse;

export type ClipTextualRequest = { [ModelTask.SEARCH]: { [ModelType.TEXTUAL]: ModelOptions } };
export type ClipTextualResponse = { [ModelTask.SEARCH]: string };

export type OCR = {
  text: string[];
  box: number[];
  boxScore: number[];
  textScore: number[];
};

export type OcrRequest = {
  [ModelTask.OCR]: {
    [ModelType.DETECTION]: ModelOptions & { options: { minScore: number; maxResolution: number } };
    [ModelType.RECOGNITION]: ModelOptions & { options: { minScore: number } };
  };
};
export type OcrResponse = { [ModelTask.OCR]: OCR } & VisualResponse;

export type NsfwDetectionResult = {
  isNsfw: boolean;
  score: number;
  labels: Record<string, number>;
};

export type ImageDescriptionResult = {
  description: string;
  /**
   * FL-36: the model's confidence in the description, 0 to 1, when the destination reports one.
   * The bundled service does not (its people and safety signals carry only low/medium/high labels,
   * which are never turned into a number); stored only when present, null otherwise.
   */
  confidence?: number | null;
  people: Array<{
    count: number;
    apparent_age_group: string;
    activity: string;
    confidence: string;
  }>;
  environment: string;
  objects: string[];
  visible_text: string[];
  context: string;
  tags: string[];
  safety?: {
    is_nsfw_likely: boolean;
    confidence: string;
    indicators: string[];
    reason: string;
  };
  medical?: {
    is_medical_likely: boolean;
    confidence: string;
    indicators: string[];
    reason: string;
  };
};

export type ImageDescriptionRequest = {
  [ModelTask.IMAGE_DESCRIPTION]: {
    [ModelType.VISUAL]: ModelOptions & {
      options: {
        acceleration: MachineLearningHardwareAcceleration;
        device: string;
        nsfw?: NsfwDetectionResult;
      };
    };
  };
};
/** `device`: where the worker ran it (FL-427); older workers and Frameleaf Cloud leave it out. */
export type ImageDescriptionResponse = {
  [ModelTask.IMAGE_DESCRIPTION]: ImageDescriptionResult & { device?: string };
} & VisualResponse;

/** A description, the model that answered it and the device the worker ran it on (null when it did not say). */
export type ImageDescriptionRun = { result: ImageDescriptionResult; model: string; device: string | null };

// The result is stored with the asset, so the worker's `device` is split off it here.
const describedBy = (
  { device, ...result }: ImageDescriptionResponse[ModelTask.IMAGE_DESCRIPTION],
  model: string,
): ImageDescriptionRun => ({ result, model, device: device ?? null });

export type NsfwDetectionRequest = {
  [ModelTask.NSFW_DETECTION]: {
    [ModelType.CLASSIFICATION]: ModelOptions & { options: { threshold: number; device: string } };
  };
};
export type NsfwDetectionResponse = { [ModelTask.NSFW_DETECTION]: NsfwDetectionResult } & VisualResponse;

export type FacialRecognitionRequest = {
  [ModelTask.FACIAL_RECOGNITION]: {
    [ModelType.DETECTION]: ModelOptions & { options: { minScore: number } };
    [ModelType.RECOGNITION]: ModelOptions;
  };
};

export interface Face {
  boundingBox: BoundingBox;
  embedding: string;
  score: number;
}

export type FacialRecognitionResponse = { [ModelTask.FACIAL_RECOGNITION]: Face[] } & VisualResponse;

export type MachineLearningRequest =
  | ClipVisualRequest
  | ClipTextualRequest
  | FacialRecognitionRequest
  | OcrRequest
  | ImageDescriptionRequest
  | NsfwDetectionRequest;
export type TextEncodingOptions = ModelOptions & { language?: string };

export type MachineLearningHardwareResponse = {
  providers: string[];
  openvinoDeviceIds: string[];
  torchCudaAvailable: boolean;
  cudaDeviceCount: number;
  preferredAcceleration: MachineLearningHardwareAcceleration;
};

export const defaultMachineLearningHardware: MachineLearningHardwareResponse = {
  providers: [],
  openvinoDeviceIds: [],
  torchCudaAvailable: false,
  cudaDeviceCount: 0,
  preferredAcceleration: MachineLearningHardwareAcceleration.Auto,
};

const isFlorenceImageDescriptionModel = (modelName: string) => {
  const cleanModelName = modelName.trim().toLowerCase().split('/').at(-1) ?? '';
  return cleanModelName.startsWith('florence-2-');
};

/**
 * A resolved place to send one request: the URL and, for authenticated workers, the bearer. The
 * Frameleaf Cloud destination resolves to `FRAMELEAF_CLOUD_ENDPOINT` (`cloud: true`): it has no URL
 * of its own, so a check of it is delegated to the cloud processing service (FL-159).
 */
export type MlEndpoint = { url: string; authToken?: string; cloud?: true; assertAuthority?: () => Promise<void> };

/** The sentinel the Frameleaf Cloud destination resolves to; never fetched as a URL. */
export const FRAMELEAF_CLOUD_ENDPOINT: MlEndpoint = Object.freeze({ url: 'frameleaf-cloud:gateway', cloud: true });

/** Checks Frameleaf Cloud for the destination (registered by `CloudMlService`). */
export type CloudMlProber = (options: { maxAgeMs: number }) => Promise<MlEndpointProbe>;

/**
 * FL-159: Frameleaf Cloud runs work as cloud jobs (estimate, confirm, upload, result), never through
 * the `/predict` or restoration protocols of local and LAN workers. Until cloud jobs are submitted
 * (CLD-202, CLD-203) a request bound to it fails in place with this error: it is never sent to
 * another destination.
 */
export class CloudJobsUnavailableError extends Error {
  constructor(what: string) {
    super(`Frameleaf Cloud runs ${what} as a cloud job, which this server does not submit yet; nothing was sent`);
    this.name = 'CloudJobsUnavailableError';
  }
}

/** What one request cost, recorded per destination for FL-115's accounting. */
export type MlUsage = {
  bytesSent: number;
  bytesReceived: number;
  durationMs: number;
  outcome: 'success' | 'failure';
};

/**
 * The result of an explicit, admitted selection (FL-110). Every inference call takes one of
 * these as its first argument: there is no "current URL" inside the repository any more,
 * so a call cannot reach a destination the caller did not name. `record` is the accounting
 * hook the selection owner installs; the repository calls it exactly once per request.
 */
export type DesktopPoolOptions = {
  jobId?: string | null;
  /**
   * FL-456: take the job only when one of the owner's Frameleaf Desktop helpers is online and qualified
   * for its model now; otherwise hand it back so the next place in the processing order can take it.
   */
  requireReady?: boolean;
  modelName: string;
  ocr?: MachineLearningConfig['ocr'];
  face?: MachineLearningConfig['facialRecognition'];
  assertConfig: (tx?: Transaction<DB>) => Promise<void>;
};
export type DesktopPoolSelector = (selection: MlSelection, options: DesktopPoolOptions) => Promise<MlSelection>;

export type MlSelection = {
  /** Internal admitted background pool; never reconstructed from an API response. */
  desktopFace?: (payload: ModelPayload, entries: unknown) => Promise<unknown>;
  desktopOcr?: (payload: ModelPayload, entries: unknown) => Promise<unknown>;
  desktopClip?: (payload: ModelPayload, profile: DesktopModelProfile) => Promise<unknown>;
  destinationId: string;
  kind: MlDestinationKind;
  workload: MlWorkload;
  endpoint: MlEndpoint;
  /**
   * FL-146, FL-183: the catalogue model SKU a Frameleaf Cloud job names (the routed choice, else the
   * catalogue's default for its group); null for this server and home-network workers, which use
   * the local settings.
   */
  cloudModelId?: string | null;
  record: (usage: MlUsage) => void;
};

/**
 * What a probe learned about one endpoint. `workloads` is what the worker itself claims to
 * serve (`GET /capabilities`). A worker that answers `/ping` but has no capabilities route
 * is a predict container from before that route existed; it is credited with the library
 * workloads and nothing else, so it can never be admitted for restoration or Studio work.
 */
export type MlEndpointProbe = {
  reachable: boolean;
  workloads: MlWorkload[];
  hardware: MachineLearningHardwareResponse | null;
  latencyMs: number;
  probedAt: Date;
  error: string | null;
  /** FL-159: what a Frameleaf Cloud check learned; absent for local and LAN workers. */
  cloud?: CloudProbeFacts | null;
};

type CapabilitiesResponse = { workloads?: unknown };

const renderNodeSchema = z.object({
  node: z.string().max(40),
  vendor: z.string().max(40).nullable(),
  accessible: z.boolean(),
  memoryTotalBytes: z.number().int().min(0).nullable(),
  gid: z.number().int().min(0).nullable().optional(),
  hostNode: z.string().max(40).nullable().optional(),
});

const hostSchema = z.object({
  kernel: z.string().max(200).nullable(),
  gpus: z
    .array(
      z.object({
        pciAddress: z.string().max(40),
        vendor: z.string().max(40),
        renderNode: z.string().max(40).nullable(),
        integrated: z.boolean(),
        memoryTotalBytes: z.number().int().min(0).nullable(),
      }),
    )
    .max(16)
    .nullable(),
  dxg: z.boolean(),
  groups: z.array(z.number().int()).max(64),
  root: z.boolean(),
});

/** FL-159: what the container reached for AI work (`machine-learning/frameleaf_ml/hardware_report.py`). */
const mlContainerSchema = z.object({
  image: z.string().max(40),
  backend: z.string().max(40),
  gpus: z
    .array(
      z.object({
        name: z.string().max(200),
        vendor: z.string().max(40).nullable(),
        memoryTotalBytes: z.number().int().min(0).nullable(),
      }),
    )
    .max(16),
  driver: z.string().max(300).nullable(),
  nvidiaError: z.string().max(300).nullable().default(null),
  devices: z.object({
    renderNodes: z.array(renderNodeSchema).max(16),
    kfd: z.boolean(),
    kfdAccessible: z.boolean(),
    nvidia: z.boolean(),
    nvidiaRequested: z.boolean(),
  }),
  // Absent from an older ML image; the check then reports those facts as not known.
  host: hostSchema.nullable().optional(),
  computeCapability: z.string().max(10).nullable().optional(),
  rocm: z
    .object({ gfxTargets: z.array(z.string().max(20)).max(16), hsaOverride: z.string().max(20).nullable() })
    .nullable()
    .optional(),
});

const diagnosticHardwareSchema = MachineLearningHardwareResponseDto.schema.extend({
  providers: z.array(z.string().max(100)).max(32),
  openvinoDeviceIds: z.array(z.string().max(100)).max(32),
  cudaDeviceCount: z.int().min(0).max(1024),
});

/**
 * FL-159: the container report of `GET /hardware`, or null for a worker that does not send one (an
 * older image) or sends one this server cannot read.
 */
export const parseMlContainerReport = (body: unknown): MlContainerReport | null => {
  const container = (body as { container?: unknown } | null)?.container;
  const parsed = mlContainerSchema.safeParse(container);
  return parsed.success ? parsed.data : null;
};

const RESTORATION_WORKLOAD_SET: ReadonlySet<MlWorkload> = new Set([
  MlWorkload.RestorationFaithful,
  MlWorkload.RestorationCreative,
  MlWorkload.Interpolation,
]);

const isMlWorkload = (value: unknown): value is MlWorkload =>
  typeof value === 'string' && (Object.values(MlWorkload) as string[]).includes(value);

/** How long an admission probe stays fresh before the next request re-probes the endpoint. */
export const ML_PROBE_FRESHNESS_MS = 10_000;

/** Longest a single restoration request may take, whatever signal the caller passes. */
export const RESTORATION_REQUEST_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * A restoration worker refused or failed an inference. `code` is the worker's own code,
 * `unreachable` when the request never got an answer, or `protocol-error` when the answer
 * could not be trusted (missing or mismatched result, or a file that failed its hash).
 */
/**
 * The model Studio captions ask for (owner decision 2026-10-09: Whisper). The worker maps it to its own
 * choice: whisper-large-v3-turbo on a CUDA GPU, whisper-small otherwise, or what its administrator set.
 */
export const TRANSCRIBE_MODEL_NAME = 'frameleaf-transcribe';

/** The worker cannot transcribe: no `/transcribe` route, no Whisper runtime or the model is unavailable. */
export class TranscriptionUnavailableError extends Error {}

const transcriptWordSchema = z.object({
  start: z.number().min(0).max(1e6),
  end: z.number().min(0).max(1e6),
  text: z.string().max(512),
});

/** One line of a worker's `/transcribe` stream (machine-learning/frameleaf_ml/main.py). */
export const transcriptStreamItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('info'),
    model: z.string().max(128),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    language: z.string().max(16),
    languageProbability: z.number().min(0).max(1),
    duration: z.number().min(0).max(1e6),
  }),
  z.object({
    type: z.literal('segment'),
    start: z.number().min(0).max(1e6),
    end: z.number().min(0).max(1e6),
    text: z.string().max(4096),
    words: z.array(transcriptWordSchema).max(2048),
  }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string().max(512) }),
]);
export type TranscriptStreamItem = z.infer<typeof transcriptStreamItemSchema>;
export type TranscriptSegment = Extract<TranscriptStreamItem, { type: 'segment' }>;
export type TranscriptInfo = Extract<TranscriptStreamItem, { type: 'info' }>;

/** A stream line above this is not a transcript; the whole answer is bounded too. */
const TRANSCRIPT_LINE_BYTES = 256 * 1024;
const TRANSCRIPT_TOTAL_BYTES = 64 * 1024 * 1024;

/** The music model Make a movie asks for (FL-561, owner decision 2026-10-26: MusicGen small). */
export const MUSIC_MODEL_NAME = 'frameleaf-music';

/** The worker cannot make music: no `/music` route (an older worker) or the model is unavailable. */
export class MusicUnavailableError extends Error {}

/** One line of a worker's `/music` stream (machine-learning/frameleaf_ml/main.py). */
export const musicStreamItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    done: z.int().min(0).max(1e7),
    total: z.int().min(1).max(1e7),
  }),
  z.object({
    type: z.literal('info'),
    sampleRate: z.int().min(8000).max(192_000),
    seconds: z.number().min(0).max(600),
  }),
  z.object({ type: z.literal('audio'), data: z.string().max(1024 * 1024) }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string().max(512) }),
]);

/** A music line above this is not music; the whole answer is bounded too (three minutes of WAV, base64). */
const MUSIC_LINE_BYTES = 1024 * 1024;
const MUSIC_TOTAL_BYTES = 64 * 1024 * 1024;

/** The translation model Studio captions ask for (FL-641, owner decision 2026-10-29: M2M100 418M). */
export const TRANSLATE_MODEL_NAME = 'frameleaf-translate';

/** The worker cannot translate: no `/translate` route (an older worker), no runtime or no model. */
export class TranslationUnavailableError extends Error {}

/** A worker's `/translate` answer (machine-learning/frameleaf_ml/main.py). */
const translationResultSchema = z.object({
  model: z.string().max(128),
  translations: z.array(z.string().max(8192)).max(2000),
});

/** A translation answer above this is not caption text. */
const TRANSLATION_TOTAL_BYTES = 16 * 1024 * 1024;

/** The inpainting model the Clean Up Remove fill asks for: LaMa big-lama on the ML worker (owner decision 2026-10-08). */
export const INPAINT_MODEL_NAME = 'frameleaf-inpaint';

/** No local worker can fill an area: ML is off, remote-only, or its worker cannot get the inpainting model. */
export class InpaintUnavailableError extends Error {}

export class RestorationWorkerError extends Error {
  constructor(
    readonly code: RestorationWorkerErrorCode | 'unreachable' | 'protocol-error',
    readonly status: number | null,
    message: string,
    readonly modelId: string | null = null,
  ) {
    super(message);
    this.name = 'RestorationWorkerError';
  }
}

/** The same URL and credentials; endpoints are compared by value, never by object identity. */
export const sameEndpoint = (a: MlEndpoint | null, b: MlEndpoint | null) =>
  !!a && !!b && a.url === b.url && (a.authToken ?? null) === (b.authToken ?? null);

@Injectable()
export class MachineLearningRepository implements RestorationInference {
  private _config?: MachineLearningConfig;
  private desktopPoolSelector: DesktopPoolSelector | null = null;
  /** FL-159: the Frameleaf Cloud check, registered by the cloud processing service. */
  private cloudProber: CloudMlProber | null = null;
  private probeCache = new Map<
    string,
    { authToken?: string; authorityIdentity?: string; hardwareChecked: boolean; probe: MlEndpointProbe }
  >();
  private probesInFlight = new Map<string, Promise<MlEndpointProbe>>();

  private get config(): MachineLearningConfig {
    if (!this._config) {
      throw new Error('Machine learning repository not been setup');
    }

    return this._config;
  }

  constructor(
    private logger: LoggingRepository,
    private authority?: MlDestinationRepository,
    private configRepo?: ConfigRepository,
    private metadataRepo?: SystemMetadataRepository,
    private clipIndex?: DesktopClipIndexRepository,
  ) {
    this.logger.setContext(MachineLearningRepository.name);
  }

  private async authorize(endpoint: MlEndpoint) {
    await endpoint.assertAuthority?.();
    return this.authority?.assertEndpointAuthority(endpoint);
  }

  setup(config: MachineLearningConfig) {
    this._config = config;
    this.probeCache.clear();
  }

  /** The deployment's own ML URLs from the admin configuration; these back `local` destinations. */
  getLocalUrls(): string[] {
    return [...this.config.urls];
  }

  /** Semantic proposals are instance-local only, independent of Cloud destinations and routing. */
  async semanticMaskLocal(canvas: Buffer, target: 'subject' | 'sky', signal?: AbortSignal): Promise<Buffer> {
    if (!this.config.enabled) throw new Error('Local machine learning is disabled');
    const url = this.getLocalUrls()[0];
    if (this.configRepo && this.metadataRepo) {
      const current = await readConfig({
        configRepo: this.configRepo,
        metadataRepo: this.metadataRepo,
        logger: this.logger,
      });
      if (!current.machineLearning.enabled || !current.machineLearning.urls.includes(url)) throw recoveryMlRefusal();
    }
    await this.authorize({ url });
    if (!url || url === FRAMELEAF_CLOUD_ENDPOINT.url) throw new Error('Configure a local semantic mask worker');
    const endpoint = new URL('predict', url.endsWith('/') ? url : `${url}/`);
    if (!['http:', 'https:'].includes(endpoint.protocol) || /(^|\.)frameleaf\.(app|cloud)$/i.test(endpoint.hostname))
      throw new Error('Semantic masks require an instance-local worker');
    const form = new FormData();
    form.append(
      'entries',
      JSON.stringify({
        'semantic-mask': { visual: { modelName: 'frameleaf-florence2-sam2.1', options: { target } } },
      }),
    );
    form.append('image', new Blob([new Uint8Array(canvas)]));
    const deadline = AbortSignal.timeout(120_000);
    const response = await fetch(endpoint, {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
    });
    if (!response.ok) throw new Error(`Local semantic mask worker unavailable (${response.status})`);
    // Bound the streamed response before JSON/base64 allocation; never include media or model text in errors.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty local semantic mask result');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) throw new Error('Local semantic mask result is too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const result = z
      .object({
        'semantic-mask': z.object({
          png: z
            .string()
            .max(6 * 1024 * 1024)
            .regex(/^[A-Za-z0-9+/]+={0,2}$/),
          coordinates: z.literal('sensor-active'),
          width: z.int().min(1).max(2048),
          height: z.int().min(1).max(2048),
        }),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString()));
    await this.authorize({ url });
    return Buffer.from(result['semantic-mask'].png, 'base64');
  }

  /**
   * Clean Up Remove (native API): ask the instance-local ML worker to fill the masked part of `image`.
   * `image` is an RGB PNG of the area with surrounding context; `mask` a greyscale PNG of the same size,
   * white where content is removed. The worker answers `{ inpaint: { png, width, height } }` with an RGB
   * PNG of the same size. The worker serves it with LaMa (big-lama), fetched from the model source on first
   * use; a worker that cannot get the model answers 503 and an older one 422, which surface as
   * `InpaintUnavailableError`.
   */
  async inpaintLocal(image: Buffer, mask: Buffer, signal?: AbortSignal): Promise<Buffer> {
    if (!this.config.enabled) throw new InpaintUnavailableError('Local machine learning is disabled');
    const url = this.getLocalUrls()[0];
    if (this.configRepo && this.metadataRepo) {
      const current = await readConfig({
        configRepo: this.configRepo,
        metadataRepo: this.metadataRepo,
        logger: this.logger,
      });
      if (!current.machineLearning.enabled || !current.machineLearning.urls.includes(url)) throw recoveryMlRefusal();
    }
    await this.authorize({ url });
    if (!url || url === FRAMELEAF_CLOUD_ENDPOINT.url) throw new InpaintUnavailableError('No local inpainting worker');
    const endpoint = new URL('predict', url.endsWith('/') ? url : `${url}/`);
    if (!['http:', 'https:'].includes(endpoint.protocol) || /(^|\.)frameleaf\.(app|cloud)$/i.test(endpoint.hostname))
      throw new InpaintUnavailableError('Inpainting requires an instance-local worker');
    const form = new FormData();
    form.append('entries', JSON.stringify({ inpaint: { visual: { modelName: INPAINT_MODEL_NAME, options: {} } } }));
    form.append('image', new Blob([new Uint8Array(image)]));
    form.append('mask', new Blob([new Uint8Array(mask)]));
    const deadline = AbortSignal.timeout(120_000);
    const response = await fetch(endpoint, {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
    });
    if (!response.ok) {
      // an unknown task (422), a missing model (503) or no such route (404): nothing can fill today
      if ([404, 422, 501, 503].includes(response.status))
        throw new InpaintUnavailableError(`Local inpainting worker unavailable (${response.status})`);
      throw new Error(`Local inpainting worker failed (${response.status})`);
    }
    // Bound the streamed response before JSON/base64 allocation; never include media in errors.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty local inpainting result');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 24 * 1024 * 1024) throw new Error('Local inpainting result is too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const result = z
      .object({
        inpaint: z.object({
          png: z
            .string()
            .max(18 * 1024 * 1024)
            .regex(/^[A-Za-z0-9+/]+={0,2}$/),
          width: z.int().min(1).max(4096),
          height: z.int().min(1).max(4096),
        }),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString()));
    await this.authorize({ url });
    return Buffer.from(result.inpaint.png, 'base64');
  }

  /**
   * Studio captions (protocol 15.1): send one clip's audio, a 16 kHz mono 16-bit PCM WAV at `wavPath`, to
   * exactly the admitted local or LAN destination and read its `/transcribe` stream. `onSegment` is
   * called as each segment arrives, so the caller can report progress; aborting `signal` closes the
   * connection, which stops the worker at its next segment. Answers the stream's `info` and segments.
   */
  async transcriptionIdentity(selection: MlSelection): Promise<{ model: string; fingerprint: string }> {
    if (selection.endpoint.cloud) throw new TranscriptionUnavailableError('Speech requires a local or LAN worker');
    await this.authorize(selection.endpoint);
    const response = await fetch(new URL('transcribe/info', selection.endpoint.url), {
      headers: this.authHeaders(selection.endpoint),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new TranscriptionUnavailableError('The worker cannot report its speech model');
    }
    const identity = z
      .object({ model: z.string().max(128), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(await this.readDiagnosticJson(response));
    await this.authorize(selection.endpoint);
    return identity;
  }

  async transcribe(
    selection: MlSelection,
    wavPath: string,
    options: { language: string | null },
    signal: AbortSignal,
    onSegment: (segment: TranscriptSegment) => void,
  ): Promise<{ info: TranscriptInfo; segments: TranscriptSegment[] }> {
    if (selection.endpoint.cloud) {
      throw new CloudJobsUnavailableError(selection.workload);
    }
    const started = Date.now();
    const { size: bytesSent } = await stat(wavPath);
    let bytesReceived = 0;
    const record = (outcome: MlUsage['outcome']) =>
      selection.record({ bytesSent, bytesReceived, durationMs: Date.now() - started, outcome });
    const form = new FormData();
    const entryOptions = { wordTimestamps: true, ...(options.language && { language: options.language }) };
    form.append(
      'entries',
      JSON.stringify({ transcribe: { audio: { modelName: TRANSCRIBE_MODEL_NAME, options: entryOptions } } }),
    );
    form.append('audio', await openAsBlob(wavPath, { type: 'audio/wav' }), 'audio.wav');

    let info: TranscriptInfo | undefined;
    const segments: TranscriptSegment[] = [];
    try {
      await this.authorize(selection.endpoint);
      const response = await fetch(new URL('transcribe', selection.endpoint.url), {
        method: 'POST',
        headers: this.authHeaders(selection.endpoint),
        body: form,
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        if (response.status === 503) await this.checkWorkerCapacity(response);
        else await response.body?.cancel();
        // no such route (404), an older worker that does not know the task (422), no runtime or model (503)
        if ([404, 422, 501, 503].includes(response.status)) {
          throw new TranscriptionUnavailableError(`The worker cannot transcribe (${response.status})`);
        }
        throw new Error(`The transcription worker answered ${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('The transcription worker sent no answer');
      }
      let pending = Buffer.alloc(0);
      let finished = false;
      const handle = (line: Buffer) => {
        if (line.length > TRANSCRIPT_LINE_BYTES) throw new Error('A transcript line is too long');
        if (line.length === 0) {
          return;
        }
        const item = transcriptStreamItemSchema.parse(JSON.parse(line.toString('utf8')));
        switch (item.type) {
          case 'info': {
            info ??= item;

            break;
          }
          case 'segment': {
            if (!info) throw new Error('The transcription worker sent a segment before its info');
            segments.push(item);
            onSegment(item);

            break;
          }
          case 'error': {
            throw new Error(`The transcription worker failed: ${item.message}`);
          }
          default: {
            finished = true;
          }
        }
      };
      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesReceived += value.byteLength;
          if (bytesReceived > TRANSCRIPT_TOTAL_BYTES) throw new Error('The transcript is too large');
          pending = Buffer.concat([pending, value]);
          let newline = pending.indexOf(10);
          while (newline !== -1 && !finished) {
            handle(pending.subarray(0, newline));
            pending = pending.subarray(newline + 1);
            newline = pending.indexOf(10);
          }
          if (pending.length > TRANSCRIPT_LINE_BYTES) throw new Error('A transcript line is too long');
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!finished || !info) {
        throw new Error('The transcription worker stopped before it finished');
      }
      await this.authorize(selection.endpoint);
    } catch (error) {
      this.probeCache.delete(selection.endpoint.url);
      record('failure');
      throw error;
    }
    record('success');
    return { info, segments };
  }

  /**
   * Make a movie (FL-561): new music from `prompt` on the selected worker, written to `wavPath` as the
   * 16-bit mono WAV the worker sends. Only the prompt leaves this server. Progress is the worker's
   * decoder steps; aborting `signal` closes the connection, which stops the worker.
   */
  async generateMusic(
    selection: MlSelection,
    options: { prompt: string; durationSeconds: number; seed: number },
    wavPath: string,
    signal: AbortSignal,
    onProgress: (done: number, total: number) => void,
  ): Promise<{ seconds: number }> {
    if (selection.endpoint.cloud) {
      throw new CloudJobsUnavailableError(selection.workload);
    }
    const started = Date.now();
    let bytesReceived = 0;
    const record = (outcome: MlUsage['outcome']) =>
      selection.record({ bytesSent: 0, bytesReceived, durationMs: Date.now() - started, outcome });
    const form = new FormData();
    form.append(
      'entries',
      JSON.stringify({
        music: {
          audio: {
            modelName: MUSIC_MODEL_NAME,
            options: { prompt: options.prompt, duration: options.durationSeconds, seed: options.seed },
          },
        },
      }),
    );
    const file = await open(wavPath, 'w');
    let seconds: number | undefined;
    let finished = false;
    try {
      await this.authorize(selection.endpoint);
      const response = await fetch(new URL('music', selection.endpoint.url), {
        method: 'POST',
        headers: this.authHeaders(selection.endpoint),
        body: form,
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        if (response.status === 503) await this.checkWorkerCapacity(response);
        else await response.body?.cancel();
        // no such route (404), an older worker that does not know the task (422), no model (503)
        if ([404, 422, 501, 503].includes(response.status)) {
          throw new MusicUnavailableError(`The worker cannot make music (${response.status})`);
        }
        throw new Error(`The music worker answered ${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('The music worker sent no answer');
      }
      let pending = Buffer.alloc(0);
      const handle = async (line: Buffer) => {
        if (line.length > MUSIC_LINE_BYTES * 2) throw new Error('A music line is too long');
        if (line.length === 0) {
          return;
        }
        const item = musicStreamItemSchema.parse(JSON.parse(line.toString('utf8')));
        switch (item.type) {
          case 'progress': {
            onProgress(item.done, item.total);
            break;
          }
          case 'info': {
            seconds = item.seconds;
            break;
          }
          case 'audio': {
            if (seconds === undefined) throw new Error('The music worker sent audio before its info');
            await file.write(Buffer.from(item.data, 'base64'));
            break;
          }
          case 'error': {
            throw new Error(`The music worker failed: ${item.message}`);
          }
          default: {
            finished = true;
          }
        }
      };
      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesReceived += value.byteLength;
          if (bytesReceived > MUSIC_TOTAL_BYTES) throw new Error('The music is too large');
          pending = Buffer.concat([pending, value]);
          let newline = pending.indexOf(10);
          while (newline !== -1 && !finished) {
            await handle(pending.subarray(0, newline));
            pending = pending.subarray(newline + 1);
            newline = pending.indexOf(10);
          }
          if (pending.length > MUSIC_LINE_BYTES * 2) throw new Error('A music line is too long');
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!finished || seconds === undefined) {
        throw new Error('The music worker stopped before it finished');
      }
    } catch (error) {
      if (!(error instanceof MusicUnavailableError)) {
        this.probeCache.delete(selection.endpoint.url);
      }
      record('failure');
      throw error;
    } finally {
      await file.close();
    }
    record('success');
    return { seconds };
  }

  /**
   * Studio captions in other languages (FL-641): send caption lines, as text only, to exactly the admitted
   * local or home-network worker and read one translation per line, in order. Nothing else of the project
   * leaves this server.
   */
  async translateCaptions(
    selection: MlSelection,
    options: { source: string; target: string; lines: readonly string[] },
    signal: AbortSignal,
  ): Promise<{ model: string; translations: string[] }> {
    if (selection.endpoint.cloud) {
      throw new CloudJobsUnavailableError(selection.workload);
    }
    const started = Date.now();
    const body = JSON.stringify(options.lines);
    let bytesReceived = 0;
    const record = (outcome: MlUsage['outcome']) =>
      selection.record({
        bytesSent: Buffer.byteLength(body),
        bytesReceived,
        durationMs: Date.now() - started,
        outcome,
      });
    const form = new FormData();
    form.append(
      'entries',
      JSON.stringify({
        translate: {
          textual: { modelName: TRANSLATE_MODEL_NAME, options: { source: options.source, target: options.target } },
        },
      }),
    );
    form.append('lines', body);
    let result: z.infer<typeof translationResultSchema>;
    try {
      await this.authorize(selection.endpoint);
      const response = await fetch(new URL('translate', selection.endpoint.url), {
        method: 'POST',
        headers: this.authHeaders(selection.endpoint),
        body: form,
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        if (response.status === 503) await this.checkWorkerCapacity(response);
        else await response.body?.cancel();
        // no such route (404), an older worker that does not know the task (422), no runtime or model (503)
        if ([404, 422, 501, 503].includes(response.status)) {
          throw new TranslationUnavailableError(`The worker cannot translate (${response.status})`);
        }
        throw new Error(`The translation worker answered ${response.status}`);
      }
      // Bound the answer while it is read, before any JSON allocation.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('The translation worker sent no answer');
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesReceived += value.byteLength;
          if (bytesReceived > TRANSLATION_TOTAL_BYTES) throw new Error('The translation is too large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      result = translationResultSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (result.translations.length !== options.lines.length) {
        throw new Error('The translation worker did not answer every line');
      }
      await this.authorize(selection.endpoint);
    } catch (error) {
      if (!(error instanceof TranslationUnavailableError)) {
        this.probeCache.delete(selection.endpoint.url);
      }
      record('failure');
      throw error;
    }
    record('success');
    return result;
  }

  /** FL-159: register the Frameleaf Cloud check that `probe` delegates to for the cloud destination. */
  setCloudProber(prober: CloudMlProber | null) {
    this.cloudProber = prober;
  }

  private refuseBusyWorker() {
    deferJobUntilDependency('destination-capacity');
    throw new ServiceUnavailableException('Machine learning worker is busy; try again shortly');
  }

  private async checkWorkerCapacity(response: Response) {
    const body = await this.readDiagnosticJson(response).catch(() => null);
    if (z.object({ detail: z.literal('ml_worker_busy') }).safeParse(body).success) this.refuseBusyWorker();
  }

  private authHeaders(endpoint: MlEndpoint): Record<string, string> {
    return endpoint.authToken ? { Authorization: `Bearer ${endpoint.authToken}` } : {};
  }

  private timeout(): number {
    return this.config.availabilityChecks.timeout;
  }

  /**
   * Check one endpoint: `/ping` for reachability, `/capabilities` for the workloads it
   * serves and `/hardware` for its acceleration. A result younger than `maxAgeMs` is
   * reused so a burst of jobs does not turn into a burst of probes.
   */
  async probe(
    endpoint: MlEndpoint,
    { maxAgeMs = 0, includeHardware = true }: { maxAgeMs?: number; includeHardware?: boolean } = {},
  ): Promise<MlEndpointProbe> {
    const authorityIdentity = await this.authorize(endpoint);
    if (endpoint.cloud) {
      if (!this.cloudProber) {
        return {
          reachable: false,
          workloads: [],
          hardware: null,
          latencyMs: 0,
          probedAt: new Date(),
          error: 'Frameleaf Cloud processing is not available on this server',
          cloud: null,
        };
      }
      const result = await this.cloudProber({ maxAgeMs });
      await this.authorize(endpoint);
      return result;
    }

    const cached = this.probeCache.get(endpoint.url);
    if (
      cached &&
      (!includeHardware || cached.hardwareChecked) &&
      cached.authToken === endpoint.authToken &&
      cached.authorityIdentity === authorityIdentity &&
      maxAgeMs > 0 &&
      Date.now() - cached.probe.probedAt.getTime() < maxAgeMs
    ) {
      return cached.probe;
    }

    const key = JSON.stringify([endpoint.url, endpoint.authToken, authorityIdentity, includeHardware]);
    let operation = this.probesInFlight.get(key);
    if (!operation) {
      operation = this.probeLocal(endpoint, authorityIdentity, includeHardware);
      this.probesInFlight.set(key, operation);
    }
    try {
      const result = await operation;
      // Sharing a network observation never shares another caller's permission to use it.
      if ((await this.authorize(endpoint)) !== authorityIdentity) throw recoveryMlRefusal();
      return result;
    } finally {
      if (this.probesInFlight.get(key) === operation) this.probesInFlight.delete(key);
    }
  }

  private async probeLocal(
    endpoint: MlEndpoint,
    authorityIdentity: string | undefined,
    includeHardware: boolean,
  ): Promise<MlEndpointProbe> {
    const timeout = Math.min(5000, Math.max(250, this.timeout()));
    const started = Date.now();
    const probedAt = new Date(started);
    const finish = async (probe: Omit<MlEndpointProbe, 'latencyMs' | 'probedAt'>): Promise<MlEndpointProbe> => {
      if ((await this.authorize(endpoint)) !== authorityIdentity) throw recoveryMlRefusal();
      const result = { ...probe, latencyMs: Date.now() - started, probedAt };
      this.probeCache.set(endpoint.url, {
        authToken: endpoint.authToken,
        authorityIdentity,
        hardwareChecked: includeHardware,
        probe: result,
      });
      return result;
    };
    const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

    try {
      await this.authorize(endpoint);
      const ping = await fetch(new URL('ping', endpoint.url), {
        headers: this.authHeaders(endpoint),
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
      await ping.body?.cancel();
      if (!ping.ok) {
        return finish({ reachable: false, workloads: [], hardware: null, error: `ping returned ${ping.status}` });
      }
    } catch (error) {
      return finish({ reachable: false, workloads: [], hardware: null, error: describe(error) });
    }

    let workloads: MlWorkload[];
    try {
      await this.authorize(endpoint);
      const response = await fetch(new URL('capabilities', endpoint.url), {
        headers: this.authHeaders(endpoint),
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
      if (response.ok) {
        const body = (await this.readDiagnosticJson(response)) as CapabilitiesResponse;
        workloads = Array.isArray(body.workloads) ? body.workloads.filter(isMlWorkload) : [];
      } else if (response.status === 404) {
        await response.body?.cancel();
        workloads = [...LIBRARY_ML_WORKLOADS];
      } else {
        await response.body?.cancel();
        return finish({
          reachable: true,
          workloads: [],
          hardware: null,
          error: `capabilities returned ${response.status}`,
        });
      }
    } catch (error) {
      return finish({ reachable: true, workloads: [], hardware: null, error: describe(error) });
    }

    let hardware: MachineLearningHardwareResponse | null = null;
    if (includeHardware) {
      try {
        await this.authorize(endpoint);
        const response = await fetch(new URL('hardware', endpoint.url), {
          headers: this.authHeaders(endpoint),
          signal: AbortSignal.timeout(timeout),
          redirect: 'error',
        });
        if (response.ok) {
          hardware = diagnosticHardwareSchema.parse(await this.readDiagnosticJson(response));
        } else {
          await response.body?.cancel();
        }
      } catch {
        // Hardware is informational; a worker without the route is still admissible.
      }
    }

    // FL-42: a worker's own `/capabilities` list is a diagnostic claim, not admission proof. A
    // restoration workload counts only when the worker's model report backs it with a model that is
    // available, has verified weights (a fingerprint) and a qualification record. Otherwise the claim
    // is dropped and admission refuses the workload as not served.
    if (workloads.some((workload) => RESTORATION_WORKLOAD_SET.has(workload))) {
      const verified = await this.verifiedRestorationWorkloads(endpoint);
      workloads = workloads.filter((workload) => !RESTORATION_WORKLOAD_SET.has(workload) || verified.has(workload));
    }

    return finish({ reachable: true, workloads, hardware, error: null });
  }

  /** Restoration workloads backed by an available, weight-verified and qualified model (FL-42). */
  private async verifiedRestorationWorkloads(endpoint: MlEndpoint): Promise<Set<MlWorkload>> {
    try {
      const report = await this.getRestorationModels(endpoint);
      return new Set(
        report.models
          .filter(
            (model) =>
              model.state === RestorationModelState.Available && !!model.fingerprint && !!model.qualificationId,
          )
          .map((model) => workloadForMode(model.mode)),
      );
    } catch {
      return new Set();
    }
  }

  private async readDiagnosticJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Missing diagnostic response');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > 32 * 1024) {
          throw new Error('Diagnostic response exceeds 32 KiB');
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  private redact(config: MachineLearningRequest): string {
    // Redact assembled prompt text to avoid leaking identity hints and admin-configured
    // vocabulary into logs, while preserving model name and acceleration for debugging.
    const sanitizedConfig = JSON.parse(JSON.stringify(config));
    for (const task of Object.values<any>(sanitizedConfig)) {
      for (const entry of Object.values<any>(task ?? {})) {
        if (entry?.options?.external_prompt !== undefined) {
          entry.options.external_prompt = '[redacted]';
        }
      }
    }
    return JSON.stringify(sanitizedConfig);
  }

  /**
   * Send one request to the selected endpoint and nothing else. A failure is reported to
   * the caller naming the destination; it is never retried against another URL, because
   * the destination was the caller's explicit choice and moving the media elsewhere would
   * silently change where it goes.
   */
  private async predict<T>(
    selection: MlSelection,
    payload: ModelPayload,
    config: MachineLearningRequest,
    bound?: { binding: Record<string, unknown>; parse: (value: unknown) => T; path?: 'predict-face-bound' },
  ): Promise<T> {
    if (selection.desktopClip || selection.desktopOcr || selection.desktopFace)
      throw new Error('desktop_bound_profile_required');
    if (selection.endpoint.cloud) {
      throw new CloudJobsUnavailableError(selection.workload);
    }
    const formData = await this.getFormData(payload, config);
    if (bound) {
      formData.set('binding', JSON.stringify(bound.binding));
      const input = formData.get('image') ?? formData.get('text');
      const size = input instanceof Blob ? input.size : Buffer.byteLength(input ?? '');
      if (!size || size > 16 * 1024 * 1024) throw new Error('producer_input_invalid');
    }
    const bytesSent = await this.measure(payload);
    const started = Date.now();
    const usage = (outcome: MlUsage['outcome'], bytesReceived: number): MlUsage => ({
      bytesSent,
      bytesReceived,
      durationMs: Date.now() - started,
      outcome,
    });
    const target = `${selection.kind} destination ${selection.destinationId}`;

    let response: Response;
    let body: string;
    try {
      await this.authorize(selection.endpoint);
      ({ response, body } = await fetchJobText(
        new URL(bound?.path ?? (bound ? 'predict-bound' : 'predict'), selection.endpoint.url),
        {
          method: 'POST',
          headers: this.authHeaders(selection.endpoint),
          body: formData,
          redirect: 'error',
        },
        undefined,
        bound ? 4 * 1024 * 1024 : undefined,
      ));
      await this.authorize(selection.endpoint);
    } catch (error: Error | unknown) {
      this.probeCache.delete(selection.endpoint.url);
      selection.record(usage('failure', 0));
      throw new Error(
        `Machine learning request '${this.redact(config)}' to ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (!response.ok) {
      selection.record(usage('failure', body.length));
      if (response.status === 503) {
        let detail: unknown;
        try {
          detail = JSON.parse(body)?.detail;
        } catch {
          // Unknown errors retain the ordinary failure path.
        }
        if (detail === 'ml_worker_busy') this.refuseBusyWorker();
      }
      throw new Error(
        `Machine learning request '${this.redact(config)}' to ${target} failed with status ${response.status}: ${response.statusText}`,
      );
    }

    if (bound) {
      let result: T;
      try {
        result = bound.parse(JSON.parse(body));
      } catch {
        selection.record(usage('failure', body.length));
        throw new Error('producer_result_invalid');
      }
      selection.record(usage('success', body.length));
      return result;
    }
    selection.record(usage('success', body.length));
    return JSON.parse(body) as T;
  }

  private async measure(payload: ModelPayload): Promise<number> {
    if ('imagePath' in payload) {
      const { size } = await stat(payload.imagePath);
      return size;
    }
    return Buffer.byteLength(payload.text);
  }

  async detectBoundFaces(selection: MlSelection, imagePath: string, profile: DesktopModelProfile) {
    if (
      selection.workload !== MlWorkload.Face ||
      profile.workload !== 'face' ||
      profile.embeddingDimensions !== 512 ||
      profile.spec.fixtureKind !== 'image' ||
      profile.modelKey !== profile.spec.modelKey
    )
      throw new Error('producer_input_invalid');
    const { protocolVersion, modelKey, entries, models, preprocessingSha256 } = profile.spec;
    return this.predict(selection, { imagePath }, entries as MachineLearningRequest, {
      path: 'predict-face-bound',
      binding: { protocolVersion, modelKey, entries, models, preprocessingSha256 },
      parse: (value) => {
        const response = z
          .strictObject({
            protocolVersion: z.literal(1),
            modelKey: z.literal(profile.modelKey),
            preprocessingSha256: z.literal(profile.spec.preprocessingSha256),
            result: z.unknown(),
          })
          .parse(value);
        return parseBoundFaceResult(response.result);
      },
    });
  }

  async detectFaces(selection: MlSelection, imagePath: string, { modelName, minScore }: FaceDetectionOptions) {
    const request = faceEntries({ modelName, minScore });
    let response: FacialRecognitionResponse;
    if (selection.desktopFace) {
      const size = await this.measure({ imagePath });
      if (!size || size > 16 * 1024 * 1024) throw new Error('desktop_input_size_invalid');
      const started = Date.now();
      let received = 0;
      let outcome: 'success' | 'failure' = 'failure';
      try {
        const result = await selection.desktopFace({ imagePath }, request);
        response = parseBoundFaceResult(result);
        received = Buffer.byteLength(JSON.stringify(result));
        outcome = 'success';
      } finally {
        selection.record({ bytesSent: size, bytesReceived: received, durationMs: Date.now() - started, outcome });
      }
    } else response = await this.predict<FacialRecognitionResponse>(selection, { imagePath }, request);
    return {
      imageHeight: response.imageHeight,
      imageWidth: response.imageWidth,
      faces: response[ModelTask.FACIAL_RECOGNITION],
    };
  }

  setDesktopPoolSelector(selector: DesktopPoolSelector | null) {
    this.desktopPoolSelector = selector;
  }

  async selectBackgroundPool(
    selection: MlSelection,
    jobId?: string | null,
    requireReady = false,
  ): Promise<MlSelection> {
    if (!queueExecution.getStore() || ![MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Face].includes(selection.workload))
      return selection;
    if (!this.desktopPoolSelector) throw new Error('desktop_pool_authority_unavailable');
    const ocr = selection.workload === MlWorkload.Ocr ? structuredClone(this.config.ocr) : undefined;
    const face = selection.workload === MlWorkload.Face ? structuredClone(this.config.facialRecognition) : undefined;
    const modelName = face?.modelName ?? ocr?.modelName ?? this.config.clip.modelName;
    return this.desktopPoolSelector(selection, {
      jobId,
      ...(requireReady && { requireReady }),
      modelName,
      ...(ocr && { ocr }),
      ...(face && { face }),
      assertConfig: (tx?: Transaction<DB>) =>
        face
          ? this.assertDesktopFaceConfig(selection, faceEntries(face), tx, face)
          : ocr
            ? this.assertDesktopOcrConfig(selection, ocrEntries(ocr), tx, ocr)
            : this.assertDesktopPoolConfig(selection, modelName, tx),
    });
  }

  async assertDesktopPoolConfig(
    selection: Pick<MlSelection, 'kind' | 'endpoint'>,
    modelName: string,
    tx?: Transaction<DB>,
  ): Promise<void> {
    const current =
      this.configRepo && this.metadataRepo
        ? (
            await readConfig({
              configRepo: this.configRepo,
              metadataRepo: tx ? new SystemMetadataRepository(tx) : this.metadataRepo,
              logger: this.logger,
            })
          ).machineLearning
        : this.config;
    if (
      !current.enabled ||
      !current.clip.enabled ||
      current.clip.modelName !== modelName ||
      (selection.kind === MlDestinationKind.Local && !current.urls.includes(selection.endpoint.url))
    )
      throw new Error('desktop_pool_config_changed');
  }

  async assertDesktopOcrConfig(
    selection: Pick<MlSelection, 'kind' | 'endpoint'>,
    entries: unknown,
    tx?: Transaction<DB>,
    expected?: MachineLearningConfig['ocr'],
  ): Promise<void> {
    const current =
      this.configRepo && this.metadataRepo
        ? (
            await readConfig({
              configRepo: this.configRepo,
              metadataRepo: tx ? new SystemMetadataRepository(tx) : this.metadataRepo,
              logger: this.logger,
            })
          ).machineLearning
        : this.config;
    if (
      !current.enabled ||
      !current.ocr.enabled ||
      canonicalJson(ocrEntries(current.ocr)) !== canonicalJson(entries) ||
      (expected && canonicalJson(current.ocr) !== canonicalJson(expected)) ||
      (selection.kind === MlDestinationKind.Local && !current.urls.includes(selection.endpoint.url))
    )
      throw new Error('desktop_pool_config_changed');
  }

  async assertDesktopFaceConfig(
    selection: Pick<MlSelection, 'kind' | 'endpoint'>,
    entries: unknown,
    tx?: Transaction<DB>,
    expected?: MachineLearningConfig['facialRecognition'],
  ): Promise<void> {
    const current =
      this.configRepo && this.metadataRepo
        ? (
            await readConfig({
              configRepo: this.configRepo,
              metadataRepo: tx ? new SystemMetadataRepository(tx) : this.metadataRepo,
              logger: this.logger,
            })
          ).machineLearning
        : this.config;
    if (
      !current.enabled ||
      !current.facialRecognition.enabled ||
      canonicalJson(faceEntries(current.facialRecognition)) !== canonicalJson(entries) ||
      (expected && canonicalJson(current.facialRecognition) !== canonicalJson(expected)) ||
      (selection.kind === MlDestinationKind.Local && !current.urls.includes(selection.endpoint.url))
    )
      throw new Error('desktop_pool_config_changed');
  }

  async captureClipRead() {
    if (this.clipIndex) return this.clipIndex.captureRead();
    return {
      assertCurrent: () => Promise.resolve(),
      publish: <T>(write: () => Promise<T>) => write(),
    };
  }

  async clipCacheKey(modelName: string, language?: string): Promise<string> {
    const selected = await this.clipIndex?.selectProfile(modelName, 'text', language);
    return selected ? `${selected.binding.revisionId}:${selected.profile.modelKey}` : 'legacy';
  }

  async assertClipModel(modelName: string): Promise<void> {
    await this.clipIndex?.selectProfile(modelName, 'image');
  }

  async encodeImage(selection: MlSelection, imagePath: string, { modelName }: MachineLearningConfig['clip']) {
    const selected = await this.clipIndex?.selectProfile(modelName, 'image');
    if (selected) {
      const result = await this.encodeBoundClip(selection, { imagePath }, selected.profile);
      await this.clipIndex!.assertCurrent(selected.binding);
      return result;
    }
    const request = { [ModelTask.SEARCH]: { [ModelType.VISUAL]: { modelName } } };
    const response = await this.predict<ClipVisualResponse>(selection, { imagePath }, request);
    if (await this.clipIndex?.getActive()) throw new Error('desktop_clip_index_changed');
    return response[ModelTask.SEARCH];
  }

  async encodeBoundClip(selection: MlSelection, payload: ModelPayload, profile: DesktopModelProfile) {
    const image = 'imagePath' in payload;
    if (
      ![MlWorkload.Clip, MlWorkload.PetRecognition].includes(selection.workload) ||
      image === 'text' in payload ||
      image !== (profile.spec.fixtureKind === 'image') ||
      profile.modelKey !== profile.spec.modelKey
    )
      throw new Error('producer_input_invalid');
    const size = await this.measure(payload);
    if (!size || size > 16 * 1024 * 1024) throw new Error('producer_input_invalid');
    const { protocolVersion, modelKey, entries, models, preprocessingSha256 } = profile.spec;
    const parse = (value: unknown) => {
      const parsed = z
        .strictObject({
          protocolVersion: z.literal(1),
          modelKey: z.literal(profile.modelKey),
          preprocessingSha256: z.literal(profile.spec.preprocessingSha256),
          result: z.unknown(),
        })
        .parse(value);
      return parseBoundClipResult(parsed.result, profile);
    };
    if (selection.desktopClip) {
      const started = Date.now();
      let received = 0;
      let outcome: 'success' | 'failure' = 'failure';
      try {
        const result = await selection.desktopClip(payload, profile);
        received = Buffer.byteLength(JSON.stringify(result));
        const value = parse({ protocolVersion, modelKey, preprocessingSha256, result });
        outcome = 'success';
        return value;
      } finally {
        selection.record({ bytesSent: size, bytesReceived: received, durationMs: Date.now() - started, outcome });
      }
    }
    return this.predict(selection, payload, entries as MachineLearningRequest, {
      binding: { protocolVersion, modelKey, entries, models, preprocessingSha256 },
      parse,
    });
  }

  async encodeText(selection: MlSelection, text: string, options: TextEncodingOptions) {
    const result = await this.encodeTextWithProvenance(selection, text, options);
    return typeof result === 'string' ? result : result.embedding;
  }

  async encodeTextWithProvenance(selection: MlSelection, text: string, { language, modelName }: TextEncodingOptions) {
    // FL-455: search text is always encoded on this network, never on Frameleaf Cloud
    if (selection.endpoint.cloud) {
      throw new CloudJobsUnavailableError('search text');
    }
    const selected = await this.clipIndex?.selectProfile(modelName, 'text', language);
    if (selected) {
      const result = await this.encodeBoundClip(selection, { text }, selected.profile);
      await this.clipIndex!.assertCurrent(selected.binding);
      return result;
    }
    const request = { [ModelTask.SEARCH]: { [ModelType.TEXTUAL]: { modelName, options: { language } } } };
    const response = await this.predict<ClipTextualResponse>(selection, { text }, request);
    if (await this.clipIndex?.getActive()) throw new Error('desktop_clip_index_changed');
    return response[ModelTask.SEARCH];
  }

  async ocr(
    selection: MlSelection,
    imagePath: string,
    { modelName, minDetectionScore, minRecognitionScore, maxResolution }: OcrOptions,
  ) {
    const request = ocrEntries({ modelName, minDetectionScore, minRecognitionScore, maxResolution });
    if (selection.desktopOcr) {
      const started = Date.now();
      const size = await this.measure({ imagePath });
      if (!size || size > 16 * 1024 * 1024) throw new Error('desktop_input_size_invalid');
      let received = 0;
      let outcome: 'success' | 'failure' = 'failure';
      try {
        const result = await selection.desktopOcr({ imagePath }, request);
        const response = parseBoundOcrResult(result);
        received = Buffer.byteLength(JSON.stringify(result));
        outcome = 'success';
        return response.ocr;
      } finally {
        selection.record({ bytesSent: size, bytesReceived: received, durationMs: Date.now() - started, outcome });
      }
    }
    const response = await this.predict<OcrResponse>(selection, { imagePath }, request);
    return response[ModelTask.OCR];
  }

  async describeImage(
    selection: MlSelection,
    imagePath: string,
    options: ImageDescriptionOptions,
    nsfw?: NsfwDetectionResult,
    prompt?: string,
  ) {
    return (await this.describeImageRun(selection, imagePath, options, nsfw, prompt)).result;
  }

  /**
   * `describeImage`, also saying which model answered (the configured one or its fallback) and
   * where the worker ran it, for the hardware benchmark (FL-427).
   */
  async describeImageRun(
    selection: MlSelection,
    imagePath: string,
    { modelName, acceleration, fallbackModelName, device }: ImageDescriptionOptions,
    nsfw?: NsfwDetectionResult,
    prompt?: string,
  ): Promise<ImageDescriptionRun> {
    const buildRequest = (effectiveModelName: string) => ({
      [ModelTask.IMAGE_DESCRIPTION]: {
        [ModelType.VISUAL]: {
          modelName: effectiveModelName,
          options: { acceleration, device, nsfw, external_prompt: prompt },
        },
      },
    });

    // The fallback model is retried on the same destination only, and never on a cloud
    // destination: the admin picked one primary model for cloud work. Florence runs on torch, which
    // the CPU and CUDA images ship and the OpenVINO image doesn't; on a CPU-only worker it is the
    // only description model that loads.
    const florenceUnavailable =
      acceleration === MachineLearningHardwareAcceleration.OpenVino &&
      !!fallbackModelName &&
      isFlorenceImageDescriptionModel(fallbackModelName);
    // A Frameleaf Cloud job names only the cloud model admission resolved (the routed SKU or the
    // catalogue's default, FL-183), never the local description setting (FL-146) or a model name.
    if (selection.kind === MlDestinationKind.FrameleafCloud) {
      if (!selection.cloudModelId) {
        throw new CloudJobsUnavailableError(selection.workload);
      }
      const body = await this.predict<ImageDescriptionResponse>(
        selection,
        { imagePath },
        buildRequest(selection.cloudModelId),
      );
      return describedBy(body[ModelTask.IMAGE_DESCRIPTION], selection.cloudModelId);
    }
    const candidateModels: string[] = [modelName];
    if (fallbackModelName && fallbackModelName !== modelName && !florenceUnavailable) {
      candidateModels.push(fallbackModelName);
    }

    let lastError: unknown;
    for (const candidateModel of candidateModels) {
      try {
        const body = await this.predict<ImageDescriptionResponse>(
          selection,
          { imagePath },
          buildRequest(candidateModel),
        );
        if (candidateModel !== modelName) {
          this.logger.warn(
            `Image description model '${modelName}' failed on destination ${selection.destinationId}; succeeded with fallback model '${candidateModel}'`,
          );
        }
        return describedBy(body[ModelTask.IMAGE_DESCRIPTION], candidateModel);
      } catch (error) {
        if (error instanceof JobDependencyUnavailable || error instanceof ServiceUnavailableException) throw error;
        lastError = error;
        this.logger.warn(
          `Image description request to destination ${selection.destinationId} (model='${candidateModel}') failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async detectNsfw(selection: MlSelection, imagePath: string, { modelName, threshold, device }: NsfwDetectionOptions) {
    const request = {
      [ModelTask.NSFW_DETECTION]: {
        [ModelType.CLASSIFICATION]: { modelName, options: { threshold, device } },
      },
    };
    const response = await this.predict<NsfwDetectionResponse>(selection, { imagePath }, request);
    return response[ModelTask.NSFW_DETECTION];
  }

  /**
   * What a restoration worker reports about its models (FL-114): each model's state, every
   * reason it is unavailable and the throughput its qualification measured. Metadata only; no
   * media is sent. Workload names the server does not know are dropped.
   */
  async getRestorationModels(endpoint: MlEndpoint): Promise<RestorationCapabilityReport> {
    await this.authorize(endpoint);
    if (endpoint.cloud) {
      throw new Error('Frameleaf Cloud models come from its catalogue, not a restoration worker');
    }
    const response = await fetch(new URL('restoration/models', endpoint.url), {
      headers: this.authHeaders(endpoint),
      signal: AbortSignal.timeout(this.timeout()),
      redirect: 'error',
    });
    if (response.status === 404) {
      throw new Error('the destination does not run the restoration worker');
    }
    if (!response.ok) {
      throw new Error(`restoration models returned ${response.status}`);
    }
    const report = RestorationCapabilityReportSchema.parse(await response.json());
    await this.authorize(endpoint);
    return { ...report, workloads: report.workloads.filter(isMlWorkload) };
  }

  /**
   * Run one restoration inference on the selected destination (FL-114). This is the
   * `RestorationInference` FL-115's restoration worker calls for every still, preview clip and
   * video chunk.
   *
   * The selection must come from `selectRestorationDestination` (`src/utils/restoration.ts`):
   * anything else is refused, and a cloud destination is refused unless the person confirmed
   * it for this request. The source is only read, and FL-115 uploads only the crop, clip or
   * chunk the job needs. The restored file is a new file: `outputPath` is created exclusively,
   * so an existing file (the original included) can never be replaced, and it is kept only
   * when its size and sha256 match the worker's result. A failure names the destination and is
   * never retried anywhere else.
   */
  async restore(
    selection: RestorationSelection,
    input: RestorationInferenceInput,
    options: RestorationInferenceOptions,
  ): Promise<RestorationInferenceResult> {
    const admission = restorationAdmissionOf(selection);
    if (!admission) {
      throw new Error('A restoration runs only on a destination admitted by selectRestorationDestination');
    }
    const expected = workloadForMode(options.mode);
    if (selection.workload !== expected) {
      throw new Error(`A ${options.mode} restoration needs a ${expected} selection, not ${selection.workload}`);
    }
    if (selection.endpoint.cloud) {
      throw new CloudJobsUnavailableError(selection.workload);
    }
    if (CLOUD_ML_DESTINATION_KINDS.has(selection.kind) && !admission.cloudUploadConfirmed) {
      throw new Error(`Restoration on ${selection.kind} needs the person's confirmation that media leaves the network`);
    }

    const sourcePath = input.path;
    const outputPath = options.outputPath;
    if (resolve(sourcePath) === resolve(outputPath)) {
      throw new Error('A restoration never writes over its source');
    }

    const payload = RestorationWorkerRequestSchema.parse({
      protocol: RESTORATION_PROTOCOL,
      requestId: `${options.jobId}:${basename(outputPath)}`.slice(0, 200),
      mode: options.mode,
      // FL-423: the chosen model, which the worker runs exactly or refuses; left out, the worker chooses
      ...(options.modelId && { modelId: options.modelId }),
      kind: input.kind,
      scale: options.upscale,
      maxWidth: Math.min(options.maxWidth, RESTORATION_MAX_OUTPUT_EDGE),
      maxHeight: Math.min(options.maxHeight, RESTORATION_MAX_OUTPUT_EDGE),
      keepGrain: options.keepGrain,
      seed: 0,
      source: {
        width: input.width,
        height: input.height,
        durationMs: input.kind === 'video' ? Math.max(1, Math.round(input.durationSeconds * 1000)) : null,
      },
      // FL-162 Smooth motion on a local or LAN restoration worker (RIFE)
      ...(options.interpolationFactor && {
        interpolationFactor: options.interpolationFactor,
        trailingContextFrame: options.trailingContextFrame ?? false,
      }),
    });

    // Exclusive create: fails when anything already exists at the path.
    const output = await open(outputPath, 'wx');
    const target = `${selection.kind} destination ${selection.destinationId}`;
    const body = JSON.stringify(payload);
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(RESTORATION_REQUEST_TIMEOUT_MS)]);
    const started = Date.now();
    let attempted = false;
    let keep = false;
    let bytesSent = 0;
    let bytesReceived = 0;
    let response: Response | undefined;

    try {
      // A file-backed Blob streams the source instead of reading a whole video into memory.
      // At runtime it is the global Blob; the cast only bridges the node and DOM typings.
      const media = await openAsBlob(sourcePath);
      bytesSent = media.size + Buffer.byteLength(body);
      const form = new FormData();
      form.append('request', body);
      form.append('media', media as unknown as Blob, basename(sourcePath));

      attempted = true;
      try {
        await this.authorize(selection.endpoint);
        response = await fetch(new URL('restoration/restore', selection.endpoint.url), {
          method: 'POST',
          headers: this.authHeaders(selection.endpoint),
          body: form,
          signal,
          redirect: 'error',
        });
      } catch (error) {
        this.probeCache.delete(selection.endpoint.url);
        throw new RestorationWorkerError(
          'unreachable',
          null,
          `Restoration ${payload.requestId} to ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!response.ok) {
        const text = await response.text();
        bytesReceived = Buffer.byteLength(text);
        const refusal = RestorationWorkerErrorSchema.safeParse(this.parseJson(text));
        if (refusal.success) {
          throw new RestorationWorkerError(
            refusal.data.code,
            response.status,
            `Restoration ${payload.requestId} on ${target} was refused (${refusal.data.code}): ${refusal.data.message}`,
            refusal.data.modelId ?? null,
          );
        }
        throw new RestorationWorkerError(
          'protocol-error',
          response.status,
          `Restoration ${payload.requestId} on ${target} failed with status ${response.status}`,
        );
      }

      const result = this.parseRestorationResult(response, payload, target);
      if (!response.body) {
        throw new RestorationWorkerError('protocol-error', response.status, `Restoration ${target} sent no file`);
      }

      const hash = createHash('sha256');
      await pipeline(
        Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
        async function* (chunks: AsyncIterable<Uint8Array>) {
          for await (const chunk of chunks) {
            hash.update(chunk);
            bytesReceived += chunk.length;
            yield chunk;
          }
        },
        // The stream closes the handle when it finishes or fails. With `autoClose: false` the
        // `close()` in `finally` never settled after a completed write, and the restoration hung.
        output.createWriteStream(),
      );

      const sha256 = hash.digest('hex');
      if (bytesReceived !== result.output.bytes || sha256 !== result.output.sha256) {
        throw new RestorationWorkerError(
          'protocol-error',
          response.status,
          `Restoration ${payload.requestId} from ${target} failed verification: received ${bytesReceived} bytes ` +
            `hashing to ${sha256}; the worker reported ${result.output.bytes} bytes hashing to ${result.output.sha256}`,
          result.model.id,
        );
      }

      await this.authorize(selection.endpoint);
      keep = true;
      selection.record({ bytesSent, bytesReceived, durationMs: Date.now() - started, outcome: 'success' });
      return {
        outputPath,
        width: result.output.width,
        height: result.output.height,
        modelName: result.model.id,
        // The pinned revision plus the start of the fingerprint over it and every weight hash.
        modelVersion: `${result.model.revision.slice(0, 12)}+${result.model.fingerprint.slice(0, 12)}`,
      };
    } catch (error) {
      if (response?.body && !response.bodyUsed) {
        await response.body.cancel().catch(() => {});
      }
      if (attempted) {
        selection.record({ bytesSent, bytesReceived, durationMs: Date.now() - started, outcome: 'failure' });
      }
      throw error;
    } finally {
      await output.close().catch((error: unknown) => {
        this.logger.warn(`Could not close restoration output ${outputPath}: ${error}`);
      });
      if (!keep) {
        // Only ever the file this call created exclusively above.
        await rm(outputPath, { force: true });
      }
    }
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private parseRestorationResult(
    response: Response,
    payload: RestorationWorkerRequest,
    target: string,
  ): RestorationWorkerResult {
    const header = response.headers.get(RESTORATION_RESULT_HEADER);
    if (!header) {
      throw new RestorationWorkerError(
        'protocol-error',
        response.status,
        `Restoration ${payload.requestId} on ${target} answered without a result`,
      );
    }

    const parsed = RestorationWorkerResultSchema.safeParse(
      this.parseJson(Buffer.from(header, 'base64url').toString('utf8')),
    );
    if (!parsed.success) {
      throw new RestorationWorkerError(
        'protocol-error',
        response.status,
        `Restoration ${payload.requestId} on ${target} answered with an unreadable result: ${parsed.error.message}`,
      );
    }

    const result = parsed.data;
    const pinnedFingerprint = payload.modelFingerprint ?? null;
    const namedModel = payload.modelId ?? null;
    if (
      result.requestId !== payload.requestId ||
      result.mode !== payload.mode ||
      result.model.mode !== payload.mode ||
      (pinnedFingerprint !== null && result.model.fingerprint !== pinnedFingerprint) ||
      (namedModel !== null && result.model.id !== namedModel)
    ) {
      throw new RestorationWorkerError(
        'protocol-error',
        response.status,
        `Restoration ${payload.requestId} on ${target} answered for a different request or model`,
        result.model.id,
      );
    }
    return result;
  }

  /** Hardware of one explicit endpoint; the defaults when it does not answer. */
  async getHardware(endpoint: MlEndpoint): Promise<MachineLearningHardwareResponse> {
    await this.authorize(endpoint);
    if (endpoint.cloud) {
      return defaultMachineLearningHardware;
    }
    try {
      const response = await fetch(new URL('hardware', endpoint.url), {
        headers: this.authHeaders(endpoint),
        signal: AbortSignal.timeout(Math.min(5000, Math.max(250, this.timeout()))),
        redirect: 'error',
      });
      if (response.ok) {
        const result = diagnosticHardwareSchema.parse(await this.readDiagnosticJson(response));
        await this.authorize(endpoint);
        return result;
      }

      await response.body?.cancel();
      this.logger.warn(
        `Machine learning hardware request to "${endpoint.url}" failed with status ${response.status}: ${response.statusText}`,
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Machine learning hardware request to "${endpoint.url}" failed: ${error instanceof Error ? error.message : error}`,
      );
    }

    return defaultMachineLearningHardware;
  }
  /**
   * FL-159: the container report of a worker's `GET /hardware`, for Hardware & GPU. Null when the
   * worker does not answer or sends no report.
   */
  async getContainerHardware(endpoint: MlEndpoint): Promise<MlContainerReport | null> {
    await this.authorize(endpoint);
    if (endpoint.cloud) {
      return null;
    }
    try {
      const response = await fetch(new URL('hardware', endpoint.url), {
        headers: this.authHeaders(endpoint),
        signal: AbortSignal.timeout(Math.min(10_000, Math.max(250, this.timeout()))),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const result = parseMlContainerReport(await this.readDiagnosticJson(response));
      await this.authorize(endpoint);
      return result;
    } catch (error: unknown) {
      this.logger.warn(
        `Machine learning hardware request to "${endpoint.url}" failed: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  private async getFormData(payload: ModelPayload, config: MachineLearningRequest): Promise<FormData> {
    const formData = new FormData();
    formData.append('entries', JSON.stringify(config));

    if ('imagePath' in payload) {
      const fileBuffer = await readFile(payload.imagePath);
      formData.append('image', new Blob([new Uint8Array(fileBuffer)]));
    } else if ('text' in payload) {
      formData.append('text', payload.text);
    } else {
      throw new Error('Invalid input');
    }

    return formData;
  }
}
