import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, dirname, join } from 'node:path';
import type { Transaction } from 'kysely';
import type { QueueExecution } from 'src/queue/types.js';
import type { DB } from 'src/schema/index.js';
import { publicationTransaction } from 'src/queue/transaction.js';

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
export const deferJobAdoption = (adopt: (tx: Transaction<DB>) => Promise<void>) => {
  const context = queueExecution.getStore();
  if (!context || publicationTransaction.getStore()) {
    return false;
  }
  context.signal.throwIfAborted();
  // Queue SQL owns its untyped bookkeeping tables; publication uses the application's DB schema.
  context.adoptions.push((tx) => adopt(tx as unknown as Transaction<DB>));
  return true;
};

/** A prepared operation may settle only with the stopped queue claim's failed transaction. */
export const deferJobFailure = (settle: (tx: Transaction<DB>, reason: string, cancelled: boolean) => Promise<void>) => {
  const context = queueExecution.getStore();
  if (!context || publicationTransaction.getStore()) return false;
  context.signal.throwIfAborted();
  (context.failureSettlements ??= []).push((tx, reason, cancelled) =>
    settle(tx as unknown as Transaction<DB>, reason, cancelled),
  );
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

/** Observers run only after acceptance; reconnecting clients read durable state if delivery is lost. */
export const afterJobCommit = async (notify: () => Promise<void>) => {
  const context = queueExecution.getStore();
  if (context) {
    (context.afterCommit ??= []).push(notify);
  } else {
    await notify();
  }
};

/** Run a publication now for non-queue callers, or defer it into the accepted claim transaction. */
export async function publishJobResult(publish: () => Promise<void>) {
  if (!deferJobAdoption(async () => publish())) {
    await publish();
  }
}

/** Diagnostic metadata only: accepted with either the success or failed claim, never child intents. */
export async function publishJobDiagnostic(publish: () => Promise<void>) {
  const context = queueExecution.getStore();
  if (!context || publicationTransaction.getStore()) {
    await publish();
    return;
  }
  context.signal.throwIfAborted();
  (context.failureDiagnostics ??= []).push(async () => publish());
  context.adoptions.push(async () => publish());
}
