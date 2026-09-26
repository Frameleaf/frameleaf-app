import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import z from 'zod';
import { MlAdmissionRefusal } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  FRAMELEAF_CLOUD_ASSERTION_TTL_SECONDS,
  FRAMELEAF_CLOUD_MAX_BODY_BYTES,
  FRAMELEAF_CLOUD_TIMEOUT_MS,
  FRAMELEAF_CLOUD_TOKEN_REFRESH_MARGIN_MS,
  FrameleafCloudError,
  FrameleafDiscoveryDocument,
  discoveryProblem,
  discoverySchema,
  errorEnvelopeSchema,
  oauthErrorSchema,
  parseRetryAfter,
  refusalFromCloudError,
  tokenResponseSchema,
} from 'src/utils/frameleaf-cloud.js';
import {
  DPOP_NONCE_HEADER,
  FrameleafInstanceToken,
  FrameleafKeySigner,
  boundTokenProblem,
  createDpopProof,
  isNonceChallenge,
  isUsableNonce,
  signClientAssertion,
} from 'src/utils/frameleaf-dpop.js';

export type FrameleafCloudRequest = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Absolute URL; always built from the configured cloud address or from discovery. */
  url: string;
  /** A plain bearer credential (the link token, the initial access token); never an instance token. */
  bearer?: string;
  /**
   * RFC 9449 (FL-178): an instance token and the key it is bound to, sent as `Authorization: DPoP`
   * with a proof carrying `ath`; or a key alone, for a proof without `ath` (the token request, and
   * registering the key being linked).
   */
  dpop?: { signer: FrameleafKeySigner; accessToken?: string };
  body?: unknown;
  form?: Record<string, string>;
  /** FL-177: a body sent as it is, for example a compact JWS as `application/jose`. */
  raw?: { contentType: string; body: string };
  headers?: Record<string, string>;
};

/**
 * One answer: whether it was a DPoP nonce challenge, the nonce the proof carried, and the usable
 * `DPoP-Nonce` the answer itself carried (the retry uses that one, not whatever a parallel call
 * stored for the origin meanwhile).
 */
type Exchange = {
  response: Response;
  text: string;
  nonceChallenge: boolean;
  nonceUsed?: string;
  nonceReceived?: string;
};

/**
 * The HTTP side of Frameleaf Cloud (FL-159; the part of FL-155's `frameleaf-cloud.repository.ts`
 * cloud processing needs): service discovery, short-lived access tokens from a signed client
 * assertion, and one bounded JSON request helper.
 *
 * Every address comes from the deployment's `FRAMELEAF_CLOUD_URL` or from the discovery document
 * it serves; nothing here is hard-coded. Redirects are refused, bodies are capped, and any failure
 * is a `FrameleafCloudError` carrying the admission refusal it means, so callers refuse in place.
 */
@Injectable()
export class FrameleafCloudRepository {
  private discoveryCache?: { cloudUrl: string; document: FrameleafDiscoveryDocument; validUntil: number };
  /** Instance tokens by instance, resource and the thumbprint of the key they are bound to. */
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();
  /**
   * The last DPoP nonce each origin sent (RFC 9449 section 8), replaced whenever an answer carries a
   * new one. Nonces are not credentials, so `forget` keeps them.
   */
  private nonces = new Map<string, string>();

  constructor(private logger: LoggingRepository) {
    this.logger.setContext(FrameleafCloudRepository.name);
  }

  /** `GET <cloud>/.well-known/frameleaf-services`, cached for its `validFor`. */
  async discovery(cloudUrl: string, now = Date.now()): Promise<FrameleafDiscoveryDocument> {
    if (this.discoveryCache?.cloudUrl === cloudUrl && this.discoveryCache.validUntil > now) {
      return this.discoveryCache.document;
    }
    const document = await this.requestJson(discoverySchema, {
      url: `${cloudUrl}/.well-known/frameleaf-services`,
    });
    // No token request or assertion ever goes to an address outside the configured cloud.
    const problem = discoveryProblem(cloudUrl, document);
    if (problem) {
      throw new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, null, `Frameleaf Cloud refused: ${problem}`);
    }
    this.discoveryCache = { cloudUrl, document, validUntil: now + document.validFor * 1000 };
    return document;
  }

  /** The discovery document this process holds for `cloudUrl` and still may use, without any call. */
  peekDiscovery(cloudUrl: string, now = Date.now()): FrameleafDiscoveryDocument | null {
    return this.discoveryCache?.cloudUrl === cloudUrl && this.discoveryCache.validUntil > now
      ? this.discoveryCache.document
      : null;
  }

  /**
   * A short-lived DPoP-bound access token for `resource` (FL-159, FL-178): the `client_credentials`
   * grant with a `private_key_jwt` client assertion (EdDSA, `iss = sub = client_id = instanceId`,
   * `aud = <issuer>/token`, `jti`, at most five minutes) and a DPoP proof (no `ath`), both signed by
   * `signer`'s key. The answer must be a `DPoP` token bound to that key (`cnf.jkt`, and
   * `frameleaf_kid` when present). A `use_dpop_nonce` answer is retried once with the nonce it sent
   * and a fresh assertion. Cached per key until shortly before expiry; nothing is persisted.
   */
  async accessToken(
    document: FrameleafDiscoveryDocument,
    instanceId: string,
    resource: string,
    signer: FrameleafKeySigner,
    now = Date.now(),
  ): Promise<FrameleafInstanceToken> {
    const cacheKey = `${instanceId} ${resource} ${signer.kid}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - FRAMELEAF_CLOUD_TOKEN_REFRESH_MARGIN_MS > now) {
      return { accessToken: cached.token, signer };
    }
    const tokenEndpoint = `${document.issuer.replace(/\/+$/, '')}/token`;
    const response = await this.exchangeJson(tokenResponseSchema, () => {
      const issuedAt = Math.floor(now / 1000);
      return {
        method: 'POST',
        url: tokenEndpoint,
        dpop: { signer },
        form: {
          grant_type: 'client_credentials',
          client_id: instanceId,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          // a new jti for every attempt: the one a nonce challenge refused may count as used
          client_assertion: signClientAssertion(signer, {
            iss: instanceId,
            sub: instanceId,
            aud: tokenEndpoint,
            jti: randomUUID(),
            iat: issuedAt,
            exp: issuedAt + FRAMELEAF_CLOUD_ASSERTION_TTL_SECONDS,
          }),
          resource,
          scope: 'instance',
        },
      };
    });
    const problem = boundTokenProblem(response, signer);
    if (problem) {
      throw new FrameleafCloudError(
        MlAdmissionRefusal.CloudUnavailable,
        200,
        `Frameleaf Cloud issued a token this server will not use: ${problem}`,
      );
    }
    // a token minted with another key of this server (one a rotation replaced) is never used again
    for (const key of this.tokenCache.keys()) {
      if (key.startsWith(`${instanceId} ${resource} `)) {
        this.tokenCache.delete(key);
      }
    }
    this.tokenCache.set(cacheKey, { token: response.access_token, expiresAt: now + response.expires_in * 1000 });
    return { accessToken: response.access_token, signer };
  }

  /**
   * Forget cached tokens and discovery, for example after the link changed, a key rotation (tokens are
   * bound to the key that minted them) or a 401 that refused a token.
   */
  forget() {
    this.discoveryCache = undefined;
    this.tokenCache.clear();
  }

  /**
   * One OAuth request (device authorization, device-code poll, registration): like `requestJson`,
   * but an OAuth error answer (`{error, error_description}`, RFC 6749 section 5.2) comes back as a
   * value instead of a thrown error, so the caller can honour `authorization_pending`, `slow_down`,
   * `expired_token` and `access_denied`. Unreachable clouds and unreadable answers still throw.
   */
  async requestOAuth<T extends z.ZodType>(
    schema: T,
    request: FrameleafCloudRequest,
  ): Promise<{ ok: true; data: z.infer<T> } | { ok: false; status: number; error: string; description?: string }> {
    try {
      return { ok: true, data: await this.requestJson(schema, request) };
    } catch (error) {
      if (!(error instanceof FrameleafCloudError) || error.status === null || error.status < 400 || !error.oauth) {
        throw error;
      }
      return { ok: false, status: error.status, error: error.oauth.error, description: error.oauth.error_description };
    }
  }

  /** One JSON request: bounded, no redirects, validated against `schema`. */
  requestJson<T extends z.ZodType>(schema: T, request: FrameleafCloudRequest): Promise<z.infer<T>> {
    return this.exchangeJson(schema, () => request);
  }

  /**
   * `requestJson` for a request built by `build`, which is called again for the one retry a DPoP
   * nonce challenge gets (FL-178), so a retried request can carry fresh one-time values. Each attempt
   * signs a fresh proof with the origin's latest nonce.
   */
  private async exchangeJson<T extends z.ZodType>(schema: T, build: () => FrameleafCloudRequest): Promise<z.infer<T>> {
    let request = build();
    let exchange = await this.exchange(request);
    // retried once, and only when the challenge itself brought a nonce this attempt did not already use
    const nonce = exchange.nonceReceived;
    if (request.dpop && exchange.nonceChallenge && nonce && nonce !== exchange.nonceUsed) {
      request = build();
      exchange = await this.exchange(request, nonce);
    }
    const { response, text } = exchange;
    if (!response.ok) {
      let envelope = null;
      let oauth = null;
      try {
        const body = JSON.parse(text);
        const parsed = errorEnvelopeSchema.safeParse(body);
        envelope = parsed.success ? parsed.data : null;
        const oauthParsed = oauthErrorSchema.safeParse(body);
        oauth = oauthParsed.success ? oauthParsed.data : null;
      } catch {
        // an unreadable body carries no envelope; the status decides the refusal
      }
      const refusal = refusalFromCloudError(response.status, envelope);
      // a nonce challenge says nothing about the token, so it never costs the cached tokens (FL-178)
      if (response.status === 401 && !exchange.nonceChallenge) {
        this.tokenCache.clear();
      }
      throw new FrameleafCloudError(
        refusal,
        response.status,
        envelope?.message || oauth?.error_description || `Frameleaf Cloud answered ${response.status}`,
        envelope,
        oauth,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }

    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new FrameleafCloudError(
        MlAdmissionRefusal.CloudUnavailable,
        response.status,
        'Frameleaf Cloud sent invalid JSON',
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn(`Frameleaf Cloud response from ${new URL(request.url).pathname} failed validation`);
      throw new FrameleafCloudError(
        MlAdmissionRefusal.CloudUnavailable,
        response.status,
        'Frameleaf Cloud sent a response this server does not understand',
      );
    }
    return parsed.data;
  }

  /**
   * One HTTP exchange. With `dpop`, a proof by its key goes in the `DPoP` header (with `nonce`, else
   * the origin's latest nonce, and `ath` when a token is presented as `Authorization: DPoP <token>`).
   * Any `DPoP-Nonce` the answer carries replaces the origin's nonce.
   */
  private async exchange(request: FrameleafCloudRequest, nonce?: string): Promise<Exchange> {
    const method = request.method ?? 'GET';
    const origin = new URL(request.url).origin;
    const headers: Record<string, string> = { Accept: 'application/json', ...request.headers };
    let body: string | undefined;
    if (request.raw) {
      headers['Content-Type'] = request.raw.contentType;
      body = request.raw.body;
    } else if (request.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(request.form).toString();
    } else if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request.body);
    }
    if (request.bearer && request.dpop?.accessToken) {
      throw new Error('A Frameleaf Cloud request carries either a bearer credential or a DPoP token, not both');
    }
    if (request.bearer) {
      headers.Authorization = `Bearer ${request.bearer}`;
    }
    let nonceUsed: string | undefined;
    if (request.dpop) {
      nonceUsed = nonce ?? this.nonces.get(origin);
      const { signer, accessToken } = request.dpop;
      headers.DPoP = createDpopProof(signer, { htm: method, htu: request.url, nonce: nonceUsed, accessToken });
      if (accessToken) {
        headers.Authorization = `DPoP ${accessToken}`;
      }
    }

    let response: Response;
    try {
      response = await fetch(request.url, {
        method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(FRAMELEAF_CLOUD_TIMEOUT_MS),
      });
    } catch (error) {
      throw new FrameleafCloudError(
        MlAdmissionRefusal.CloudUnavailable,
        null,
        `Frameleaf Cloud did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const answered = response.headers.get(DPOP_NONCE_HEADER);
    const nonceReceived = isUsableNonce(answered) ? answered : undefined;
    if (nonceReceived) {
      this.nonces.set(origin, nonceReceived);
    }
    const text = await this.readBounded(response);
    let nonceChallenge = false;
    if (!response.ok) {
      let code: string | undefined;
      try {
        const parsed = JSON.parse(text) as { code?: unknown; error?: unknown } | null;
        const value = parsed?.code ?? parsed?.error;
        code = typeof value === 'string' ? value : undefined;
      } catch {
        // no readable body; the WWW-Authenticate header may still carry the challenge
      }
      nonceChallenge = isNonceChallenge(response.status, code, response.headers.get('www-authenticate'));
    }
    return { response, text, nonceChallenge, nonceUsed, nonceReceived };
  }

  private async readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      return '';
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
        if (size > FRAMELEAF_CLOUD_MAX_BODY_BYTES) {
          throw new FrameleafCloudError(
            MlAdmissionRefusal.CloudUnavailable,
            response.status,
            'Frameleaf Cloud response is too large',
          );
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
