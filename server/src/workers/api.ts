import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureExpress } from 'src/app.common.js';
import { ApiModule } from 'src/app.module.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { ApiService } from 'src/services/api.service.js';
import { isStartUpError } from 'src/utils/misc.js';
import { HttpRequestTracker, closeGracefully, onStopRequest } from 'src/utils/shutdown.js';

async function bootstrap() {
  process.title = 'frameleaf-api';

  // FL-291: SIGTERM stops taking connections and drains the requests in flight before exiting
  // eslint-disable-next-line unicorn/no-process-exit
  let stop = (): void => process.exit(0);
  onStopRequest(() => stop());

  const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
    bufferLogs: true,
    routeConflictPolicy: { duplicate: 'error' },
    routeResolutionStrategy: 'specificity',
  });
  const http = new HttpRequestTracker(app.getHttpServer());
  const appRepository = app.get(AppRepository);
  appRepository.setCloseFn((graceMs) => closeGracefully({ http, close: () => app.close(), graceMs }));
  stop = () => appRepository.stop(0);

  await configureExpress(app, {
    ssr: ApiService,
  });
}

bootstrap().catch((error) => {
  if (!isStartUpError(error)) {
    console.error(error);
  }
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
});
