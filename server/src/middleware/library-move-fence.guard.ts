import {
  CallHandler,
  CanActivate,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Observable, defer, tap } from 'rxjs';
import type { Request, Response } from 'express';
import { LIBRARY_MOVE_RETRY_AFTER_SECONDS, libraryMoveFence } from 'src/utils/frameleaf-library-move-fence.js';

type RequestWrite = { closed: boolean; running: boolean; release: () => void };
// Global guard and interceptor instances share the same request reservation.
const writes = new WeakMap<Request, RequestWrite>();

/**
 * FL-360: refuses library writes while a Frameleaf Manager library move has paused the server, and
 * counts each write until both its response closes and its handler settles. Guards run before the upload
 * interceptors, so a refused upload's body is never read.
 */
@Injectable()
export class LibraryMoveFenceGuard implements CanActivate, NestInterceptor {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const release = libraryMoveFence.admit(request.method, request.originalUrl?.split('?', 1)[0] ?? request.path);
    if (release === false) {
      response.setHeader('Retry-After', String(LIBRARY_MOVE_RETRY_AFTER_SECONDS));
      throw new ServiceUnavailableException({
        message: 'Frameleaf is moving the library. Uploads and changes are paused until the move finishes.',
        error: 'library_move_in_progress',
      });
    }
    const write = { closed: false, running: false, release };
    writes.set(request, write);
    response.once('close', () => {
      write.closed = true;
      if (!write.running) release();
    });
    return true;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const write = writes.get(context.switchToHttp().getRequest<Request>());
    if (!write) return next.handle();
    const finished = () => {
      write.running = false;
      if (write.closed) write.release();
    };
    return defer(() => {
      if (write.closed) throw new ServiceUnavailableException('The request closed before processing');
      write.running = true;
      return next.handle();
    }).pipe(
      // Unsubscription alone cannot prove an asynchronous controller has stopped writing.
      tap({ complete: finished, error: finished }),
    );
  }
}
