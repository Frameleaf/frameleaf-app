import { Injectable } from '@nestjs/common';
import type { FrameleafDiscoveryDocument } from 'src/utils/frameleaf-cloud.js';
import type { FrameleafInstanceToken, FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import {
  PushSendRequest,
  PushSendResult,
  pushGatewayUrl,
  pushSendRequestSchema,
  pushSendResultSchema,
} from 'src/utils/frameleaf-push.js';

/** Where the push gateway is and the DPoP-bound instance token for it. */
export type PushGatewayTarget = { url: string; token: FrameleafInstanceToken };

/**
 * FL-302: the Frameleaf push gateway client (contract in `src/utils/frameleaf-push.ts`). Every request
 * is checked against the contract before it leaves, so nothing but a target, the push type and an
 * opaque payload (or a fixed Live Activity state) can reach the gateway, and it is signed like every
 * other instance call (FL-178). Bodies are never logged: they hold device tokens.
 */
@Injectable()
export class FrameleafCloudPushRepository {
  constructor(private cloud: FrameleafCloudRepository) {}

  /** The gateway address and the instance token to call it with; null when no address is known. */
  async target(
    document: FrameleafDiscoveryDocument,
    instanceId: string,
    signer: FrameleafKeySigner,
    configured: string | null,
  ): Promise<PushGatewayTarget | null> {
    const url = pushGatewayUrl(document, configured);
    if (!url) {
      return null;
    }
    // the gateway takes the ordinary instance token; only the DPoP proof names the push address
    const token = await this.cloud.accessToken(document, instanceId, document.api.replace(/\/+$/, ''), signer);
    return { url, token };
  }

  /** Route one push. */
  async send(target: PushGatewayTarget, request: PushSendRequest): Promise<PushSendResult> {
    return await this.cloud.requestJson(pushSendResultSchema, {
      method: 'POST',
      url: target.url,
      dpop: target.token,
      body: pushSendRequestSchema.parse(request),
    });
  }
}
