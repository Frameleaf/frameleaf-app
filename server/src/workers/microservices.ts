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
import { isStartUpError } from 'src/utils/misc.js';
import { closeGracefully, onStopRequest } from 'src/utils/shutdown.js';

export async function bootstrap() {
  // FL-291: the supervisor's stop message lets running jobs finish or hands them back before the
  // thread exits

  let stop = (): void => process.exit(0);
  onStopRequest(() => stop());

  const app = await NestFactory.create(MicroservicesModule, { bufferLogs: true });
  const logger = await app.resolve(LoggingRepository);
  const configRepository = app.get(ConfigRepository);
  const jobRepository = app.get(JobRepository);
  const appRepository = app.get(AppRepository);
  appRepository.setCloseFn((graceMs) =>
    closeGracefully({
      stopJobs: (grace) => jobRepository.stopWorkers(grace),
      close: () => app.close(),
      graceMs,
      debug: (message) => logger.debug(message),
    }),
  );
  stop = () => appRepository.stop(0);

  const { environment, host } = configRepository.getEnv();

  logger.setContext('Bootstrap');
  app.useLogger(logger);
  // Gateway attachment precedes AppBootstrap during listen(), so migrate and check import activation first.
  await app.get(DatabaseService).initialize();
  app.useWebSocketAdapter(new WebSocketAdapter(app));

  await (host ? app.listen(0, host) : app.listen(0));

  logger.log(`Frameleaf Microservices is running [v${serverVersion}] [${environment}] `);
}

if (!isMainThread) {
  bootstrap().catch((error) => {
    if (!isStartUpError(error)) {
      console.error(error);
    }
    throw error;
  });
}
