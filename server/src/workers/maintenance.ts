import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureExpress } from 'src/app.common.js';
import { MaintenanceModule } from 'src/app.module.js';
import { MaintenanceWorkerService } from 'src/maintenance/maintenance-worker.service.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { isStartUpError } from 'src/utils/misc.js';
import { HttpRequestTracker, closeGracefully, onStopRequest } from 'src/utils/shutdown.js';

async function bootstrap() {
  process.title = 'frameleaf-maintenance';

  // FL-291: the supervisor's stop message drains the requests in flight before the thread exits
  // eslint-disable-next-line unicorn/no-process-exit
  let stop = (): void => process.exit(0);
  onStopRequest(() => stop());

  const app = await NestFactory.create<NestExpressApplication>(MaintenanceModule, {
    bufferLogs: true,
    routeConflictPolicy: { duplicate: 'error' },
    routeResolutionStrategy: 'specificity',
  });
  const http = new HttpRequestTracker(app.getHttpServer());
  const appRepository = app.get(AppRepository);
  appRepository.setCloseFn((graceMs) => closeGracefully({ http, close: () => app.close(), graceMs }));
  stop = () => appRepository.stop(0);

  void configureExpress(app, {
    permitSwaggerWrite: false,
    ssr: MaintenanceWorkerService,
  });
}

bootstrap().catch((error) => {
  if (!isStartUpError(error)) {
    console.error(error);
  }
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
});
