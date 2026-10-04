import path from 'node:path';
import {
  CloudMlGateway,
  CloudTransferError,
  CloudUploadedPart,
  FrameleafCloudMlRepository,
} from 'src/repositories/frameleaf-cloud-ml.repository.js';
import {
  CloudJobView,
  CloudOutputDownload,
  CloudUploadTarget,
  FrameleafCloudError,
  cloudErrorCode,
  isFinalCloudJobStatus,
} from 'src/utils/frameleaf-cloud.js';

/**
 * The Frameleaf Cloud job client every workload shares (FL-162): what happens to a cloud job between
 * its admission (`POST /v2/jobs`) and its acknowledgement, whatever the job is for. It uploads inputs
 * to their presigned targets (inline, or 8 MiB parts that a resumed upload does not send again), starts
 * the job, long-polls it with `If-None-Match` and `Retry-After`, downloads outputs with their SHA-256
 * checked, and acknowledges the job so the cloud purges it (`DELETE /v2/jobs/{id}`).
 *
 * It keeps no state of its own: the caller records upload progress (`CloudJobUploadState`) and the
 * last ETag with its job, so a restart carries on from them. Restoration and Smooth motion jobs
 * (`CloudMlJobService`) use it; description batches (FL-163) can adopt it once their contract gate is
 * lifted.
 */

/** What a caller records per input: whether it is uploaded, and the multipart parts already sent. */
export type CloudJobUploadState = Record<string, { done: boolean; parts: CloudUploadedPart[] }>;

/** One input as prepared on this server: the file uploaded, and what the job was admitted with. */
export type CloudJobInputFile = { inputId: string; sha256: string; bytes: number; path: string };

/** How an upload ended: every input is up, the caller stopped it, or the job no longer takes uploads. */
export type CloudJobUploadOutcome = 'uploaded' | 'stopped' | 'closed';

/** A job read: the view when it changed (null on a 304), its ETag, and when to read it again. */
export type CloudJobRead = { view: CloudJobView | null; etag: string | null; delayMs: number };

/** A refused upload: the cloud expects another file than the one prepared, or gave no target for it. */
export class CloudJobInputError extends Error {
  constructor(
    readonly inputId: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloudJobInputError';
  }
}

/** How often one storage transfer is tried before its failure reaches the job. */
export const CLOUD_TRANSFER_ATTEMPTS = 3;
/** The pause before the second attempt; it doubles for every attempt after that. */
const CLOUD_TRANSFER_RETRY_MS = 1000;

/**
 * A storage failure worth trying again at once: storage did not answer, or answered 429 or 5xx.
 * Anything else (a refused address, a changed input, a checksum mismatch, a stop) is not.
 */
export const isTransientTransfer = (error: unknown): boolean =>
  error instanceof CloudTransferError &&
  (error.failure === 'storage-unreachable' ||
    (error.failure === 'storage-refused' && error.status !== null && (error.status === 429 || error.status >= 500)));

export type FrameleafCloudJobClientOptions = {
  /** Aborting stops an upload or download in flight with `stopped` (a lost claim, a cancel, shutdown). */
  signal?: AbortSignal;
  /** Waits between two attempts of one transfer; a test passes one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FrameleafCloudJobClient {
  private readonly signal?: AbortSignal;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private repository: FrameleafCloudMlRepository,
    private gateway: CloudMlGateway,
    options: FrameleafCloudJobClientOptions = {},
  ) {
    this.signal = options.signal;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Run one storage transfer, trying it again after a transient failure (`CLOUD_TRANSFER_ATTEMPTS`
   * times in all, with a doubling pause), so a dropped part costs a part, not the job's retry.
   */
  private async withRetries(transfer: () => Promise<void>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await transfer();
        return;
      } catch (error) {
        if (attempt >= CLOUD_TRANSFER_ATTEMPTS || !isTransientTransfer(error) || this.signal?.aborted) {
          throw error;
        }
        await this.sleep(CLOUD_TRANSFER_RETRY_MS * 2 ** (attempt - 1));
      }
    }
  }

  /**
   * Upload every input that is not up yet. `given` are the targets an admission answered with (else
   * they are read). A target close to expiring, or one storage refuses as expired, is signed again.
   * `record` checks the caller’s admission and lease before each transfer attempt and records the
   * whole state after every finished part and input. False stops before another request. `closed`
   * means the job no longer takes uploads (it was started already).
   */
  async upload(
    jobId: string,
    inputs: readonly CloudJobInputFile[],
    state: CloudJobUploadState,
    options: {
      given?: CloudUploadTarget[] | null;
      now?: Date;
      record: (state: CloudJobUploadState) => Promise<boolean>;
    },
  ): Promise<CloudJobUploadOutcome> {
    let targets: CloudUploadTarget[];
    try {
      targets = options.given ?? (await this.repository.getUploads(this.gateway, jobId));
    } catch (error) {
      if (cloudErrorCode(error) === 'upload-closed') {
        return 'closed';
      }
      throw error;
    }
    const now = options.now ?? new Date();
    for (const input of inputs) {
      const current = state[input.inputId] ?? { done: false, parts: [] };
      let target = targets.find((entry) => entry.inputId === input.inputId);
      if (!target) {
        throw new CloudJobInputError(input.inputId, `Frameleaf Cloud gave no upload for ${input.inputId}`);
      }
      if (target.sha256 !== input.sha256 || target.bytes !== input.bytes) {
        throw new CloudJobInputError(input.inputId, 'Frameleaf Cloud expects another file than the one prepared');
      }
      if (current.done || target.uploaded) {
        state[input.inputId] = { ...current, done: true };
        continue;
      }
      if (Date.parse(target.expiresAt) - now.getTime() < 60_000) {
        target = await this.repository.refreshUpload(this.gateway, jobId, input.inputId);
      }
      const onPart = (part: CloudUploadedPart) => {
        current.parts = [...current.parts.filter((entry) => entry.partNumber !== part.partNumber), part];
        state[input.inputId] = { ...current };
        return options.record(state);
      };
      try {
        // the parts are read afresh on every attempt, so a retry never sends a finished part again
        await this.send(
          jobId,
          input,
          target,
          () => current.parts,
          onPart,
          () => options.record(state),
        );
      } catch (error) {
        if (error instanceof CloudTransferError && error.failure === 'stopped') {
          return 'stopped';
        }
        if (cloudErrorCode(error) === 'upload-closed') {
          return 'closed';
        }
        throw error;
      }
      state[input.inputId] = { ...current, done: true };
      if (!(await options.record(state))) {
        return 'stopped';
      }
    }
    return 'uploaded';
  }

  private async send(
    jobId: string,
    input: CloudJobInputFile,
    target: CloudUploadTarget,
    done: () => CloudUploadedPart[],
    onPart: (part: CloudUploadedPart) => Promise<boolean>,
    record: () => Promise<boolean>,
  ) {
    const signal = this.signal;
    const transfer = async (upload: CloudUploadTarget) => {
      if (!(await record())) {
        throw new CloudTransferError('stopped', 'The caller stopped this upload');
      }
      await this.repository.uploadInput(this.gateway, upload, input.path, { done: done(), onPart, signal });
    };
    try {
      await this.withRetries(() => transfer(target));
    } catch (error) {
      if (!(error instanceof CloudTransferError && error.failure === 'target-expired')) {
        throw error;
      }
      // signed again once, for the same multipart upload: the parts already sent stay sent
      const fresh = await this.repository.refreshUpload(this.gateway, jobId, input.inputId);
      await this.withRetries(() => transfer(fresh));
    }
  }

  /** `POST /v2/jobs/{id}/start`, once every input is up: the job is queued and metering can begin. */
  start(jobId: string): Promise<CloudJobView> {
    return this.repository.startJob(this.gateway, jobId);
  }

  /**
   * Read the job conditionally with the last ETag. `delayMs` is the cloud's `Retry-After` (else
   * `defaultMs`), kept between one second and `maxMs`.
   */
  async read(jobId: string, etag: string | null, timing: { defaultMs: number; maxMs: number }): Promise<CloudJobRead> {
    const answer = await this.repository.getJobView(this.gateway, jobId, etag);
    const seconds = answer.retryAfterSeconds ?? timing.defaultMs / 1000;
    const delayMs = Math.min(timing.maxMs, Math.max(1000, seconds * 1000));
    return { view: answer.notModified ? null : answer.data, etag: answer.etag, delayMs };
  }

  /**
   * Download the outputs of an ended job into `directory`, each checked against its SHA-256 while it
   * streams (a mismatch keeps nothing and throws `sha256-mismatch`). Outputs in `done` whose file is
   * still there are not fetched again; `record` is called after every new one. Files come back in the
   * order the outputs are given.
   */
  async download(
    view: CloudJobView,
    outputs: readonly CloudOutputDownload[],
    directory: string,
    options: {
      done: readonly string[];
      exists: (file: string) => Promise<boolean>;
      remove: (file: string) => Promise<void>;
      fileName: (output: CloudOutputDownload) => string;
      record: (outputId: string) => Promise<boolean>;
    },
  ): Promise<string[] | null> {
    if (!view.result) {
      return [];
    }
    const files: string[] = [];
    for (const output of outputs) {
      const file = path.join(directory, options.fileName(output));
      if (!options.done.includes(output.outputId) || !(await options.exists(file))) {
        const headers = view.result.headers;
        await this.withRetries(async () => {
          // a broken download keeps nothing, so every attempt starts from an empty file
          await options.remove(file);
          await this.repository.downloadOutput(this.gateway, output, headers, file, { signal: this.signal });
        });
        if (!(await options.record(output.outputId))) {
          return null;
        }
      }
      files.push(file);
    }
    return files;
  }

  /** Stop a job that has not ended; an ended job answers 409, which is fine. */
  async cancel(jobId: string, status: CloudJobView['status']): Promise<void> {
    if (isFinalCloudJobStatus(status)) {
      return;
    }
    try {
      await this.repository.cancelJob(this.gateway, jobId);
    } catch (error) {
      if (cloudErrorCode(error) !== 'job-ended') {
        throw error;
      }
    }
  }

  /**
   * `DELETE /v2/jobs/{id}`: acknowledge an ended job, so the cloud purges its inputs and outputs. A job
   * the cloud no longer knows (404) was purged already, which is what was asked.
   */
  async acknowledge(jobId: string): Promise<void> {
    try {
      await this.repository.deleteJob(this.gateway, jobId);
    } catch (error) {
      if (!(error instanceof FrameleafCloudError && error.status === 404)) {
        throw error;
      }
    }
  }
}
