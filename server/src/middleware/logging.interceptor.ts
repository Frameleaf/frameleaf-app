import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, finalize } from 'rxjs';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

const maxArrayLength = 100;
const REDACTED = '********';

/**
 * FL-81: request logs never carry a credential. Names are compared case-insensitively with `_` and
 * `-` removed, so `access_token`, `api_key`, `private-key` and `sessionKey` all match.
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
const normalize = (name: string) => name.toLowerCase().replaceAll(/[_-]/g, '');
const SECRET_PART = /password|pincode|token|secret|apikey|privatekey|sessionkey|codeverifier|licen[cs]ekey|linkcode/;
const SECRET_EXACT = new Set(['key', 'code', 'state', 'slug', 'appleid']);
const isSecretName = (name: string) => {
  const normalized = normalize(name);
  return SECRET_PART.test(normalized) || SECRET_EXACT.has(normalized);
};

const redactUrlQuery = (url: string) => {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : `${url.slice(0, cut)}?${REDACTED}`;
};

/** CLD-004: routes whose query string is never recorded, whatever its parameters are called. */
const QUERYLESS_ROUTES = /^\/(?:link|api\/(?:admin\/license|license|users\/me\/license))(?:[/?#]|$)/;

export const redactLogUrl = (url: string) => {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }
  if (QUERYLESS_ROUTES.test(url)) {
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

  intercept(context: ExecutionContext, next: CallHandler<any>): Observable<any> {
    const handler = context.switchToHttp();
    const req = handler.getRequest<Request>();
    const res = handler.getResponse<Response>();

    const { method, ip, url } = req;

    const start = performance.now();

    return next.handle().pipe(
      finalize(() => {
        const finish = performance.now();
        const duration = (finish - start).toFixed(2);
        const { statusCode } = res;

        this.logger.debug(`${method} ${redactLogUrl(url)} ${statusCode} ${duration}ms ${ip}`);
        if (req.body && Object.keys(req.body).length > 0) {
          this.logger.verbose(JSON.stringify(req.body, replacer));
        }
      }),
    );
  }
}
