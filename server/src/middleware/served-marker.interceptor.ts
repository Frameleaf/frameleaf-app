import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AuthRequest } from 'src/middleware/auth.guard.js';
import { serverVersion } from 'src/constants.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';

/**
 * FL-1210: on this process's first real API request, records the release and time in `frameleaf-served`.
 * Frameleaf Manager reads it before rolling a failed update back: a release that served may hold uploads
 * the pre-update checkpoint lacks. Only a signed-in user's request counts (FL-1232): the health ping, the
 * Manager's own status polls (public routes checked by its machine token, so no user) and public calls
 * such as an open tab's config fetch hold no one's uploads. A header is no proof of who is asking, so only
 * `request.user` decides; interceptors run after the auth guard, so it is set by then. The write
 * runs beside the request, never fails it, and happens once per process.
 */
@Injectable()
export class ServedMarkerInterceptor implements NestInterceptor {
  private written = false;

  constructor(
    private metadata: SystemMetadataRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(ServedMarkerInterceptor.name);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.written && context.getType() === 'http') {
      const request = context.switchToHttp().getRequest<AuthRequest>();
      const path = request.originalUrl?.split('?', 1)[0] ?? request.path;
      if (path !== '/api/server/ping' && request.user) {
        this.written = true;
        void this.metadata
          .setServed({
            version: serverVersion.toString(),
            servedAt: new Date().toISOString(),
          })
          .catch((error: unknown) => {
            this.written = false; // The next request tries again.
            this.logger.error(`Could not record that this release served a request: ${error}`);
          });
      }
    }
    return next.handle();
  }
}
