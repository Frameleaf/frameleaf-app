import {
  CallHandler,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isIP } from 'node:net';
import { Observable, catchError, from, mergeMap, throwError } from 'rxjs';
import type { Request, Response } from 'express';
import type { FrameleafRequest } from 'src/middleware/frameleaf-via.middleware.js';
import { ImmichCookie, ImmichEnvironment, ImmichHeader, ImmichQuery, MetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { identityDirectory } from 'src/utils/frameleaf-cloud-gateway.js';
import { isRemoteVia } from 'src/utils/frameleaf-sign-in.js';

/**
 * FL-161: request limits for sign-in and Frameleaf Cloud endpoints, and a per-address ceiling for
 * remote access, counted in Redis so every API process shares them.
 *
 * - A route marked `@RateLimited(RATE_LIMITS.x)` is limited per client address and, where the request
 *   names one, per principal: the email of a password login, the shared link being unlocked, or the
 *   session or API key presented. The principal is counted as an HMAC under this server's own key
 *   (`CryptoRepository.serverKeyedHash`); it never reaches Redis in clear or as a plain hash.
 * - For a password login and a shared-link unlock the principal counts only failed attempts (401,
 *   counted by `RateLimitFailureInterceptor`), so a stranger's wrong passwords from many addresses
 *   lock only the attempts, and a person who signs in correctly never uses up the limit.
 * - Every request the edge worker vouched for as `relay` or `wan` also counts toward
 *   `REMOTE_ACCESS_CEILING` for its address, except thumbnails and previews
 *   (`@RemoteCeilingExempt()`), which a timeline requests by the hundred. The edge worker must send
 *   `X-Forwarded-For`, or every remote visitor shares the loopback address's counter.
 * - The client address is Express's `request.ip`: behind a reverse proxy on an address outside the
 *   private ranges (for example a Tailscale `100.64.0.0/10` address), set `IMMICH_TRUSTED_PROXIES`,
 *   or every visitor shares the proxy's counter.
 *
 * Going over answers 429 with `Retry-After` (seconds until the window ends) and the error code
 * `rate_limited`. If the counters cannot be reached, remote-access requests are refused (503) and
 * requests from the home network are let through with a warning, so a Redis outage never locks
 * anyone out at home. The 503 carries `Retry-After`. The limits are documented in `docs/docs/administration/frameleaf-cloud.md`.
 *
 * The route limits are not applied when `IMMICH_ENV=testing` (the end-to-end suites sign in hundreds
 * of times from one address); the remote-access ceiling always is.
 */

export type RateLimitPrincipal = 'email' | 'shared-link' | 'credential';

export type RateLimitRule = {
  /** Name of the counter; routes with the same bucket share it. */
  bucket: string;
  /** Requests allowed per client address in one window. */
  limit: number;
  windowSeconds: number;
  /** What identifies the principal of a request, when the request names one. */
  principal?: RateLimitPrincipal;
  /** Requests (or failures, see `principalCounts`) allowed per principal in one window. */
  principalLimit?: number;
  /** `failures`: the principal counts only attempts that failed with 401. Defaults to every request. */
  principalCounts?: 'requests' | 'failures';
};

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const RATE_LIMITS = Object.freeze({
  /** `POST auth/login`. */
  login: {
    bucket: 'login',
    limit: 30,
    windowSeconds: 10 * MINUTE,
    principal: 'email',
    principalLimit: 10,
    principalCounts: 'failures',
  },
  /** The administrator's own provider: `POST oauth/callback` and `POST oauth/link`. */
  oauthCallback: {
    bucket: 'oauth-callback',
    limit: 30,
    windowSeconds: 10 * MINUTE,
    principal: 'credential',
    principalLimit: 30,
  },
  /** Every `oauth/frameleaf/*` route (Sign in with Frameleaf, handoff, account link). */
  frameleafSignIn: {
    bucket: 'frameleaf-sign-in',
    limit: 60,
    windowSeconds: 10 * MINUTE,
    principal: 'credential',
    principalLimit: 60,
  },
  /** `POST shared-links/login`. */
  sharedLinkLogin: {
    bucket: 'shared-link-login',
    limit: 30,
    windowSeconds: 10 * MINUTE,
    principal: 'shared-link',
    principalLimit: 60,
    principalCounts: 'failures',
  },
  /** Licence activation: `PUT admin/license/activate`, `PUT admin/license/certificate`, `PUT users/me/license`. */
  licenseActivation: {
    bucket: 'license-activation',
    limit: 10,
    windowSeconds: HOUR,
    principal: 'credential',
    principalLimit: 10,
  },
  /** Starting a link to Frameleaf Cloud: `POST admin/cloud/link`. */
  linkStart: { bucket: 'link-start', limit: 10, windowSeconds: HOUR, principal: 'credential', principalLimit: 10 },
} satisfies Record<string, RateLimitRule>);

/** Every request arriving through the relay or a direct connection from outside, per client address. */
export const REMOTE_ACCESS_CEILING = Object.freeze({ bucket: 'remote-access', limit: 1200, windowSeconds: MINUTE });

export const RATE_LIMIT_KEY_PREFIX = 'frameleaf:rate-limit';

export const RateLimited = (rule: RateLimitRule): MethodDecorator => SetMetadata(MetadataKey.RateLimit, rule);

/** Leaves a route (thumbnails and previews) out of the remote-access ceiling; its own limits still apply. */
export const RemoteCeilingExempt = (): MethodDecorator => SetMetadata(MetadataKey.RemoteCeilingExempt, true);

/** Seconds a client is asked to wait when the counters are unavailable. */
export const COUNTERS_UNAVAILABLE_RETRY_AFTER = 30;

/** Expand an IPv6 address to its eight groups (`::` filled with zeros). */
const ipv6Groups = (address: string): string[] => {
  const pad = (group: string) => group.padStart(4, '0').toLowerCase();
  const gap = address.indexOf('::');
  if (gap === -1) {
    return address.split(':').map((group) => pad(group));
  }
  const head = address.slice(0, gap);
  const tail = address.slice(gap + 2);
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = Array.from({ length: Math.max(0, 8 - left.length - right.length) }, () => '0');
  return [...left, ...fill, ...right].map((group) => pad(group));
};

/**
 * The address a client is counted by: an IPv4 address as it is (an IPv4-mapped IPv6 address as
 * IPv4), an IPv6 address by its /64, since one household or host usually holds a whole /64.
 */
export const rateLimitAddress = (address: string | undefined | null): string => {
  const value = (address ?? '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  switch (isIP(value)) {
    case 4: {
      return value;
    }
    case 6: {
      const groups = ipv6Groups(value.split('%', 1)[0]);
      return `${groups.slice(0, 4).join(':')}::/64`;
    }
    default: {
      return 'unknown';
    }
  }
};

const text = (value: unknown): string | undefined => {
  const first = Array.isArray(value) ? (value[0] as unknown) : value;
  return typeof first === 'string' && first.length > 0 ? first : undefined;
};

/** The session token or API key a request presents, from the same places authentication reads it. */
const presentedCredential = (request: Request): string | undefined => {
  const headers = request.headers;
  const bearer = text(headers.authorization);
  const cookies = (request.cookies ?? {}) as Record<string, unknown>;
  const query = (request.query ?? {}) as Record<string, unknown>;
  return (
    text(headers[ImmichHeader.UserToken]) ??
    text(headers[ImmichHeader.SessionToken]) ??
    text(query[ImmichQuery.SessionKey]) ??
    (bearer?.toLowerCase().startsWith('bearer ') ? bearer.slice(7).trim() || undefined : undefined) ??
    text(cookies[ImmichCookie.AccessToken]) ??
    text(headers[ImmichHeader.ApiKey]) ??
    text(query[ImmichQuery.ApiKey])
  );
};

/** The principal a request names for a rule, if any. */
export const rateLimitPrincipal = (request: Request, principal: RateLimitPrincipal): string | undefined => {
  switch (principal) {
    case 'email': {
      const email = text((request.body as Record<string, unknown> | undefined)?.email);
      return email ? `email:${email.trim().toLowerCase()}` : undefined;
    }
    case 'shared-link': {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const key = text(request.headers[ImmichHeader.SharedLinkKey]) ?? text(query[ImmichQuery.SharedLinkKey]);
      const slug = text(request.headers[ImmichHeader.SharedLinkSlug]) ?? text(query[ImmichQuery.SharedLinkSlug]);
      if (key) {
        return `key:${key}`;
      }
      return slug ? `slug:${slug}` : undefined;
    }
    case 'credential': {
      const credential = presentedCredential(request);
      return credential ? `credential:${credential}` : undefined;
    }
  }
};

export type RateLimitCheck = {
  key: string;
  limit: number;
  windowSeconds: number;
  /** `failures`: only read here; a failed attempt is counted afterwards. */
  counts: 'requests' | 'failures';
};

/**
 * The counters one request is checked against, in order. `keyOf` turns a principal into its key
 * (a keyed hash); the addresses are used as they are.
 */
export const rateLimitChecks = async (
  request: FrameleafRequest,
  rule: RateLimitRule | undefined,
  options: { ceiling: boolean; keyOf: (principal: string) => Promise<string> },
): Promise<RateLimitCheck[]> => {
  const address = rateLimitAddress(request.frameleafForwarded?.for ?? request.ip ?? request.socket?.remoteAddress);
  const checks: RateLimitCheck[] = [];
  if (options.ceiling && isRemoteVia(request.frameleafVia)) {
    checks.push({
      key: `${RATE_LIMIT_KEY_PREFIX}:${REMOTE_ACCESS_CEILING.bucket}:ip:${address}`,
      limit: REMOTE_ACCESS_CEILING.limit,
      windowSeconds: REMOTE_ACCESS_CEILING.windowSeconds,
      counts: 'requests',
    });
  }
  if (!rule) {
    return checks;
  }
  checks.push({
    key: `${RATE_LIMIT_KEY_PREFIX}:${rule.bucket}:ip:${address}`,
    limit: rule.limit,
    windowSeconds: rule.windowSeconds,
    counts: 'requests',
  });
  const principal = rule.principal && rateLimitPrincipal(request, rule.principal);
  if (principal && rule.principalLimit) {
    checks.push({
      key: `${RATE_LIMIT_KEY_PREFIX}:${rule.bucket}:principal:${await options.keyOf(principal)}`,
      limit: rule.principalLimit,
      windowSeconds: rule.windowSeconds,
      counts: rule.principalCounts ?? 'requests',
    });
  }
  return checks;
};

/** Where the guard leaves the failure-counted checks of a request for the interceptor. */
export interface RateLimitedRequest extends FrameleafRequest {
  frameleafRateLimitFailures?: RateLimitCheck[];
}

export const RATE_LIMITED_MESSAGE = 'Too many requests. Try again later.';

const tooManyRequests = (response: Response, resetSeconds: number) => {
  response.setHeader('Retry-After', String(resetSeconds));
  return new HttpException(
    {
      message: RATE_LIMITED_MESSAGE,
      error: 'Too Many Requests',
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: 'rate_limited',
      retryAfter: resetSeconds,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
};

/** Registered before `AuthGuard`, so failed sign-ins and bad credentials count too. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private logger: LoggingRepository,
    private reflector: Reflector,
    private rateLimitRepository: RateLimitRepository,
    private configRepository: ConfigRepository,
    private cryptoRepository: CryptoRepository,
  ) {
    this.logger.setContext(RateLimitGuard.name);
    if (this.testing()) {
      this.logger.warn(
        'IMMICH_ENV=testing turns off the sign-in rate limits. It is meant for the automated test suites only; unset it on a server people use.',
      );
    }
  }

  private testing() {
    return this.configRepository.getEnv().environment === ImmichEnvironment.Testing;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const http = context.switchToHttp();
    const request = http.getRequest<RateLimitedRequest>();
    const handler = context.getHandler();
    const rule = this.testing()
      ? undefined
      : this.reflector.get<RateLimitRule | undefined>(MetadataKey.RateLimit, handler);
    const ceiling = !this.reflector.get<boolean | undefined>(MetadataKey.RemoteCeilingExempt, handler);
    const remote = isRemoteVia(request.frameleafVia);

    const unavailable = (error: unknown): null => {
      if (remote) {
        this.logger.error(`Rate limit counters are unavailable; remote-access request refused: ${error}`);
        http.getResponse<Response>().setHeader('Retry-After', String(COUNTERS_UNAVAILABLE_RETRY_AFTER));
        throw new ServiceUnavailableException('This server is busy. Try again in a moment.');
      }
      this.logger.warn(`Rate limit counters are unavailable; request from the home network allowed: ${error}`);
      return null;
    };

    const checks = await rateLimitChecks(request, rule, {
      ceiling,
      keyOf: (principal) =>
        this.cryptoRepository.serverKeyedHash(identityDirectory(this.configRepository), 'rate-limit', principal),
    }).catch(unavailable);
    if (!checks) {
      return true;
    }

    const failures: RateLimitCheck[] = [];
    for (const check of checks) {
      const counted = check.counts === 'failures';
      const hit = await (
        counted
          ? this.rateLimitRepository.peek(check.key)
          : this.rateLimitRepository.hit(check.key, check.windowSeconds)
      ).catch(unavailable);
      if (!hit) {
        return true;
      }
      // a request counter includes this request; a failure counter only the failures so far
      if (counted ? hit.count >= check.limit : hit.count > check.limit) {
        throw tooManyRequests(http.getResponse<Response>(), hit.resetSeconds);
      }
      if (counted) {
        failures.push(check);
      }
    }
    if (failures.length > 0) {
      request.frameleafRateLimitFailures = failures;
    }
    return true;
  }
}

/**
 * Counts a failed attempt (401) against the failure-counted principal checks the guard left on the
 * request: a wrong password for an email, a wrong password for a shared link.
 */
@Injectable()
export class RateLimitFailureInterceptor implements NestInterceptor {
  constructor(
    private logger: LoggingRepository,
    private rateLimitRepository: RateLimitRepository,
  ) {
    this.logger.setContext(RateLimitFailureInterceptor.name);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const checks =
      context.getType() === 'http'
        ? context.switchToHttp().getRequest<RateLimitedRequest>().frameleafRateLimitFailures
        : undefined;
    if (!checks) {
      return next.handle();
    }
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (!(error instanceof HttpException) || error.getStatus() !== HttpStatus.UNAUTHORIZED) {
          return throwError(() => error);
        }
        return from(this.countFailure(checks)).pipe(mergeMap(() => throwError(() => error)));
      }),
    );
  }

  async countFailure(checks: RateLimitCheck[]) {
    for (const check of checks) {
      try {
        await this.rateLimitRepository.hit(check.key, check.windowSeconds);
      } catch (error) {
        this.logger.warn(`A failed attempt could not be counted: ${error}`);
      }
    }
  }
}
