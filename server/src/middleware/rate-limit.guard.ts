import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request, Response } from 'express';
import type { FrameleafRequest } from 'src/middleware/frameleaf-via.middleware.js';
import { ImmichCookie, ImmichEnvironment, ImmichHeader, ImmichQuery, MetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { isRemoteVia } from 'src/utils/frameleaf-sign-in.js';

/**
 * FL-161: request limits for sign-in and Frameleaf Cloud endpoints, and a per-address ceiling for
 * remote access, counted in Redis so every API process shares them.
 *
 * - A route marked `@RateLimited(RATE_LIMITS.x)` is limited per client address and, where the request
 *   names one, per principal: the email of a password login, the shared link being unlocked, or the
 *   session or API key presented. The principal is counted as a hash; it never reaches Redis in clear.
 * - Every request the edge worker vouched for as `relay` or `wan` also counts toward
 *   `REMOTE_ACCESS_CEILING` for its address, whatever the route.
 *
 * Going over answers 429 with `Retry-After` (seconds until the window ends) and the error code
 * `rate_limited`. If the counters cannot be reached, remote-access requests are refused (503) and
 * requests from the home network are let through with a warning, so a Redis outage never locks
 * anyone out at home. The limits are documented in `docs/docs/administration/frameleaf-cloud.md`.
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
  /** Requests allowed per principal in one window. */
  principalLimit?: number;
};

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const RATE_LIMITS = Object.freeze({
  /** `POST auth/login`. */
  login: { bucket: 'login', limit: 30, windowSeconds: 10 * MINUTE, principal: 'email', principalLimit: 10 },
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

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

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

export type RateLimitCheck = { key: string; limit: number; windowSeconds: number };

/** The counters one request is checked against, in order. */
export const rateLimitChecks = (request: FrameleafRequest, rule: RateLimitRule | undefined): RateLimitCheck[] => {
  const address = rateLimitAddress(request.frameleafForwarded?.for ?? request.ip ?? request.socket?.remoteAddress);
  const checks: RateLimitCheck[] = [];
  if (isRemoteVia(request.frameleafVia)) {
    checks.push({
      key: `${RATE_LIMIT_KEY_PREFIX}:${REMOTE_ACCESS_CEILING.bucket}:ip:${address}`,
      limit: REMOTE_ACCESS_CEILING.limit,
      windowSeconds: REMOTE_ACCESS_CEILING.windowSeconds,
    });
  }
  if (!rule) {
    return checks;
  }
  checks.push({
    key: `${RATE_LIMIT_KEY_PREFIX}:${rule.bucket}:ip:${address}`,
    limit: rule.limit,
    windowSeconds: rule.windowSeconds,
  });
  const principal = rule.principal && rateLimitPrincipal(request, rule.principal);
  if (principal && rule.principalLimit) {
    checks.push({
      key: `${RATE_LIMIT_KEY_PREFIX}:${rule.bucket}:principal:${hash(principal)}`,
      limit: rule.principalLimit,
      windowSeconds: rule.windowSeconds,
    });
  }
  return checks;
};

export const RATE_LIMITED_MESSAGE = 'Too many requests. Try again later.';

/** Registered before `AuthGuard`, so failed sign-ins and bad credentials count too. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private logger: LoggingRepository,
    private reflector: Reflector,
    private rateLimitRepository: RateLimitRepository,
    private configRepository: ConfigRepository,
  ) {
    this.logger.setContext(RateLimitGuard.name);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const http = context.switchToHttp();
    const request = http.getRequest<FrameleafRequest>();
    const testing = this.configRepository.getEnv().environment === ImmichEnvironment.Testing;
    const rule = testing
      ? undefined
      : this.reflector.get<RateLimitRule | undefined>(MetadataKey.RateLimit, context.getHandler());
    const remote = isRemoteVia(request.frameleafVia);

    for (const check of rateLimitChecks(request, rule)) {
      const hit = await this.rateLimitRepository.hit(check.key, check.windowSeconds).catch((error: unknown) => {
        if (remote) {
          this.logger.error(`Rate limit counters are unavailable; remote-access request refused: ${error}`);
          throw new ServiceUnavailableException('This server is busy. Try again in a moment.');
        }
        this.logger.warn(`Rate limit counters are unavailable; request from the home network allowed: ${error}`);
        return null;
      });
      if (!hit) {
        return true;
      }
      if (hit.count > check.limit) {
        http.getResponse<Response>().setHeader('Retry-After', String(hit.resetSeconds));
        throw new HttpException(
          {
            message: RATE_LIMITED_MESSAGE,
            error: 'Too Many Requests',
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            code: 'rate_limited',
            retryAfter: hit.resetSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return true;
  }
}
