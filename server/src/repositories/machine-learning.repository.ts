import { Injectable } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import { MachineLearningConfig } from 'src/dtos/config.dto.js';
import {
  LIBRARY_ML_WORKLOADS,
  MachineLearningHardwareAcceleration,
  MlDestinationKind,
  MlWorkload,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

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
  /**
   * Pet recognition (FL-58). The contract is declared here so the server side of the
   * feature is complete and typed, but no model in `machine-learning/immich_ml`
   * implements this task yet: the container will answer an unknown task with an error.
   * `PetService` therefore reports the capability as unavailable rather than issuing a
   * request that is guaranteed to fail. Remove that guard when the model lands.
   */
  PET_RECOGNITION = 'pet-recognition',
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

export type PetDetectionOptions = ModelOptions & { minScore: number };

/**
 * One animal a pet model found in one image. `species` is the detector's guess and is
 * advisory only; the owner's `pet.species` is never derived from it. `embedding` is the
 * replaceable part: it belongs to the model revision that produced it and is discarded
 * whenever that revision changes.
 */
export interface PetDetectionResult {
  boundingBox: BoundingBox;
  embedding: string;
  score: number;
  species: string | null;
}

export type PetRecognitionRequest = {
  [ModelTask.PET_RECOGNITION]: {
    [ModelType.DETECTION]: ModelOptions & { options: { minScore: number } };
    [ModelType.RECOGNITION]: ModelOptions;
  };
};

export type PetRecognitionResponse = { [ModelTask.PET_RECOGNITION]: PetDetectionResult[] } & VisualResponse;
export type MachineLearningRequest =
  | ClipVisualRequest
  | ClipTextualRequest
  | FacialRecognitionRequest
  | OcrRequest
  | ImageDescriptionRequest
  | NsfwDetectionRequest
  | PetRecognitionRequest;
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

const isMlWorkload = (value: unknown): value is MlWorkload =>
  typeof value === 'string' && (Object.values(MlWorkload) as string[]).includes(value);

/** How long an admission probe stays fresh before the next request re-probes the endpoint. */
export const ML_PROBE_FRESHNESS_MS = 10_000;

@Injectable()
export class MachineLearningRepository {
  private _config?: MachineLearningConfig;
  /**
   * The endpoint the RunPod state machine currently advertises. It is published here so a
   * selection that names a RunPod destination can resolve it; nothing in this class reads
   * it on its own initiative. Held on the instance, not on `_config`, so a config rebuild
   * does not wipe it.
   */
  private runPodEndpoint: MlEndpoint | null = null;
  private probeCache = new Map<string, MlEndpointProbe>();

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
    if (cached && maxAgeMs > 0 && Date.now() - cached.probedAt.getTime() < maxAgeMs) {
      return cached;
    }

    const started = Date.now();
    const probedAt = new Date(started);
    const finish = (probe: Omit<MlEndpointProbe, 'latencyMs' | 'probedAt'>): MlEndpointProbe => {
      const result = { ...probe, latencyMs: Date.now() - started, probedAt };
      this.probeCache.set(endpoint.url, result);
      return result;
    };
    const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

    try {
      const ping = await fetch(new URL('ping', endpoint.url), {
        headers: this.authHeaders(endpoint),
        signal: AbortSignal.timeout(this.timeout()),
      });
      if (!ping.ok) {
        return finish({ reachable: false, workloads: [], hardware: null, error: `ping returned ${ping.status}` });
      }
    } catch (error) {
      return finish({ reachable: false, workloads: [], hardware: null, error: describe(error) });
    }

    let workloads: MlWorkload[] = [];
    try {
      const response = await fetch(new URL('capabilities', endpoint.url), {
        headers: this.authHeaders(endpoint),
        signal: AbortSignal.timeout(this.timeout()),
      });
      if (response.ok) {
        const body = (await response.json()) as CapabilitiesResponse;
        workloads = Array.isArray(body.workloads) ? body.workloads.filter(isMlWorkload) : [];
      } else if (response.status === 404) {
        workloads = [...LIBRARY_ML_WORKLOADS];
      } else {
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
        signal: AbortSignal.timeout(this.timeout()),
      });
      if (response.ok) {
        hardware = (await response.json()) as MachineLearningHardwareResponse;
      }
    } catch {
      // Hardware is informational; a worker without the route is still admissible.
    }

    return finish({ reachable: true, workloads, hardware, error: null });
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

  /**
   * Ask the selected destination for the animals in an image.
   *
   * Nothing calls this yet: `machine-learning/immich_ml` has no pet model, so the task
   * name would not be recognised. It exists so the server contract is whole and so the
   * remaining work is a model plus a caller, not a redesign. See `ModelTask.PET_RECOGNITION`.
   * Like every other request it takes an admitted selection first (FL-110); a future caller
   * routes it through `selectRoutedMlDestination` and never reaches for a URL directly.
   */
  async detectPets(selection: MlSelection, imagePath: string, { modelName, minScore }: PetDetectionOptions) {
    const request = {
      [ModelTask.PET_RECOGNITION]: {
        [ModelType.DETECTION]: { modelName, options: { minScore } },
        [ModelType.RECOGNITION]: { modelName },
      },
    };
    const response = await this.predict<PetRecognitionResponse>(selection, { imagePath }, request);
    return {
      imageHeight: response.imageHeight,
      imageWidth: response.imageWidth,
      pets: response[ModelTask.PET_RECOGNITION],
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

  /** Hardware of one explicit endpoint; the defaults when it does not answer. */
  async getHardware(endpoint: MlEndpoint): Promise<MachineLearningHardwareResponse> {
    try {
      const response = await fetch(new URL('hardware', endpoint.url), {
        headers: this.authHeaders(endpoint),
        signal: AbortSignal.timeout(this.timeout()),
      });
      if (response.ok) {
        return response.json();
      }

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
