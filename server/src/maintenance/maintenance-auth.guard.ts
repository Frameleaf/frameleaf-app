import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { MaintenanceAuthDto } from 'src/dtos/maintenance.dto.js';
import { MetadataKey } from 'src/enum.js';
import { MaintenanceWorkerService } from 'src/maintenance/maintenance-worker.service.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

export const MaintenanceRoute = (options = {}): MethodDecorator => SetMetadata(MetadataKey.AuthRoute, options);

export interface MaintenanceAuthRequest extends Request {
  auth?: MaintenanceAuthDto;
}

@Injectable()
export class MaintenanceAuthGuard implements CanActivate {
  constructor(
    private logger: LoggingRepository,
    private reflector: Reflector,
    private service: MaintenanceWorkerService,
  ) {
    this.logger.setContext(MaintenanceAuthGuard.name);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<{ _emptyObject: never } | undefined>(
      MetadataKey.AuthRoute,
      context.getHandler(),
    );
    if (!options) {
      return true;
    }

    const request = context.switchToHttp().getRequest<MaintenanceAuthRequest>();
    request.auth = await this.service.authenticate(request.headers);

    return true;
  }
}
