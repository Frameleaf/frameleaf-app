import { Injectable } from '@nestjs/common';
import type { FrameleafDiscoveryDocument } from 'src/utils/frameleaf-cloud.js';
import type { FrameleafInstanceToken, FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import {
  PUSH_GATEWAY_BATCH,
  PushGatewayMessage,
  PushGatewayResponse,
  pushGatewayBase,
  pushGatewayRequestSchema,
  pushGatewayResponseSchema,
  pushGatewayUrl,
} from 'src/utils/frameleaf-push.js';

/** Where the push gateway is and the DPoP-bound instance token for it. */
export type PushGatewayTarget = { url: string; token: FrameleafInstanceToken };

/**
 * FL-228: the Frameleaf push gateway client (contract in `src/utils/frameleaf-push.ts`). Every request
 * is checked against the contract before it leaves, so nothing but targets and opaque blobs can reach
 * the gateway, and it is signed like every other instance call (FL-178). Bodies are never logged.
 */
@Injectable()
export class FrameleafCloudPushRepository {
  constructor(private cloud: FrameleafCloudRepository) {}

  /** The gateway address from discovery and an instance token for it. */
  async target(
    document: FrameleafDiscoveryDocument,
    instanceId: string,
    signer: FrameleafKeySigner,
  ): Promise<PushGatewayTarget> {
    const token = await this.cloud.accessToken(document, instanceId, pushGatewayBase(document), signer);
    return { url: pushGatewayUrl(document), token };
  }

  /** Deliver `messages`, in batches the gateway accepts; the gateway's per-message results in order. */
  async send(target: PushGatewayTarget, messages: PushGatewayMessage[]): Promise<PushGatewayResponse['results']> {
    const batches: PushGatewayMessage[][] = [];
    for (let index = 0; index < messages.length; index += PUSH_GATEWAY_BATCH) {
      batches.push(messages.slice(index, index + PUSH_GATEWAY_BATCH));
    }
    // every batch is checked before the first one is sent
    const bodies = batches.map((batch) => pushGatewayRequestSchema.parse({ messages: batch }));
    const results: PushGatewayResponse['results'] = [];
    for (const body of bodies) {
      const answer = await this.cloud.requestJson(pushGatewayResponseSchema, {
        method: 'POST',
        url: target.url,
        dpop: target.token,
        body,
      });
      results.push(...answer.results);
    }
    return results;
  }
}
