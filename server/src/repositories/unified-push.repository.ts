import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PublicFetchError, checkWebhookUrl, sendWebhook } from 'src/utils/public-fetch.js';
import { type WebPushKeys, encryptWebPush } from 'src/utils/web-push.js';

/** A device's UnifiedPush registration: where to POST, and the Web Push keys to encrypt to. */
export type UnifiedPushSubscription = WebPushKeys & { endpoint: string };

/** One message: the plaintext the device decrypts, and the Web Push delivery headers (RFC 8030). */
export type UnifiedPushMessage = {
  plaintext: Buffer;
  ttlSec: number;
  urgency: 'high' | 'normal';
  /** Replaces an undelivered message with the same topic (a notice's collapse id). */
  topic?: string;
};

/**
 * - `sent`: the push server accepted it;
 * - `gone`: 404 or 410, the endpoint no longer exists: the device must be unregistered;
 * - `retry`: 429 or a server error or a network failure, try again later (after `retryAfterSec` when given);
 * - `refused`: anything else, including an address this server may not reach; never retried.
 */
export type UnifiedPushSendResult =
  | { status: 'sent' }
  | { status: 'gone' }
  | { status: 'retry'; retryAfterSec?: number }
  | { status: 'refused'; reason: string };

/** The longest `Retry-After` honoured; a later one is clamped (the delivery job's own attempts stay bounded). */
export const UNIFIED_PUSH_MAX_RETRY_AFTER_SEC = 6 * 3600;

const REFUSED_ADDRESS =
  'The UnifiedPush server is not at a public https address; an administrator can allow push servers on this network';

/** `Retry-After` in seconds (delta-seconds or an HTTP date), clamped to 1 s .. 6 h; undefined when absent or unreadable. */
export const parseRetryAfter = (value: string | null | undefined, now = Date.now()): number | undefined => {
  if (!value) {
    return;
  }
  const trimmed = value.trim();
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : (Date.parse(trimmed) - now) / 1000;
  if (!Number.isFinite(seconds)) {
    return;
  }
  return Math.min(UNIFIED_PUSH_MAX_RETRY_AFTER_SEC, Math.max(1, Math.ceil(seconds)));
};

/** A Web Push `Topic` is at most 32 URL-safe base64 characters; a longer or other collapse id is hashed to one. */
export const unifiedPushTopicOf = (collapseId: string | undefined): string | undefined => {
  if (!collapseId) {
    return;
  }
  return /^[\w-]{1,32}$/.test(collapseId)
    ? collapseId
    : createHash('sha256').update(collapseId).digest('hex').slice(0, 32);
};

/**
 * FL-926: delivers phone pushes to a device's UnifiedPush distributor (ntfy and others), with no
 * Frameleaf Cloud link. Each message is Web Push encrypted (RFC 8291, aes128gcm) to the device's keys,
 * so the distributor sees only an opaque body. No VAPID header is sent: ntfy and the other common
 * distributors do not need one.
 *
 * The endpoint is typed by the device, so it gets the outbound address checks automations get
 * (`sendWebhook`): https to a public address only, checked before connecting and again for every DNS
 * answer while connecting (no rebinding window), no redirects. When the administrator allows push
 * servers on this network, private addresses (and plain http to them) are allowed too; loopback,
 * link-local and cloud metadata addresses never are. Bodies and endpoints are never logged.
 */
@Injectable()
export class UnifiedPushRepository {
  /** Static checks on an endpoint (scheme, credentials, IP literals, local names); throws with a plain reason. */
  checkEndpoint(endpoint: string, { allowLocalTargets }: { allowLocalTargets: boolean }): void {
    try {
      checkWebhookUrl(endpoint, allowLocalTargets);
    } catch (error) {
      if (error instanceof PublicFetchError || error instanceof TypeError) {
        throw new PublicFetchError(REFUSED_ADDRESS);
      }
      throw error;
    }
  }

  async send(
    subscription: UnifiedPushSubscription,
    message: UnifiedPushMessage,
    { allowLocalTargets }: { allowLocalTargets: boolean },
  ): Promise<UnifiedPushSendResult> {
    let body: Buffer;
    try {
      body = encryptWebPush(message.plaintext, subscription);
    } catch (error) {
      return { status: 'refused', reason: error instanceof Error ? error.message : String(error) };
    }
    const headers = new Headers({
      'content-type': 'application/octet-stream',
      'content-encoding': 'aes128gcm',
      ttl: String(message.ttlSec),
      urgency: message.urgency,
    });
    const topic = unifiedPushTopicOf(message.topic);
    if (topic) {
      headers.set('topic', topic);
    }

    let response;
    try {
      response = await sendWebhook(
        subscription.endpoint,
        { method: 'POST', headers, body },
        { allowHomeNetwork: allowLocalTargets, discardBody: true },
      );
    } catch (error) {
      if (error instanceof PublicFetchError) {
        return { status: 'refused', reason: REFUSED_ADDRESS };
      }
      // a timeout, a refused connection or a DNS failure: the push server may be back later
      return { status: 'retry' };
    }

    if (response.status >= 200 && response.status < 300) {
      return { status: 'sent' };
    }
    if (response.status === 404 || response.status === 410) {
      return { status: 'gone' };
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfterSec = parseRetryAfter(response.headers?.get('retry-after'));
      return { status: 'retry', ...(retryAfterSec && { retryAfterSec }) };
    }
    if (response.status >= 300 && response.status < 400) {
      return {
        status: 'refused',
        reason: `The UnifiedPush server redirected (${response.status}); redirects are not followed`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'refused',
        reason: `The UnifiedPush server refused the message (${response.status}); it may need VAPID, which Frameleaf does not send yet`,
      };
    }
    return { status: 'refused', reason: `The UnifiedPush server refused the message (${response.status})` };
  }
}
