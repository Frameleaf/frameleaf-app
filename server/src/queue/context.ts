import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transaction } from 'kysely';
import { basename, dirname, join } from 'node:path';
import type { QueueExecution } from 'src/queue/types.js';

export const queueExecution = new AsyncLocalStorage<QueueExecution>();
export const jobSignal = () => queueExecution.getStore()?.signal;
export const reportJobProgress = (completedUnits: number) => queueExecution.getStore()?.progress(completedUnits);
/** Attempt-private outputs are never a canonical media path until a fenced adoption commits. */
export const jobStagingPath = (root: string, filename: string) => {
  const context = queueExecution.getStore();
  if (!context) {
    throw new Error('Staging requires a queue claim');
  }
  if (filename.includes('/') || filename.includes('\\') || filename === '..') {
    throw new Error('Invalid staging filename');
  }
  context.signal.throwIfAborted();
  return join(root, context.claim.id, context.claim.token, filename);
};

/** Register a database-only adoption to commit with the successful claim and its child intents. */
export const deferJobAdoption = (adopt: (tx: Transaction<any>) => Promise<void>) => {
  const context = queueExecution.getStore();
  if (!context) {
    return false;
  }
  context.signal.throwIfAborted();
  context.adoptions.push(adopt);
  return true;
};

/** The path itself is immutable after publication; DB adoption makes it the current file. */
export const attemptOutputPath = (path: string) => {
  const context = queueExecution.getStore();
  return context ? jobStagingPath(join(dirname(path), '.attempts'), basename(path)) : path;
};

export const advanceJobProgress = (units: number) => {
  const context = queueExecution.getStore();
  if (context && Number.isSafeInteger(units) && units > 0) {
    context.progressUnits += units;
    context.progress(context.progressUnits);
  }
};
