import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestHandler } from 'express';
import type { PrivateLogInput, PrivateLogLevel, PrivateLogWorker } from 'src/utils/private-log-store.js';
import { queueExecution } from 'src/queue/context.js';
import { discoverMediaLocation } from 'src/utils/media-location.js';
import { PrivateLogStore, privateLogLevels } from 'src/utils/private-log-store.js';

const requestLogs = new AsyncLocalStorage<{ requestId: string; route: () => string | undefined }>();
const limit = 512;
let current:
  { worker: PrivateLogWorker; store: PrivateLogStore; rows: PrivateLogInput[]; timer: NodeJS.Timeout } | undefined;
let flushing: Promise<void> | undefined;

export const privateLogStore = (days: number, mediaLocation?: string) =>
  new PrivateLogStore(join(discoverMediaLocation(mediaLocation, existsSync), 'logs'), days);

export const startPrivateLogs = (worker: PrivateLogWorker, days: number, mediaLocation?: string) => {
  const store = privateLogStore(days, mediaLocation);
  const timer = setInterval(() => void flushPrivateLogs(), 500).unref();
  current = { worker, store, rows: [], timer };
  void store.prune(worker).catch(() => {});
};

const flushPrivateLogs = async () => {
  if (flushing || !current?.rows.length) return flushing;
  const { store, worker, rows } = current;
  flushing = store
    .append(worker, rows.splice(0, limit))
    .catch(() => {})
    .finally(() => {
      flushing = undefined;
    });
  return flushing;
};

export const stopPrivateLogs = async () => {
  if (!current) return;
  clearInterval(current.timer);
  await flushing;
  await flushPrivateLogs();
  current = undefined;
};

export const privateLogContext: RequestHandler = (request, _response, next) => {
  requestLogs.run(
    {
      requestId: randomUUID(),
      route: () => {
        const route: unknown = request.route?.path;
        return typeof route === 'string' ? route : undefined;
      },
    },
    next,
  );
};

export const privateRequestId = () => requestLogs.getStore()?.requestId;

export const currentLogContext = () => {
  const request = requestLogs.getStore();
  const claim = queueExecution.getStore()?.claim;
  return {
    requestId: request?.requestId,
    route: request?.route(),
    jobName: claim?.name,
    jobId: claim?.id,
    assetId: typeof claim?.data.id === 'string' ? claim.data.id : undefined,
  };
};

export const persistLogMessage = (level: string, context: string, message: unknown) => {
  if (!current || current.rows.length >= limit || !privateLogLevels.includes(level as PrivateLogLevel)) return;
  const text = typeof message === 'string' ? message : message instanceof Error ? message.name : undefined;
  if (text === undefined) return;
  current.rows.push({
    level: level as PrivateLogLevel,
    context,
    message: text,
    ...currentLogContext(),
    at: new Date().toISOString(),
  });
};
