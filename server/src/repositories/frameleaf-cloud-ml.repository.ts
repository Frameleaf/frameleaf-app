import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import z from 'zod';
import type { FrameleafInstanceToken } from 'src/utils/frameleaf-dpop.js';
import { MlAdmissionRefusal } from 'src/enum.js';
import {
  FrameleafCloudConditional,
  FrameleafCloudPublicCall,
  FrameleafCloudRepository,
  FrameleafCloudRequest,
} from 'src/repositories/frameleaf-cloud.repository.js';
import { ML_CLONE_SUSPENDED_DETAIL, ML_REGION_MISMATCH_DETAIL } from 'src/utils/frameleaf-cloud-gateway.js';
import {
  CLOUD_IDEMPOTENCY_IN_FLIGHT_DEFAULT_SECONDS,
  CLOUD_IDEMPOTENCY_IN_FLIGHT_MAX_SECONDS,
  CLOUD_IDEMPOTENCY_IN_FLIGHT_RETRIES,
  CloudCapabilities,
  CloudCatalog,
  CloudConsentCurrent,
  CloudConsentFeatures,
  CloudConsentRecorded,
  CloudEstimate,
  CloudEstimateRequest,
  CloudJobAdmitted,
  CloudJobCreateRequest,
  CloudJobStatus,
  CloudJobView,
  CloudOutputDownload,
  CloudStorageHeaders,
  CloudUploadTarget,
  CloudUsage,
  CloudWallet,
  CloudWalletSettings,
  FrameleafCloudError,
  IDEMPOTENCY_KEY_PATTERN,
  capabilitiesSchema,
  catalogSchema,
  cloudAddressProblem,
  cloudRequestBody,
  consentCurrentQuery,
  consentCurrentSchema,
  consentRecordRequestSchema,
  consentRecordedSchema,
  estimateRequestSchema,
  estimateResponseSchema,
  isGatewayCloneSuspected,
  isIdempotencyInFlight,
  isIdempotencyKeyReused,
  isRegionMismatch,
  jobAdmittedSchema,
  jobCreateRequestSchema,
  jobStatusSchema,
  jobViewSchema,
  uploadTargetSchema,
  uploadTargetsResponseSchema,
  usageSchema,
  walletResponseSchema,
} from 'src/utils/frameleaf-cloud.js';

/**
 * FL-162: the longest job answer read. A job view or an upload plan names one presigned address per
 * output or 8 MiB part, so a long video's plan is far larger than the gateway's other answers.
 */
export const CLOUD_JOB_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** FL-162: how long one storage request (an inline upload, a part, completing an upload) may take. */
export const CLOUD_TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;

/** FL-162: how long one output download may take (a restored video can be gigabytes). */
export const CLOUD_DOWNLOAD_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/** One multipart part this server finished uploading, kept so a resumed upload skips it. */
export type CloudUploadedPart = { partNumber: number; etag: string };

/**
 * Why a transfer to or from Frameleaf Cloud's job storage failed (FL-162). `target-expired` means the
 * presigned address must be signed again; `sha256-mismatch` that an output did not match its digest;
 * `input-changed` that the prepared file is not what was estimated; `stopped` that the caller stopped.
 */
export type CloudTransferFailure =
  | 'target-invalid'
  | 'target-expired'
  | 'storage-refused'
  | 'storage-unreachable'
  | 'sha256-mismatch'
  | 'input-changed'
  | 'stopped';

export class CloudTransferError extends Error {
  constructor(
    readonly failure: CloudTransferFailure,
    message: string,
    /** The storage answer's HTTP status, when storage answered at all. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'CloudTransferError';
  }
}

const escapeXml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * Where to reach the regional processing gateway, and the DPoP-bound token minted for it with the key
 * that signs every call's proof (FL-178). `onCloneSuspected` (FL-183) is what the gateway answering
 * 403 `clone_suspected` sets off: the same ML suspension and notice as the token endpoint's refusal
 * (FL-185). It never throws.
 */
export type CloudMlGateway = {
  url: string;
  token: FrameleafInstanceToken;
  onCloneSuspected?: () => Promise<void>;
  /**
   * FC-50: the gateway answered 403 `region-mismatch`. Re-reads discovery, the link and the owner's
   * `dataRegion` and answers the gateway and token to retry with (once), or throws the refusal.
   */
  onRegionMismatch?: () => Promise<Pick<CloudMlGateway, 'url' | 'token'>>;
  /** FC-50: the retry was refused for its region too: tell the administrators. Never throws. */
  onRegionMismatchUnresolved?: () => Promise<void>;
};

/** `GET /ping` (public; FC-66 minimal responses): `{ok: true}` and nothing else. */
const pingSchema = z.object({ ok: z.literal(true) });

/**
 * `GET /hardware` (FC-34 `HardwareResponse`): the gateway's synthetic CUDA descriptor, so the
 * inventory shows the destination as GPU-backed. It never describes real hosts.
 */
export const hardwareSchema = z.object({
  providers: z.array(z.string().max(100)).max(32).default([]),
  cudaDeviceCount: z.number().int().min(0).max(1024).default(0),
  preferredAcceleration: z.string().max(40).default('cuda'),
});
export type CloudHardware = z.infer<typeof hardwareSchema>;

/** A job id in a gateway path: only a UUID, so nothing else can be spliced into the address. */
const jobIdSchema = z.uuid();

/**
 * The Frameleaf Cloud processing gateway client (FL-159, CLD-201; program plan "Cloud ML v2";
 * FL-183 against the FC-34 gateway): `/ping`, `/capabilities`, `/hardware`, `/v2/catalog`,
 * `/v2/estimates`, `/v2/jobs` (create, status, cancel and delete), `/v2/wallet`, `/v2/usage`,
 * `/v2/consent/current` and `/v2/consent`. Every body is checked against the gateway contract before
 * it is sent, and every answer against its schema; the batches that send work (CLD-202, CLD-203) own
 * when a job is estimated and submitted.
 */
@Injectable()
export class FrameleafCloudMlRepository {
  constructor(private cloud: FrameleafCloudRepository) {}

  async ping(gateway: Pick<CloudMlGateway, 'url'>): Promise<void> {
    await this.cloud.requestJson(pingSchema, {
      url: `${gateway.url}/ping`,
      unauthenticated: FrameleafCloudPublicCall.MlPing,
    });
  }

  getCapabilities(gateway: CloudMlGateway): Promise<CloudCapabilities> {
    return this.request(gateway, capabilitiesSchema, { url: `${gateway.url}/capabilities`, dpop: gateway.token });
  }

  getHardware(gateway: CloudMlGateway): Promise<CloudHardware> {
    return this.request(gateway, hardwareSchema, { url: `${gateway.url}/hardware`, dpop: gateway.token });
  }

  getCatalog(gateway: CloudMlGateway): Promise<CloudCatalog> {
    return this.request(gateway, catalogSchema, { url: `${gateway.url}/v2/catalog`, dpop: gateway.token });
  }

  /**
   * `POST /v2/estimates`: a sealed, single-use estimate for exactly this workload, model SKU, inputs
   * and request, valid for 15 minutes. The body is refused here (`RequestInvalid`) when the contract
   * would refuse it, for example a model name where a SKU belongs or a request key outside the
   * workload's allow-list.
   */
  async createEstimate(gateway: CloudMlGateway, request: CloudEstimateRequest): Promise<CloudEstimate> {
    const body = cloudRequestBody(estimateRequestSchema, request, 'the estimate request');
    return await this.request(gateway, estimateResponseSchema, {
      method: 'POST',
      url: `${gateway.url}/v2/estimates`,
      dpop: gateway.token,
      body,
    });
  }

  /**
   * `POST /v2/jobs`: admit a job with the sealed estimate it was quoted. `idempotencyKey` is one per
   * logical submission, so a retry of the same body answers the same admission rather than spending
   * the (single-use) estimate again. An admission for another model SKU or revision than the one
   * sent is refused as `ModelMismatch`. A 503 `capacity` answer refuses this destination
   * (`DestinationUnhealthy`); the job is never sent anywhere else.
   *
   * FC-43 (IETF Idempotency-Key draft): a 409 `idempotency-in-flight` means the first request under
   * this key is still being processed, so the SAME request (key and body) is sent again after its
   * `Retry-After`, at most `CLOUD_IDEMPOTENCY_IN_FLIGHT_RETRIES` times; still in flight after that, the
   * 409 is thrown (`CloudUnavailable`, transient) and the caller waits and replays the same key. A 422
   * `idempotency-key-reused` is never sent again: the key was used with another body, a bug here.
   */
  async createJob(
    gateway: CloudMlGateway,
    request: CloudJobCreateRequest,
    idempotencyKey: string,
  ): Promise<CloudJobAdmitted> {
    const body = cloudRequestBody(jobCreateRequestSchema, request, 'the job');
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new FrameleafCloudError(
        MlAdmissionRefusal.RequestInvalid,
        null,
        'This server did not send the job: its idempotency key is not one Frameleaf Cloud accepts',
      );
    }
    let admitted: CloudJobAdmitted | undefined;
    for (let attempt = 0; !admitted; attempt++) {
      try {
        admitted = await this.request(gateway, jobAdmittedSchema, {
          method: 'POST',
          url: `${gateway.url}/v2/jobs`,
          dpop: gateway.token,
          headers: { 'Idempotency-Key': idempotencyKey },
          body,
        });
      } catch (error) {
        if (error instanceof FrameleafCloudError && isIdempotencyKeyReused(error)) {
          throw new FrameleafCloudError(
            error.refusal,
            error.status,
            `Frameleaf Cloud refused the job: its idempotency key ${idempotencyKey} was already used for a different job. ` +
              'This is a bug in this server; the job was not sent again.',
            error.envelope,
            null,
            null,
          );
        }
        if (
          !(error instanceof FrameleafCloudError) ||
          !isIdempotencyInFlight(error) ||
          attempt >= CLOUD_IDEMPOTENCY_IN_FLIGHT_RETRIES
        ) {
          throw error;
        }
        const seconds = Math.min(
          CLOUD_IDEMPOTENCY_IN_FLIGHT_MAX_SECONDS,
          Math.max(1, error.retryAfterSeconds ?? CLOUD_IDEMPOTENCY_IN_FLIGHT_DEFAULT_SECONDS),
        );
        await this.delay(seconds * 1000);
      }
    }
    if (admitted.modelSku !== body.modelSku || admitted.modelRev !== body.modelRev) {
      throw new FrameleafCloudError(
        MlAdmissionRefusal.ModelMismatch,
        null,
        `Frameleaf Cloud admitted job ${admitted.jobId} for another model than the one sent`,
      );
    }
    return admitted;
  }

  /** The wait before sending an in-flight job again; a test replaces it. */
  protected async delay(ms: number): Promise<void> {
    await sleep(ms);
  }

  /** `GET /v2/jobs/{id}`: where a job is now. */
  async getJob(gateway: CloudMlGateway, jobId: string): Promise<CloudJobStatus> {
    return await this.request(gateway, jobStatusSchema, { url: this.jobUrl(gateway, jobId), dpop: gateway.token });
  }

  /**
   * FL-162: `GET /v2/jobs/{id}` read as the full FC-39 `JobView`, conditionally. `etag` is the last
   * ETag this server saw for the job: a 304 answers `notModified`, so a long poll costs no body until
   * something changed, and `retryAfterSeconds` says when to ask again while the job waits.
   */
  async getJobView(
    gateway: CloudMlGateway,
    jobId: string,
    etag: string | null,
  ): Promise<FrameleafCloudConditional<CloudJobView>> {
    const url = this.jobUrl(gateway, jobId);
    try {
      return await this.inRegion(
        gateway,
        { url, dpop: gateway.token, maxBodyBytes: CLOUD_JOB_MAX_BODY_BYTES },
        (request) => this.cloud.requestJsonConditional(jobViewSchema, request, etag),
      );
    } catch (error) {
      throw await this.cloneSuspected(gateway, error);
    }
  }

  /**
   * FL-162: `POST /v2/jobs/{id}/start`, once every input is uploaded: the job is queued and metering
   * can begin when a worker picks it up. 409 `inputs-missing` means an input is not complete yet.
   */
  async startJob(gateway: CloudMlGateway, jobId: string): Promise<CloudJobView> {
    return await this.request(gateway, jobViewSchema, {
      method: 'POST',
      url: `${this.jobUrl(gateway, jobId)}/start`,
      dpop: gateway.token,
      maxBodyBytes: CLOUD_JOB_MAX_BODY_BYTES,
    });
  }

  /** FL-162: `GET /v2/jobs/{id}/uploads`, every input's upload target while the job takes uploads. */
  async getUploads(gateway: CloudMlGateway, jobId: string): Promise<CloudUploadTarget[]> {
    const answer = await this.request(gateway, uploadTargetsResponseSchema, {
      url: `${this.jobUrl(gateway, jobId)}/uploads`,
      dpop: gateway.token,
      maxBodyBytes: CLOUD_JOB_MAX_BODY_BYTES,
    });
    if (answer.jobId !== jobId) {
      throw new FrameleafCloudError(
        MlAdmissionRefusal.CloudUnavailable,
        null,
        'Frameleaf Cloud answered with the uploads of another job',
      );
    }
    return answer.uploads;
  }

  /**
   * FL-162: `POST /v2/jobs/{id}/uploads/{inputId}/refresh`, the same input's target signed again (the
   * same multipart upload) once its addresses are close to expiring.
   */
  async refreshUpload(gateway: CloudMlGateway, jobId: string, inputId: string): Promise<CloudUploadTarget> {
    if (!/^[\w-]{1,64}$/.test(inputId)) {
      throw new FrameleafCloudError(
        MlAdmissionRefusal.RequestInvalid,
        null,
        'This server did not call Frameleaf Cloud: the input id is not one Frameleaf Cloud uses',
      );
    }
    return await this.request(gateway, uploadTargetSchema, {
      method: 'POST',
      url: `${this.jobUrl(gateway, jobId)}/uploads/${inputId}/refresh`,
      dpop: gateway.token,
      maxBodyBytes: CLOUD_JOB_MAX_BODY_BYTES,
    });
  }

  /**
   * FL-162: upload one input to its presigned target (FC-42). An inline target is one PUT; a multipart
   * target is sent part by part from the file, each part read on its own, and `onPart` records every
   * finished part (its number and ETag) so a resumed upload sends only the parts that are missing; it
   * answers false to stop. The part list is then posted to `completeUrl`. Every request sends the
   * target's headers exactly, and every address is checked to be Frameleaf Cloud storage first.
   */
  async uploadInput(
    gateway: Pick<CloudMlGateway, 'url'>,
    target: CloudUploadTarget,
    file: string,
    options: {
      done?: ReadonlyArray<CloudUploadedPart>;
      onPart?: (part: CloudUploadedPart) => Promise<boolean>;
      /** Aborting stops the transfer in flight with `stopped`. */
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const { signal } = options;
    if (target.inline) {
      this.checkStorageAddress(gateway, target.inline.url);
      const body = await readFile(file);
      if (body.length !== target.bytes) {
        throw new CloudTransferError('input-changed', `The prepared input ${target.inputId} changed size`);
      }
      await this.storageSend(target.inline.url, 'PUT', target.headers, body, signal);
      return;
    }
    const multipart = target.multipart;
    if (!multipart) {
      throw new CloudTransferError('target-invalid', `Frameleaf Cloud gave no upload address for ${target.inputId}`);
    }
    this.checkStorageAddress(gateway, multipart.completeUrl);
    const done = new Map((options.done ?? []).map((part) => [part.partNumber, part.etag]));
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (size !== target.bytes) {
        throw new CloudTransferError('input-changed', `The prepared input ${target.inputId} changed size`);
      }
      let offset = 0;
      for (const part of multipart.parts.toSorted((a, b) => a.partNumber - b.partNumber)) {
        const start = offset;
        offset += part.bytes;
        if (done.has(part.partNumber)) {
          continue;
        }
        this.checkStorageAddress(gateway, part.url);
        const body = Buffer.alloc(part.bytes);
        const { bytesRead } = await handle.read(body, 0, part.bytes, start);
        if (bytesRead !== part.bytes) {
          throw new CloudTransferError('input-changed', `The prepared input ${target.inputId} ended early`);
        }
        const response = await this.storageSend(part.url, 'PUT', target.headers, body, signal);
        const etag = response.headers.get('etag');
        if (!etag) {
          throw new CloudTransferError('storage-refused', 'Frameleaf Cloud storage did not confirm an uploaded part');
        }
        done.set(part.partNumber, etag);
        if (options.onPart && !(await options.onPart({ partNumber: part.partNumber, etag }))) {
          throw new CloudTransferError('stopped', 'The upload was stopped');
        }
      }
    } finally {
      await handle.close();
    }
    const parts = done
      .entries()
      .toArray()
      .toSorted(([a], [b]) => a - b)
      .map(([number, etag]) => `<Part><PartNumber>${number}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`);
    const xml = `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`;
    const response = await this.storageSend(multipart.completeUrl, 'POST', target.headers, Buffer.from(xml), signal);
    // S3 can answer 200 with an error document when completing a multipart upload
    const answer = await response.text();
    if (answer.includes('<Error>')) {
      throw new CloudTransferError('storage-refused', 'Frameleaf Cloud storage did not complete the upload');
    }
  }

  /**
   * FL-162: download one output (FC-42) into `destination`, which must not exist yet, checking the
   * size and SHA-256 while it streams. A file that does not match is removed and the download refused
   * (`sha256-mismatch`): an output that changed on the way is never kept.
   */
  async downloadOutput(
    gateway: Pick<CloudMlGateway, 'url'>,
    output: CloudOutputDownload,
    headers: CloudStorageHeaders,
    destination: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const { signal } = options;
    this.checkStorageAddress(gateway, output.url);
    const response = await this.storageFetch(output.url, { method: 'GET', headers }, CLOUD_DOWNLOAD_TIMEOUT_MS, signal);
    if (!response.ok || !response.body) {
      throw new CloudTransferError(
        'storage-refused',
        `Frameleaf Cloud storage answered ${response.status}`,
        response.status,
      );
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const handle = await open(destination, 'wx');
    let kept = false;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > output.bytes) {
          throw new CloudTransferError('sha256-mismatch', `Output ${output.outputId} is larger than its record`);
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (bytes !== output.bytes || hash.digest('hex') !== output.sha256) {
        throw new CloudTransferError('sha256-mismatch', `Output ${output.outputId} does not match its SHA-256`);
      }
      kept = true;
    } catch (error) {
      if (signal?.aborted) {
        throw new CloudTransferError('stopped', 'The download was stopped');
      }
      throw error;
    } finally {
      await handle.close();
      if (!kept) {
        await rm(destination, { force: true });
      }
    }
  }

  /** A storage address must be Frameleaf Cloud's, by the same rule as every other cloud address. */
  private checkStorageAddress(gateway: Pick<CloudMlGateway, 'url'>, url: string) {
    const problem = cloudAddressProblem(gateway.url, 'storage address', url);
    if (problem) {
      throw new CloudTransferError('target-invalid', `This server did not use a storage address: ${problem}`);
    }
  }

  private async storageSend(
    url: string,
    method: 'PUT' | 'POST',
    headers: CloudStorageHeaders,
    body: Buffer,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.storageFetch(url, { method, headers, body }, CLOUD_TRANSFER_TIMEOUT_MS, signal);
    if (!response.ok) {
      // an expired presigned address answers 403; the caller signs the target again
      throw new CloudTransferError(
        response.status === 403 ? 'target-expired' : 'storage-refused',
        `Frameleaf Cloud storage answered ${response.status}`,
        response.status,
      );
    }
    return response;
  }

  /** One storage request: no redirects, bounded in time, and never logged with its headers. */
  private async storageFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: Buffer },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body ? new Uint8Array(init.body) : undefined,
        redirect: 'error',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new CloudTransferError('stopped', 'The transfer was stopped');
      }
      throw new CloudTransferError(
        'storage-unreachable',
        `Frameleaf Cloud storage did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** `POST /v2/jobs/{id}/cancel`: stop a job; the cloud releases what it holds. An empty answer is fine. */
  async cancelJob(gateway: CloudMlGateway, jobId: string): Promise<void> {
    await this.request(gateway, z.unknown(), {
      method: 'POST',
      url: `${this.jobUrl(gateway, jobId)}/cancel`,
      dpop: gateway.token,
    });
  }

  /** `DELETE /v2/jobs/{id}`: acknowledge a finished job's results, so the cloud purges its storage. */
  async deleteJob(gateway: CloudMlGateway, jobId: string): Promise<void> {
    await this.request(gateway, z.unknown(), {
      method: 'DELETE',
      url: this.jobUrl(gateway, jobId),
      dpop: gateway.token,
    });
  }

  getWallet(gateway: CloudMlGateway): Promise<CloudWallet> {
    return this.request(gateway, walletResponseSchema, { url: `${gateway.url}/v2/wallet`, dpop: gateway.token });
  }

  /** `PATCH /v2/wallet`: change the daily cap or automatic top-up; answers with the wallet. */
  updateWallet(gateway: CloudMlGateway, settings: CloudWalletSettings): Promise<CloudWallet> {
    return this.request(gateway, walletResponseSchema, {
      method: 'PATCH',
      url: `${gateway.url}/v2/wallet`,
      dpop: gateway.token,
      body: settings,
    });
  }

  getUsage(gateway: CloudMlGateway, since: Date): Promise<CloudUsage> {
    const query = new URLSearchParams({ since: since.toISOString() });
    return this.request(gateway, usageSchema, { url: `${gateway.url}/v2/usage?${query}`, dpop: gateway.token });
  }

  /**
   * `GET /v2/consent/current`: the terms this server is asked to accept. With `features` (and FC-62's
   * `CONSENT_TERMS_FOR_FEATURES` on), the version, summary and text are those the chosen features need,
   * never below the record in force; without, those of the features on record.
   */
  getConsent(
    gateway: CloudMlGateway,
    features?: Pick<CloudConsentFeatures, 'identityNames' | 'medicalSignals'>,
  ): Promise<CloudConsentCurrent> {
    return this.request(gateway, consentCurrentSchema, {
      url: `${gateway.url}/v2/consent/current${consentCurrentQuery(features)}`,
      dpop: gateway.token,
    });
  }

  /**
   * `DELETE /v2/consent`: withdraw this server's consent with Frameleaf Cloud, so the cloud refuses new
   * jobs too. A cloud contract addition (FL-145); an empty answer is fine.
   */
  async revokeConsent(gateway: CloudMlGateway): Promise<void> {
    await this.request(gateway, z.unknown(), {
      method: 'DELETE',
      url: `${gateway.url}/v2/consent`,
      dpop: gateway.token,
    });
  }

  /**
   * `POST /v2/consent`: record consent to exactly the required disclosure version with its per-feature
   * choices. The cloud answers 403 `consent-version-outdated` (`ConsentVersionOutdated`) for an older
   * version; a body it would refuse (the reserved text-recognition add-on turned on, a malformed
   * version) is refused here and never sent.
   */
  async recordConsent(
    gateway: CloudMlGateway,
    consent: { version: string; features: CloudConsentFeatures; acknowledgedBy?: string },
  ): Promise<CloudConsentRecorded> {
    const body = cloudRequestBody(consentRecordRequestSchema, consent, 'the consent');
    return await this.request(gateway, consentRecordedSchema, {
      method: 'POST',
      url: `${gateway.url}/v2/consent`,
      dpop: gateway.token,
      body,
    });
  }

  /**
   * One gateway call. A 403 `clone_suspected` answer from the gateway itself (FC-34
   * `MlInstanceGuard`) suspends cloud processing as FL-185's token path does (`onCloneSuspected`) and
   * refuses with `CloudUnavailable`, whatever `refusal` the answer named.
   */
  private async request<T extends z.ZodType>(
    gateway: CloudMlGateway,
    schema: T,
    request: FrameleafCloudRequest,
  ): Promise<z.infer<T>> {
    try {
      return await this.inRegion(gateway, request, (sent) => this.cloud.requestJson(schema, sent));
    } catch (error) {
      throw await this.cloneSuspected(gateway, error);
    }
  }

  /**
   * One gateway call in the owner's region (FC-50). A 403 `region-mismatch` is not transient: the
   * gateway is re-resolved from a fresh discovery document and the link's `dataRegion`
   * (`onRegionMismatch`), `gateway` is updated in place so the caller's later calls use it too, and
   * the call is sent once more with the new address and token. A second `region-mismatch` tells the
   * administrators (`onRegionMismatchUnresolved`) and refuses with `ML_REGION_MISMATCH_DETAIL`; it is
   * never retried again.
   */
  private async inRegion<R>(
    gateway: CloudMlGateway,
    request: FrameleafCloudRequest,
    send: (request: FrameleafCloudRequest) => Promise<R>,
  ): Promise<R> {
    try {
      return await send(request);
    } catch (error) {
      if (!isRegionMismatch(error) || !gateway.onRegionMismatch || !request.dpop) {
        throw error;
      }
    }
    const previousUrl = gateway.url;
    const fresh = await gateway.onRegionMismatch();
    gateway.url = fresh.url;
    gateway.token = fresh.token;
    const url = request.url.startsWith(`${previousUrl}/`)
      ? `${fresh.url}${request.url.slice(previousUrl.length)}`
      : request.url;
    try {
      return await send({ ...request, url, dpop: fresh.token });
    } catch (error) {
      if (!isRegionMismatch(error)) {
        throw error;
      }
      await gateway.onRegionMismatchUnresolved?.();
      throw new FrameleafCloudError(
        error.refusal,
        error.status,
        ML_REGION_MISMATCH_DETAIL,
        error.envelope,
        null,
        error.retryAfterSeconds,
      );
    }
  }

  /** The error a failed gateway call throws: a clone suspicion suspends cloud processing first. */
  private async cloneSuspected(gateway: Pick<CloudMlGateway, 'onCloneSuspected'>, error: unknown): Promise<unknown> {
    if (!isGatewayCloneSuspected(error)) {
      return error;
    }
    await gateway.onCloneSuspected?.();
    return new FrameleafCloudError(
      MlAdmissionRefusal.CloudUnavailable,
      error.status,
      ML_CLONE_SUSPENDED_DETAIL,
      error.envelope,
      null,
      error.retryAfterSeconds,
    );
  }

  private jobUrl(gateway: Pick<CloudMlGateway, 'url'>, jobId: string): string {
    if (!jobIdSchema.safeParse(jobId).success) {
      throw new FrameleafCloudError(
        MlAdmissionRefusal.RequestInvalid,
        null,
        'This server did not call Frameleaf Cloud: the job id is not a Frameleaf Cloud job id',
      );
    }
    return `${gateway.url}/v2/jobs/${jobId}`;
  }
}
