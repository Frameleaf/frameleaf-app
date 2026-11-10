import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { Observable, finalize } from 'rxjs';
import type { AuthRequest } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

const maxArrayLength = 100;
const REDACTED = '********';

/**
 * FL-81: request logs never carry a credential. Names ignore case and separators, so
 * `access_token`, `api_key`, `private-key` and `sessionKey` all match.
 *
 * - Body fields and query parameters whose name says they hold a secret are masked: passwords, PIN
 *   codes, any token (maintenance, OAuth, access, refresh), secrets, API / private / session keys
 *   (`sessionKey` is a full session token, used by cast URLs and widgets), the OAuth PKCE
 *   `codeVerifier`, `state` and `code`, and a shared link's `key` / `slug`.
 * - A body field named `url` keeps only its path: the OAuth callback and link bodies carry `code=` and
 *   `state=` in it, so its whole query string and fragment are masked.
 * - CLD-004: licence keys and link codes (`licenseKey`, `linkCode`) are masked wherever they appear,
 *   and the licence routes and the `/link` page never have their query string recorded at all.
 */
const normalize = (name: string) => name.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
const SECRET_PART =
  /password|passphrase|pincode|token|secret|apikey|privatekey|sessionkey|codeverifier|licen[cs]ekey|linkcode|recovery(?:key|code|kit|phrase|seed)|keyring|(?:wrap(?:ping)?|bucket|encryption|master|root)key/;
const SECRET_EXACT = new Set(['key', 'keys', 'code', 'state', 'slug', 'appleid']);
const isSecretName = (name: string) => {
  const normalized = normalize(name);
  return SECRET_PART.test(normalized) || SECRET_EXACT.has(normalized);
};

const redactUrlQuery = (url: string) => {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : `${url.slice(0, cut)}?${REDACTED}`;
};

/** CLD-004: routes whose query string is never recorded, whatever its parameters are called. */
const DIRECT_UPLOAD_ROUTE = /^\/(?:api\/)?assets\/uploads\/[^/]+\/direct\/?(?:[?#]|$)/i;
const QUERYLESS_ROUTES = /^\/(?:api\/)?(?:link|admin\/license|license|users\/me\/license)(?:[/?#]|$)/i;

// Secret routes can carry numeric key maps, opaque recovery packages or a credential named `value`.
const BODYLESS_ROUTES =
  /^\/(?:api\/)?admin\/(?:cloud\/backup\/(?:check|setup|escrow|key(?:\/.*)?)|buddy-backup\/key(?:\/.*)?|config\/credentials\/[^/]+)\/?$/i;

/**
 * Routes that carry a bearer secret in the path itself: a cast URL's signed token, a render worker's
 * input grant and a gallery's zip ticket. The segment is masked like a query parameter would be.
 */
const PATH_SECRET_ROUTES = [
  /^(\/(?:api\/)?cast\/)[^/?#]+/i,
  /^(\/(?:api\/)?render-workers\/operations\/[^/?#]+\/inputs\/)[^/?#]+/i,
  /^(\/(?:api\/)?photography\/galleries\/[^/?#]+\/zip\/)[^/?#]+/i,
];

const redactPathSecrets = (url: string) => {
  for (const route of PATH_SECRET_ROUTES) {
    if (route.test(url)) {
      return url.replace(route, (_match, prefix: string) => `${prefix}${REDACTED}`);
    }
  }
  return url;
};

export const redactLogUrl = (url: string) => {
  url = redactPathSecrets(url);
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }
  if (QUERYLESS_ROUTES.test(url) || DIRECT_UPLOAD_ROUTE.test(url)) {
    return redactUrlQuery(url);
  }
  const params = new URLSearchParams(url.slice(queryStart + 1));
  let changed = false;
  for (const name of new Set(params.keys())) {
    if (!isSecretName(name)) {
      continue;
    }
    params.set(name, REDACTED);
    changed = true;
  }
  return changed ? `${url.slice(0, queryStart)}?${params.toString()}` : url;
};

/** An ID-like path segment: a UUID or any long opaque value (20+ URL-safe characters with a digit). */
const ID_SEGMENT = /^(?=[^/]*\d)[\w-]{20,}$/;

/**
 * The path written on a request line: path secrets masked, IDs shown as `:id`, and only the names of
 * query parameters kept (every value masked; credential routes keep no query at all).
 */
const MAX_DECODE_ROUNDS = 4;

/**
 * Decodes a segment until it stops changing (so `%2563` → `%63` → `c`). Returns `undefined` when it
 * holds a malformed escape or would still decode after the last round, so the caller masks the whole
 * path instead.
 */
const decodeSegment = (segment: string): string | undefined => {
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round++) {
    let next: string;
    try {
      next = decodeURIComponent(segment);
    } catch {
      // a malformed escape (`%63ast%`) cannot be canonicalized, so it is not trusted either
      return undefined;
    }
    if (next === segment) {
      return segment;
    }
    if (round === MAX_DECODE_ROUNDS) {
      return undefined;
    }
    segment = next;
  }
  return undefined;
};

/**
 * The canonical form of the path, so an unusual spelling (`/api//cast/…`, `/api/./cast/…`,
 * `/api/%63ast/…`, `/api/%2563ast/…`) still meets the secret-route patterns: segments are decoded,
 * empty and `.` segments dropped and `..` resolved; a decoded `/`, `?` or `#` is re-encoded so it
 * cannot create a segment or a query. `undefined` when a segment is encoded too many times to trust.
 */
const canonicalPath = (url: string): string | undefined => {
  const cut = url.search(/[?#]/);
  const segments: string[] = [];
  for (const raw of (cut === -1 ? url : url.slice(0, cut)).split('/')) {
    const segment = decodeSegment(raw);
    if (segment === undefined) {
      return undefined;
    }
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment.replaceAll(/[/?#]/g, (char) => encodeURIComponent(char)));
  }
  return `/${segments.join('/')}${cut === -1 ? '' : url.slice(cut)}`;
};

export const requestLogPath = (url: string) => {
  const canonical = canonicalPath(url);
  if (canonical === undefined) {
    return `/${REDACTED}`;
  }
  const masked = redactPathSecrets(canonical);
  const cut = masked.search(/[?#]/);
  const path = (cut === -1 ? masked : masked.slice(0, cut))
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
  if (cut === -1 || masked[cut] === '#') {
    return path;
  }
  if (QUERYLESS_ROUTES.test(masked) || DIRECT_UPLOAD_ROUTE.test(masked)) {
    return `${path}?${REDACTED}`;
  }
  const names = [...new Set(new URLSearchParams(masked.slice(cut + 1).split('#', 1)[0]).keys())];
  return names.length === 0
    ? path
    : `${path}?${names.map((name) => `${encodeURIComponent(name)}=${REDACTED}`).join('&')}`;
};

/** Polled by the container health check and the Manager; a successful poll is never worth a line. */
const POLL_ROUTES = /^\/api\/server\/(?:ping|version)\/?$/i;
/** One request per timeline tile; successes go to `debug` so browsing a large library stays readable. */
const TILE_ROUTES = /^\/api\/(?:assets\/[^/]+\/(?:thumbnail|video\/playback)|people\/[^/]+\/thumbnail)\/?$/i;

/**
 * One line per API request once its response is sent or the client goes away: method, redacted
 * path, status, duration and the signed-in user's ID. Express middleware rather than an interceptor,
 * so requests a guard refuses (401, 403, 429) and unknown routes (404) are logged too. Tokens,
 * cookies, keys and bodies are never written.
 */
export const requestLogMiddleware =
  (logger: LoggingRepository, { enabled }: { enabled: boolean }) =>
  (req: Request, res: Response, next: NextFunction) => {
    const url = req.originalUrl;
    if (!/^\/api(?:[/?#]|$)/i.test(url)) {
      return next();
    }
    const start = performance.now();
    res.once('close', () => {
      const path = url.split(/[?#]/, 1)[0];
      const status = res.writableFinished ? res.statusCode : 'aborted';
      const ok = res.writableFinished && res.statusCode < 400;
      const userId = (req as AuthRequest).user?.user?.id;
      const line = `${req.method} ${requestLogPath(url)} ${status} ${(performance.now() - start).toFixed(0)}ms${userId ? ` user=${userId}` : ''}`;
      if (res.writableFinished && res.statusCode >= 500) {
        logger.warn(line);
      } else if (!enabled || (ok && (POLL_ROUTES.test(path) || TILE_ROUTES.test(path)))) {
        logger.debug(line);
      } else {
        logger.log(line);
      }
    });
    next();
  };

export const replacer = (key: string, value: unknown) => {
  if (key && isSecretName(key)) {
    return REDACTED;
  }

  if (key && normalize(key) === 'url' && typeof value === 'string') {
    return redactUrlQuery(value);
  }

  if (Array.isArray(value) && value.length > maxArrayLength) {
    return [...value.slice(0, maxArrayLength), `...and ${value.length - maxArrayLength} more`];
  }

  return value;
};

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(LoggingInterceptor.name);
  }

  /** Adds the redacted request body at `verbose` level once the handler finishes. */
  intercept(context: ExecutionContext, next: CallHandler<any>): Observable<any> {
    const handler = context.switchToHttp();
    const req = handler.getRequest<Request>();

    // The request line itself is written by `requestLogMiddleware`; this adds the redacted body.
    return next.handle().pipe(
      finalize(() => {
        if (
          !BODYLESS_ROUTES.test(req.route?.path ?? req.path) &&
          !DIRECT_UPLOAD_ROUTE.test(req.path) &&
          req.body &&
          Object.keys(req.body).length > 0
        ) {
          this.logger.verbose(JSON.stringify(req.body, replacer));
        }
      }),
    );
  }
}
