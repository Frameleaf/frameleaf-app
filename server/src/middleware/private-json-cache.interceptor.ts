import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Response } from 'express';
import type { AuthRequest } from 'src/middleware/auth.guard.js';

/**
 * Signed-in JSON may be stored by the client but must be revalidated (the ETag answers with 304). A route
 * or file response that set its own Cache-Control keeps it; interceptors run after the auth guard.
 */
@Injectable()
export class PrivateJsonCacheInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    return next.handle().pipe(
      tap((body) => {
        if (
          context.getType() !== 'http' ||
          typeof body !== 'object' ||
          body === null ||
          body instanceof StreamableFile
        ) {
          return;
        }
        const response = http.getResponse<Response>();
        if (http.getRequest<AuthRequest>().user && !response.headersSent && !response.hasHeader('Cache-Control')) {
          response.setHeader('Cache-Control', 'private, no-cache');
        }
      }),
    );
  }
}
