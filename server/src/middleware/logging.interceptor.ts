import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, finalize } from 'rxjs';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

const maxArrayLength = 100;
const REDACTED = '********';

/**
 * FL-81: request logs never carry a credential. Body fields whose name says they hold a secret
 * (passwords, PIN codes, maintenance and OAuth tokens, API keys, client secrets) are masked, and so
 * are the query values that grant access (`token` of the maintenance sign-in link, `key` / `slug` of a
 * shared link, `apiKey`, OAuth `code` and `state`).
 */
const SECRET_FIELD = /password|pincode|token|secret|apikey|^key$|^code$/i;
const SECRET_QUERY = new Set(['token', 'key', 'slug', 'apikey', 'code', 'state', 'password']);

export const redactLogUrl = (url: string) => {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }
  const params = new URLSearchParams(url.slice(queryStart + 1));
  let changed = false;
  for (const name of params.keys()) {
    if (!SECRET_QUERY.has(name.toLowerCase())) {
      continue;
    }
    params.set(name, REDACTED);
    changed = true;
  }
  return changed ? `${url.slice(0, queryStart)}?${params.toString()}` : url;
};

export const replacer = (key: string, value: unknown) => {
  if (key && SECRET_FIELD.test(key)) {
    return REDACTED;
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
