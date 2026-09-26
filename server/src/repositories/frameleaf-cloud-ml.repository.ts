import { Injectable } from '@nestjs/common';
import z from 'zod';
import type { FrameleafInstanceToken } from 'src/utils/frameleaf-dpop.js';
import { MlAdmissionRefusal } from 'src/enum.js';
import { FrameleafCloudRepository, FrameleafCloudRequest } from 'src/repositories/frameleaf-cloud.repository.js';
import { ML_CLONE_SUSPENDED_DETAIL } from 'src/utils/frameleaf-cloud-gateway.js';
import {
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
  CloudUsage,
  CloudWallet,
  CloudWalletSettings,
  FrameleafCloudError,
  IDEMPOTENCY_KEY_PATTERN,
  capabilitiesSchema,
  catalogSchema,
  cloudRequestBody,
  consentCurrentSchema,
  consentRecordRequestSchema,
  consentRecordedSchema,
  estimateRequestSchema,
  estimateResponseSchema,
  isGatewayCloneSuspected,
  jobAdmittedSchema,
  jobCreateRequestSchema,
  jobStatusSchema,
  usageSchema,
  walletResponseSchema,
} from 'src/utils/frameleaf-cloud.js';

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
    await this.cloud.requestJson(pingSchema, { url: `${gateway.url}/ping` });
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
  createEstimate(gateway: CloudMlGateway, request: CloudEstimateRequest): Promise<CloudEstimate> {
    const body = cloudRequestBody(estimateRequestSchema, request, 'the estimate request');
    return this.request(gateway, estimateResponseSchema, {
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
    const admitted = await this.request(gateway, jobAdmittedSchema, {
      method: 'POST',
      url: `${gateway.url}/v2/jobs`,
      dpop: gateway.token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body,
    });
    if (admitted.modelSku !== body.modelSku || admitted.modelRev !== body.modelRev) {
      throw new FrameleafCloudError(
        MlAdmissionRefusal.ModelMismatch,
        null,
        `Frameleaf Cloud admitted job ${admitted.jobId} for another model than the one sent`,
      );
    }
    return admitted;
  }

  /** `GET /v2/jobs/{id}`: where a job is now. */
  getJob(gateway: CloudMlGateway, jobId: string): Promise<CloudJobStatus> {
    return this.request(gateway, jobStatusSchema, { url: this.jobUrl(gateway, jobId), dpop: gateway.token });
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

  getConsent(gateway: CloudMlGateway): Promise<CloudConsentCurrent> {
    return this.request(gateway, consentCurrentSchema, {
      url: `${gateway.url}/v2/consent/current`,
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
  recordConsent(
    gateway: CloudMlGateway,
    consent: { version: string; features: CloudConsentFeatures; acknowledgedBy?: string },
  ): Promise<CloudConsentRecorded> {
    const body = cloudRequestBody(consentRecordRequestSchema, consent, 'the consent');
    return this.request(gateway, consentRecordedSchema, {
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
    gateway: Pick<CloudMlGateway, 'onCloneSuspected'>,
    schema: T,
    request: FrameleafCloudRequest,
  ): Promise<z.infer<T>> {
    try {
      return await this.cloud.requestJson(schema, request);
    } catch (error) {
      if (isGatewayCloneSuspected(error)) {
        await gateway.onCloneSuspected?.();
        throw new FrameleafCloudError(
          MlAdmissionRefusal.CloudUnavailable,
          error.status,
          ML_CLONE_SUSPENDED_DETAIL,
          error.envelope,
          null,
          error.retryAfterSeconds,
        );
      }
      throw error;
    }
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
