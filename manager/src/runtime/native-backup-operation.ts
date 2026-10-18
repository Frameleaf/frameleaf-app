import { isDeepStrictEqual } from 'node:util';
import { digest, Refusal, type Operation } from '../contracts.js';
import { Store } from '../store.js';
import type { NativeRuntime } from './native.js';
import { completeNativeDatabaseBackup } from './native-backup-journal.js';

type Context = Parameters<typeof completeNativeDatabaseBackup>[3];
type Engine = Parameters<typeof completeNativeDatabaseBackup>[2];

/** The existing operation runner releases its Store lock only after this owner lifecycle completes. */
export async function runNativeDatabaseBackup(
  store: Store,
  runtime: NativeRuntime,
  engine: Engine,
  context: Context,
  operation: Operation,
) {
  if (
    operation.kind !== 'backup' ||
    operation.state !== 'running' ||
    !Array.isArray(operation.completed) ||
    !operation.receipts ||
    !isDeepStrictEqual(operation.input, runtime.identity) ||
    runtime.identity.runtime !== 'native' ||
    runtime.identity.installationId !== context.installation.id ||
    runtime.identity.fingerprint !== digest(context.installation) ||
    !isDeepStrictEqual(
      store.history().find((value) => value.id === operation.id),
      operation,
    )
  )
    throw new Refusal('native_backup_journal_invalid');
  const intentKey = 'native-backup-database-intent';
  const intent = operation.receipts[intentKey];
  if (intent !== undefined && !isDeepStrictEqual(intent, runtime.identity))
    throw new Refusal('native_backup_journal_invalid');
  const needsOwner = !operation.completed.includes(
    'native-backup-owner-cleaned',
  );
  const status =
    needsOwner || intent !== undefined
      ? runtime.status()
      : { state: 'stopped' as const, code: undefined };
  if (status.state === 'starting' || status.state === 'stopping')
    throw new Refusal('native_runtime_busy');
  const faulted =
    status.state === 'unknown' &&
    !['native_owner_not_attached', 'native_database_maintenance'].includes(
      status.code ?? '',
    );
  if (faulted && intent === undefined)
    throw new Refusal('native_backup_owner_unavailable');
  if (intent !== undefined && status.state === 'running')
    throw new Refusal('native_backup_owner_changed');
  const temporary =
    intent !== undefined || (needsOwner && status.state !== 'running');
  if (temporary && intent === undefined) {
    operation.receipts[intentKey] = { ...runtime.identity };
    store.save(operation);
  }
  let drained = false;
  if (faulted) {
    await stopTemporary();
    drained = true;
  }
  try {
    if (needsOwner && temporary) {
      drained = false;
      const key = 'native-backup-start-database';
      operation.step = key;
      store.save(operation);
      const ready = await runtime.startDatabase();
      if (
        !isDeepStrictEqual(ready, {
          protocolVersion: 1,
          state: 'database-ready',
          manifestSha256: context.installation.manifestSha256,
          sourceRevision: context.installation.sourceRevision,
          certified: context.installation.certified,
        })
      )
        throw new Refusal('native_host_identity_changed');
      operation.receipts[key] = ready;
      if (!operation.completed.includes(key)) operation.completed.push(key);
      store.save(operation);
    }
    return await completeNativeDatabaseBackup(
      store,
      runtime,
      engine,
      context,
      operation,
    );
  } finally {
    if (temporary && !drained) await stopTemporary();
  }
  async function stopTemporary() {
    const key = 'native-backup-stop-database';
    operation.step = key;
    let journalError;
    try {
      store.save(operation);
    } catch (error) {
      journalError = error;
    }
    // The durable database intent already authorizes draining our temporary owner even if storage fails.
    const stopped = await runtime.stop();
    if (stopped?.protocolVersion !== 1 || stopped.state !== 'stopped')
      throw new Refusal('native_shutdown_unconfirmed');
    if (journalError) throw journalError;
    operation.receipts[key] = stopped;
    if (!operation.completed.includes(key)) operation.completed.push(key);
    store.save(operation);
  }
}
