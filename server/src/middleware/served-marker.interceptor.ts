import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AuthRequest } from 'src/middleware/auth.guard.js';
import { serverVersion } from 'src/constants.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';

/** The Manager's own machine-token routes (status, begin, finish): its polls, not anyone's data. */
const MANAGER_ROUTES = '/api/server/library-setup/manager';

/**
 * FL-1210: on this process's first real API request, records the release and time in `frameleaf-served`.
 * Frameleaf Manager reads it before rolling a failed update back: a release that served may hold uploads
 * the pre-update checkpoint lacks. What counts (FL-1232): a signed-in user's request, and any public write
 * (a guest's gallery choices, a studio inquiry), since both can leave data behind. Public reads such as an
 * open tab's config fetch, the health ping and the Manager's own machine-token routes do not. A header is no
 * proof of who is asking, so `request.user` decides who is signed in; interceptors run after the auth guard,
 * so it is set by then. The write runs beside the request, never fails it, and happens once per process.
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
      const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET');
      if (path !== '/api/server/ping' && !path.startsWith(MANAGER_ROUTES) && (request.user || write)) {
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
