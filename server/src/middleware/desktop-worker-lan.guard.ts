import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { requestVia } from 'src/middleware/frameleaf-via.middleware.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { isLanRequest } from 'src/utils/frameleaf-setup.js';

@Injectable()
export class DesktopWorkerLanGuard implements CanActivate {
  constructor(private config: ConfigRepository) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!isLanRequest(requestVia(request), request.ip, this.config.getEnv().frameleafCloud.trustedLanCidrs))
      throw new ForbiddenException('desktop_worker_lan_required');
    return true;
  }
}
