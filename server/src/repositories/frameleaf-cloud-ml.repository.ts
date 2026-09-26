import { Injectable } from '@nestjs/common';
import z from 'zod';
import type { FrameleafInstanceToken } from 'src/utils/frameleaf-dpop.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import {
  CloudCapabilities,
  CloudCatalog,
  CloudConsentCurrent,
  CloudConsentFeatures,
  CloudUsage,
  CloudWallet,
  CloudWalletSettings,
  capabilitiesSchema,
  catalogSchema,
  consentCurrentSchema,
  consentRecordedSchema,
  usageSchema,
  walletResponseSchema,
} from 'src/utils/frameleaf-cloud.js';

/**
 * Where to reach the regional processing gateway, and the DPoP-bound token minted for it with the key
 * that signs every call's proof (FL-178).
 */
export type CloudMlGateway = { url: string; token: FrameleafInstanceToken };

const pingSchema = z.object({}).loose();

/** `GET /hardware`: the gateway's synthetic report, so the inventory shows the destination as GPU-backed. */
const hardwareSchema = z.object({
  providers: z.array(z.string().max(100)).max(32).default([]),
  cudaDeviceCount: z.number().int().min(0).max(1024).default(0),
  preferredAcceleration: z.string().max(40).default('cuda'),
});
export type CloudHardware = z.infer<typeof hardwareSchema>;

/**
 * The Frameleaf Cloud processing gateway client (FL-159, CLD-201; program plan "Cloud ML v2"):
 * `/ping`, `/capabilities`, `/hardware`, `/v2/catalog`, `/v2/wallet`, `/v2/usage`,
 * `/v2/consent/current` and `/v2/consent`. Job submission (`/v2/estimates`, `/v2/jobs`) belongs to
 * cloud restoration and description batches (CLD-202, CLD-203) and is not here.
 */
@Injectable()
export class FrameleafCloudMlRepository {
  constructor(private cloud: FrameleafCloudRepository) {}

  async ping(gateway: Pick<CloudMlGateway, 'url'>): Promise<void> {
    await this.cloud.requestJson(pingSchema, { url: `${gateway.url}/ping` });
  }

  getCapabilities(gateway: CloudMlGateway): Promise<CloudCapabilities> {
    return this.cloud.requestJson(capabilitiesSchema, { url: `${gateway.url}/capabilities`, dpop: gateway.token });
  }

  getHardware(gateway: CloudMlGateway): Promise<CloudHardware> {
    return this.cloud.requestJson(hardwareSchema, { url: `${gateway.url}/hardware`, dpop: gateway.token });
  }

  getCatalog(gateway: CloudMlGateway): Promise<CloudCatalog> {
    return this.cloud.requestJson(catalogSchema, { url: `${gateway.url}/v2/catalog`, dpop: gateway.token });
  }

  getWallet(gateway: CloudMlGateway): Promise<CloudWallet> {
    return this.cloud.requestJson(walletResponseSchema, { url: `${gateway.url}/v2/wallet`, dpop: gateway.token });
  }

  /** `PATCH /v2/wallet`: change the daily cap or automatic top-up; answers with the wallet. */
  updateWallet(gateway: CloudMlGateway, settings: CloudWalletSettings): Promise<CloudWallet> {
    return this.cloud.requestJson(walletResponseSchema, {
      method: 'PATCH',
      url: `${gateway.url}/v2/wallet`,
      dpop: gateway.token,
      body: settings,
    });
  }

  getUsage(gateway: CloudMlGateway, since: Date): Promise<CloudUsage> {
    const query = new URLSearchParams({ since: since.toISOString() });
    return this.cloud.requestJson(usageSchema, { url: `${gateway.url}/v2/usage?${query}`, dpop: gateway.token });
  }

  getConsent(gateway: CloudMlGateway): Promise<CloudConsentCurrent> {
    return this.cloud.requestJson(consentCurrentSchema, {
      url: `${gateway.url}/v2/consent/current`,
      dpop: gateway.token,
    });
  }

  /**
   * `DELETE /v2/consent`: withdraw this server's consent with Frameleaf Cloud, so the cloud refuses new
   * jobs too. A cloud contract addition (FL-145); an empty answer is fine.
   */
  async revokeConsent(gateway: CloudMlGateway): Promise<void> {
    await this.cloud.requestJson(z.unknown(), {
      method: 'DELETE',
      url: `${gateway.url}/v2/consent`,
      dpop: gateway.token,
    });
  }

  recordConsent(
    gateway: CloudMlGateway,
    consent: { version: string; features: CloudConsentFeatures },
  ): Promise<z.infer<typeof consentRecordedSchema>> {
    return this.cloud.requestJson(consentRecordedSchema, {
      method: 'POST',
      url: `${gateway.url}/v2/consent`,
      dpop: gateway.token,
      body: consent,
    });
  }
}
