import type { INestApplication } from '@nestjs/common';
import type { RequestHandler } from 'express';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { MediaImportRepository } from 'src/repositories/media-import.repository.js';
import { MetricsRepository, setWorkerMetrics } from 'src/repositories/metrics.repository.js';
import { getDiskUsage } from 'src/utils/disk-usage.js';
import { getDatabasePoolUsage } from 'src/utils/execution-database.js';
import { inContainer } from 'src/utils/frameleaf-remote-access.js';

export const prepareWorkerMetrics = (
  app: INestApplication,
  worker: 'api' | 'microservices',
): { middleware: RequestHandler; listen: () => Promise<URL>; close: () => Promise<void> } | undefined => {
  const config = app.get(ConfigRepository).getEnv().metrics;
  if (!config?.enabled) return;

  const db = app.get(DatabaseRepository);
  const metrics = new MetricsRepository({
    database: getDatabasePoolUsage,
    ...(worker === 'api'
      ? {
          disk: () => getDiskUsage(StorageCore.getBaseFolder(StorageFolder.Library)),
          assets: () => db.getMetricsAssetCounts(),
        }
      : { queues: () => db.getMetricsQueueCounts(), media: () => app.get(MediaImportRepository).metrics() }),
  });
  setWorkerMetrics(metrics);
  return {
    middleware: metrics.middleware(),
    listen: () =>
      metrics.listen(
        config.port + Number(worker === 'microservices'),
        inContainer() ? '0.0.0.0' : '127.0.0.1',
        config.token,
      ),
    close: async () => {
      setWorkerMetrics(undefined);
      await metrics.close();
    },
  };
};
