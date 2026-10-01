import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureExpress } from 'src/app.common.js';
import { FirstLaunchModule } from 'src/app.module.js';
import { FirstLaunchWorkerService } from 'src/maintenance/first-launch-worker.service.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { isStartUpError } from 'src/utils/misc.js';
import { HttpRequestTracker, closeGracefully, onStopRequest } from 'src/utils/shutdown.js';

/**
 * FL-295: the "Getting Ready…" worker. The supervisor runs it alone on the first start on a library the
 * official server created: it serves the "Getting Ready…" screen while it takes the safety copy.
 */
async function bootstrap() {
  process.title = 'frameleaf-first-launch';

  // FL-291: the supervisor's stop message drains the requests in flight before the thread exits
  // eslint-disable-next-line unicorn/no-process-exit
  let stop = (): void => process.exit(0);
  onStopRequest(() => stop());

  const app = await NestFactory.create<NestExpressApplication>(FirstLaunchModule, {
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
    ssr: FirstLaunchWorkerService,
  });
}

bootstrap().catch((error) => {
  if (!isStartUpError(error)) {
    console.error(error);
  }
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
});
