import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import z from 'zod';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { MachineLearningConfig } from 'src/dtos/config.dto.js';
import {
  RESTORATION_MAX_OUTPUT_EDGE,
  RESTORATION_PROTOCOL,
  RESTORATION_RESULT_HEADER,
  RestorationCapabilityReport,
  RestorationCapabilityReportSchema,
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
import { LoggingRepository } from 'src/repositories/logging.repository.js';
// Restoration's selection registry and inference types live with the rest of restoration's
// rules; that module only needs this one's types, so the import cycle is inert at load time.
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
export type ImageDescriptionResponse = { [ModelTask.IMAGE_DESCRIPTION]: ImageDescriptionResult } & VisualResponse;

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

/** A resolved place to send one request: the URL and, for authenticated workers, the bearer. */
export type MlEndpoint = { url: string; authToken?: string };

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
export type MlSelection = {
  destinationId: string;
  kind: MlDestinationKind;
  workload: MlWorkload;
  endpoint: MlEndpoint;
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
};

type CapabilitiesResponse = { workloads?: unknown };

const diagnosticHardwareSchema = MachineLearningHardwareResponseDto.schema.extend({
  providers: z.array(z.string().max(100)).max(32),
  openvinoDeviceIds: z.array(z.string().max(100)).max(32),
  cudaDeviceCount: z.int().min(0).max(1024),
});

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
  /**
   * The endpoint the RunPod state machine currently advertises. It is published here so a
   * selection that names a RunPod destination can resolve it; nothing in this class reads
   * it on its own initiative. Held on the instance, not on `_config`, so a config rebuild
   * does not wipe it.
   */
  private runPodEndpoint: MlEndpoint | null = null;
  private probeCache = new Map<string, { authToken?: string; probe: MlEndpointProbe }>();

  private get config(): MachineLearningConfig {
    if (!this._config) {
      throw new Error('Machine learning repository not been setup');
    }

    return this._config;
  }

  constructor(private logger: LoggingRepository) {
    this.logger.setContext(MachineLearningRepository.name);
  }

  setup(config: MachineLearningConfig) {
    this._config = config;
    this.probeCache.clear();
  }

  /** The deployment's own ML URLs from the admin configuration; these back `local` destinations. */
  getLocalUrls(): string[] {
    return [...this.config.urls];
  }

  /** Called by the RunPod service when a pod or serverless endpoint becomes ready. */
  setRunPodEndpoint(url: string, authToken?: string) {
    this.runPodEndpoint = { url, authToken };
    this.probeCache.delete(url);
    this.logger.log(`RunPod endpoint published for explicit selection (auth=${authToken ? 'yes' : 'no'}): ${url}`);
  }

  clearRunPodEndpoint() {
    if (this.runPodEndpoint) {
      this.probeCache.delete(this.runPodEndpoint.url);
      this.logger.log(`RunPod endpoint withdrawn: ${this.runPodEndpoint.url}`);
    }
    this.runPodEndpoint = null;
  }

  /** The published RunPod endpoint, or null when no pod or serverless worker is ready. */
  getRunPodEndpoint(): MlEndpoint | null {
    return this.runPodEndpoint;
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
  async probe(endpoint: MlEndpoint, { maxAgeMs = 0 }: { maxAgeMs?: number } = {}): Promise<MlEndpointProbe> {
    const cached = this.probeCache.get(endpoint.url);
    if (
      cached &&
      cached.authToken === endpoint.authToken &&
      maxAgeMs > 0 &&
      Date.now() - cached.probe.probedAt.getTime() < maxAgeMs
    ) {
      return cached.probe;
    }

    // Only a probe of the RunPod endpoint can go stale mid-flight: its URL and token are published
    // by the RunPod manager, while every other destination's come from its own row. Compared by
    // value, because an unchanged endpoint is republished (a new object) on every readiness tick.
    const probedRunPod = sameEndpoint(this.runPodEndpoint, endpoint);
    const timeout = Math.min(5000, Math.max(250, this.timeout()));
    const started = Date.now();
    const probedAt = new Date(started);
    const finish = (probe: Omit<MlEndpointProbe, 'latencyMs' | 'probedAt'>): MlEndpointProbe => {
      const result = { ...probe, latencyMs: Date.now() - started, probedAt };
      if (probedRunPod && !sameEndpoint(this.runPodEndpoint, endpoint)) {
        return { ...result, reachable: false, workloads: [], hardware: null, error: 'Endpoint configuration changed' };
      }
      this.probeCache.set(endpoint.url, { authToken: endpoint.authToken, probe: result });
      return result;
    };
    const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

    try {
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
    try {
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

    return finish({ reachable: true, workloads, hardware, error: null });
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
  private async predict<T>(selection: MlSelection, payload: ModelPayload, config: MachineLearningRequest): Promise<T> {
    const formData = await this.getFormData(payload, config);
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
    try {
      response = await fetch(new URL('predict', selection.endpoint.url), {
        method: 'POST',
        headers: this.authHeaders(selection.endpoint),
        body: formData,
      });
    } catch (error: Error | unknown) {
      this.probeCache.delete(selection.endpoint.url);
      selection.record(usage('failure', 0));
      throw new Error(
        `Machine learning request '${this.redact(config)}' to ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const body = await response.text();
    if (!response.ok) {
      selection.record(usage('failure', body.length));
      throw new Error(
        `Machine learning request '${this.redact(config)}' to ${target} failed with status ${response.status}: ${response.statusText}`,
      );
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

  async detectFaces(selection: MlSelection, imagePath: string, { modelName, minScore }: FaceDetectionOptions) {
    const request = {
      [ModelTask.FACIAL_RECOGNITION]: {
        [ModelType.DETECTION]: { modelName, options: { minScore } },
        [ModelType.RECOGNITION]: { modelName },
      },
    };
    const response = await this.predict<FacialRecognitionResponse>(selection, { imagePath }, request);
    return {
      imageHeight: response.imageHeight,
      imageWidth: response.imageWidth,
      faces: response[ModelTask.FACIAL_RECOGNITION],
    };
  }

  async encodeImage(selection: MlSelection, imagePath: string, { modelName }: MachineLearningConfig['clip']) {
    const request = { [ModelTask.SEARCH]: { [ModelType.VISUAL]: { modelName } } };
    const response = await this.predict<ClipVisualResponse>(selection, { imagePath }, request);
    return response[ModelTask.SEARCH];
  }

  async encodeText(selection: MlSelection, text: string, { language, modelName }: TextEncodingOptions) {
    const request = { [ModelTask.SEARCH]: { [ModelType.TEXTUAL]: { modelName, options: { language } } } };
    const response = await this.predict<ClipTextualResponse>(selection, { text }, request);
    return response[ModelTask.SEARCH];
  }

  async ocr(
    selection: MlSelection,
    imagePath: string,
    { modelName, minDetectionScore, minRecognitionScore, maxResolution }: OcrOptions,
  ) {
    const request = {
      [ModelTask.OCR]: {
        [ModelType.DETECTION]: { modelName, options: { minScore: minDetectionScore, maxResolution } },
        [ModelType.RECOGNITION]: { modelName, options: { minScore: minRecognitionScore } },
      },
    };
    const response = await this.predict<OcrResponse>(selection, { imagePath }, request);
    return response[ModelTask.OCR];
  }

  async describeImage(
    selection: MlSelection,
    imagePath: string,
    { modelName, acceleration, fallbackModelName, device }: ImageDescriptionOptions,
    nsfw?: NsfwDetectionResult,
    prompt?: string,
  ) {
    const buildRequest = (effectiveModelName: string) => ({
      [ModelTask.IMAGE_DESCRIPTION]: {
        [ModelType.VISUAL]: {
          modelName: effectiveModelName,
          options: { acceleration, device, nsfw, external_prompt: prompt },
        },
      },
    });

    // The fallback model is retried on the same destination only, and never on RunPod:
    // the admin picked one primary model for cloud work, and Florence's modeling code is
    // not loadable on the cuda-runpod image anyway. Local and LAN workers may be running
    // an older image where Florence is the only small-footprint option.
    const florenceUnavailable =
      acceleration !== MachineLearningHardwareAcceleration.Cuda &&
      !!fallbackModelName &&
      isFlorenceImageDescriptionModel(fallbackModelName);
    const candidateModels: string[] = [modelName];
    if (
      selection.kind !== MlDestinationKind.RunPod &&
      fallbackModelName &&
      fallbackModelName !== modelName &&
      !florenceUnavailable
    ) {
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
        return body[ModelTask.IMAGE_DESCRIPTION];
      } catch (error) {
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
    const response = await fetch(new URL('restoration/models', endpoint.url), {
      headers: this.authHeaders(endpoint),
      signal: AbortSignal.timeout(this.timeout()),
    });
    if (response.status === 404) {
      throw new Error('the destination does not run the restoration worker');
    }
    if (!response.ok) {
      throw new Error(`restoration models returned ${response.status}`);
    }
    const report = RestorationCapabilityReportSchema.parse(await response.json());
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
        response = await fetch(new URL('restoration/restore', selection.endpoint.url), {
          method: 'POST',
          headers: this.authHeaders(selection.endpoint),
          body: form,
          signal,
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
    try {
      const response = await fetch(new URL('hardware', endpoint.url), {
        headers: this.authHeaders(endpoint),
        signal: AbortSignal.timeout(Math.min(5000, Math.max(250, this.timeout()))),
        redirect: 'error',
      });
      if (response.ok) {
        return diagnosticHardwareSchema.parse(await this.readDiagnosticJson(response));
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
