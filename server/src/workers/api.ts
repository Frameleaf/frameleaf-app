import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureExpress } from 'src/app.common.js';
import { ApiModule } from 'src/app.module.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { ApiService } from 'src/services/api.service.js';
import { isRetryableStartupError, isStartUpError } from 'src/utils/misc.js';
import { stopPrivateLogs } from 'src/utils/private-log-runtime.js';
import { API_STARTUP_RETRY_EXIT_CODE, HttpRequestTracker, closeGracefully, onStopRequest } from 'src/utils/shutdown.js';
import { prepareWorkerMetrics } from 'src/utils/worker-metrics.js';

async function bootstrap() {
  process.title = 'frameleaf-api';

  // FL-291: SIGTERM stops taking connections and drains the requests in flight before exiting
  // eslint-disable-next-line unicorn/no-process-exit
  let stop = (): void => process.exit(0);
  onStopRequest(() => stop(), { ipc: process.env.FRAMELEAF_NATIVE_OWNER === '1' });

  const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
    bufferLogs: true,
    routeConflictPolicy: { duplicate: 'error' },
    routeResolutionStrategy: 'specificity',
  });
  const metrics = prepareWorkerMetrics(app, 'api');
  if (metrics) app.use(metrics.middleware);
  const http = new HttpRequestTracker(app.getHttpServer());
  const appRepository = app.get(AppRepository);
  appRepository.setCloseFn((graceMs) =>
    closeGracefully({
      http,
      close: async () => {
        await metrics?.close();
        await app.close();
        await stopPrivateLogs();
      },
      graceMs,
    }),
  );
  stop = () => appRepository.stop(0);

  await configureExpress(app, {
    ssr: ApiService,
  });
  await metrics?.listen().catch((error: NodeJS.ErrnoException) => {
    console.error(`Unable to start the local API metrics listener: ${error.code ?? error.name}`);
  });
}

bootstrap().catch((error) => {
  if (!isStartUpError(error)) {
    console.error(error);
  }
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(isRetryableStartupError(error) ? API_STARTUP_RETRY_EXIT_CODE : 1);
});
