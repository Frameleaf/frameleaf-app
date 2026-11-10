import { NestFactory } from '@nestjs/core';
import { isMainThread } from 'node:worker_threads';
import { MicroservicesModule } from 'src/app.module.js';
import { serverVersion } from 'src/constants.js';
import { WebSocketAdapter } from 'src/middleware/websocket.adapter.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DatabaseService } from 'src/services/database.service.js';
import { lockedKeys } from 'src/utils/locked-key-holder.js';
import { attachLockedKeyIpc } from 'src/utils/locked-key-ipc.js';
import { isStartUpError } from 'src/utils/misc.js';
import { startPrivateLogs, stopPrivateLogs } from 'src/utils/private-log-runtime.js';
import { closeGracefully, onStopRequest } from 'src/utils/shutdown.js';
import { prepareWorkerMetrics } from 'src/utils/worker-metrics.js';

/** Starts the microservices worker (job queues, no HTTP) and logs its ready line. */
export async function bootstrap() {
  // FL-291: the supervisor's stop message lets running jobs finish or hands them back before the
  // thread exits

  let stop = (): void => process.exit(0);
  onStopRequest(() => stop());

  const app = await NestFactory.create(MicroservicesModule, { bufferLogs: true });
  const logger = await app.resolve(LoggingRepository);
  const configRepository = app.get(ConfigRepository);
  const jobRepository = app.get(JobRepository);
  const metrics = prepareWorkerMetrics(app, 'microservices');
  const appRepository = app.get(AppRepository);
  appRepository.setCloseFn((graceMs) =>
    closeGracefully({
      stopJobs: (grace) => jobRepository.stopWorkers(grace),
      close: async () => {
        await metrics?.close();
        await app.close();
        await stopPrivateLogs();
      },
      graceMs,
      debug: (message) => logger.debug(message),
    }),
  );
  stop = () => appRepository.stop(0);

  const { environment, host, logRetentionDays, storage } = configRepository.getEnv();

  logger.setContext('Bootstrap');
  app.useLogger(logger);
  try {
    // Gateway attachment precedes AppBootstrap during listen(), so migrate and check import activation first.
    await app.get(DatabaseService).initialize();
    startPrivateLogs('microservices', logRetentionDays, storage.mediaLocation);
    app.useWebSocketAdapter(new WebSocketAdapter(app));

    await (host ? app.listen(0, host) : app.listen(0));
  } catch (error) {
    // FL-386: a stop or restart (e.g. entering maintenance) closes the app, database included, while
    // startup work such as the landmark re-import may still be running; that work then fails. The
    // worker is already exiting through the stop, so end startup quietly instead of crashing.
    if (appRepository.isStopping) {
      logger.log(`Stopped during startup: ${error}`);
      return;
    }
    throw error;
  }

  await metrics?.listen().catch((error: NodeJS.ErrnoException) => {
    logger.error(`Unable to start the local job metrics listener: ${error.code ?? error.name}`);
  });
  logger.log(`Frameleaf Microservices is running [v${serverVersion}] [${environment}] - ready`);
}

if (!isMainThread) {
  // FL-721: jobs run in this thread; the supervisor hands it the Locked keys the API loads
  attachLockedKeyIpc(lockedKeys);
  bootstrap().catch((error) => {
    if (!isStartUpError(error)) {
      console.error(error);
    }
    throw error;
  });
}
