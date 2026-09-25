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
  refusalFromCloudError,
  tokenResponseSchema,
} from 'src/utils/frameleaf-cloud.js';

export type FrameleafCloudRequest = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Absolute URL; always built from the configured cloud address or from discovery. */
  url: string;
  bearer?: string;
  body?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
};

export type FrameleafClientAssertionSigner = (claims: Record<string, unknown>) => string;

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
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();

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

  /**
   * A short-lived access token for `resource`, from the `client_credentials` grant with a
   * `private_key_jwt` client assertion (EdDSA, `iss = sub = client_id = instanceId`,
   * `aud = <issuer>/token`, `jti`, at most five minutes). Cached until shortly before expiry;
   * nothing is persisted.
   */
  async accessToken(
    document: FrameleafDiscoveryDocument,
    instanceId: string,
    resource: string,
    signAssertion: FrameleafClientAssertionSigner,
    now = Date.now(),
  ): Promise<string> {
    const cacheKey = `${instanceId} ${resource}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - FRAMELEAF_CLOUD_TOKEN_REFRESH_MARGIN_MS > now) {
      return cached.token;
    }
    const tokenEndpoint = `${document.issuer.replace(/\/+$/, '')}/token`;
    const issuedAt = Math.floor(now / 1000);
    const assertion = signAssertion({
      iss: instanceId,
      sub: instanceId,
      aud: tokenEndpoint,
      jti: randomUUID(),
      iat: issuedAt,
      exp: issuedAt + FRAMELEAF_CLOUD_ASSERTION_TTL_SECONDS,
    });
    const response = await this.requestJson(tokenResponseSchema, {
      method: 'POST',
      url: tokenEndpoint,
      form: {
        grant_type: 'client_credentials',
        client_id: instanceId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        resource,
        scope: 'instance',
      },
    });
    this.tokenCache.set(cacheKey, { token: response.access_token, expiresAt: now + response.expires_in * 1000 });
    return response.access_token;
  }

  /** Forget cached tokens and discovery, for example after the link changed or a 401. */
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
  async requestJson<T extends z.ZodType>(schema: T, request: FrameleafCloudRequest): Promise<z.infer<T>> {
    const headers: Record<string, string> = { Accept: 'application/json', ...request.headers };
    let body: string | undefined;
    if (request.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(request.form).toString();
    } else if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request.body);
    }
    if (request.bearer) {
      headers.Authorization = `Bearer ${request.bearer}`;
    }

    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method ?? 'GET',
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

    const text = await this.readBounded(response);
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
      if (response.status === 401) {
        this.tokenCache.clear();
      }
      throw new FrameleafCloudError(
        refusal,
        response.status,
        envelope?.message || oauth?.error_description || `Frameleaf Cloud answered ${response.status}`,
        envelope,
        oauth,
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
