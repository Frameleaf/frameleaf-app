import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LIBRARY_MOVE_RETRY_AFTER_SECONDS, libraryMoveFence } from 'src/utils/frameleaf-library-move-fence.js';

/**
 * FL-360: refuses library writes while a Frameleaf Manager library move has paused the server, and
 * counts the write requests in flight so the move can wait for them. Guards run before the upload
 * interceptors, so a refused upload's body is never read.
 */
@Injectable()
export class LibraryMoveFenceGuard implements CanActivate {
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
    response.once('close', release);
    return true;
  }
}
