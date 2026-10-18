import { isDeepStrictEqual } from 'node:util';
import { digest, Refusal, type Operation } from '../contracts.js';
import { Store } from '../store.js';
import type { NativeRuntime } from './native.js';
import { stageNativeRestoreInput } from './native-restore-input.js';
import { NativeRestoreContextSchema } from './native-restore-review.js';
import {
  NativeRestorePreparedSchema,
  type NativeRestorePrepared,
} from './native-restore-contract.js';

type Context = Parameters<typeof stageNativeRestoreInput>[1];

/** Preparation retains the operation lock; only the later activation protocol can complete restore. */
export async function runNativeRestorePreparation(
  store: Store,
  runtime: NativeRuntime,
  input: Context,
  operation: Operation,
  signal?: AbortSignal,
): Promise<NativeRestorePrepared> {
  const context = NativeRestoreContextSchema.parse(input);
  const identity = {
    runtime: 'native',
    installationId: context.installation.id,
    fingerprint: digest(context.installation),
  };
  const invalid = () => new Refusal('native_restore_journal_invalid');
  function stillOwned() {
    if (
      !isDeepStrictEqual(runtime.identity, identity) ||
      store.get('native-library-id') !== context.libraryId ||
      !isDeepStrictEqual(
        store.history().find((value) => value.id === operation.id),
        operation,
      )
    )
      throw invalid();
  }
  function cancelled() {
    if (signal?.aborted) throw new Refusal('native_restore_cancelled');
  }
  stillOwned();
  if (
    operation.kind !== 'restore' ||
    operation.state !== 'running' ||
    !Array.isArray(operation.completed) ||
    !operation.receipts ||
    !isDeepStrictEqual(operation.input, {
      reviewId: operation.input?.reviewId,
      ...identity,
    })
  )
    throw invalid();
  cancelled();
  const intentKey = 'native-restore-owner-intent',
    preparedKey = 'native-restore-prepared',
    stopKey = 'native-restore-stop-owner';
  const intent = operation.receipts[intentKey];
  if (intent !== undefined && !isDeepStrictEqual(intent, identity))
    throw invalid();
  if (operation.receipts[preparedKey] !== undefined && intent === undefined)
    throw invalid();
  const status = runtime.status();
  if (
    status.state === 'running' ||
    status.state === 'starting' ||
    status.state === 'stopping' ||
    (intent === undefined &&
      status.state !== 'stopped' &&
      !(
        status.state === 'unknown' &&
        status.code === 'native_owner_not_attached'
      ))
  ) {
    throw new Refusal('native_restore_owner_unavailable');
  }
  let ownsHost = intent !== undefined;
  let result: NativeRestorePrepared;
  try {
    // A previous attempt may still own processes even when its readiness acknowledgement was lost.
    if (ownsHost) {
      ownsHost = false;
      await drain();
    }
    cancelled();
    const staged = await stageNativeRestoreInput(store, context, operation);
    stillOwned();
    cancelled();
    const prior = operation.receipts[preparedKey];
    if (operation.completed.includes(preparedKey) !== (prior !== undefined))
      throw invalid();
    if (prior !== undefined) {
      result = NativeRestorePreparedSchema.parse(prior);
      if (!isDeepStrictEqual(result.binding, staged.binding)) throw invalid();
    } else {
      operation.receipts[intentKey] = { ...identity };
      delete operation.receipts[stopKey];
      operation.completed = operation.completed.filter(
        (value) => value !== stopKey,
      );
      operation.step = 'native-restore-start-owner';
      store.save(operation);
      ownsHost = true;
      const ready = await runtime.startRestorePreparation();
      stillOwned();
      cancelled();
      if (
        !isDeepStrictEqual(ready, {
          protocolVersion: 1,
          state: 'restore-prepare-ready',
          manifestSha256: context.installation.manifestSha256,
          sourceRevision: context.installation.sourceRevision,
          certified: context.installation.certified,
        })
      )
        throw new Refusal('native_host_identity_changed');
      operation.step = preparedKey;
      store.save(operation);
      const prepared = NativeRestorePreparedSchema.parse(
        await runtime.prepareRestore(staged.binding, signal),
      );
      stillOwned();
      cancelled();
      if (!isDeepStrictEqual(prepared.binding, staged.binding)) throw invalid();
      operation.receipts[preparedKey] = prepared;
      operation.completed.push(preparedKey);
      store.save(operation);
      result = prepared;
    }
  } finally {
    if (ownsHost) await drain();
  }
  stillOwned();
  cancelled();
  return result;

  async function drain() {
    let journalError: unknown;
    try {
      stillOwned();
      operation.step = stopKey;
      store.save(operation);
    } catch (error) {
      journalError = error;
    }
    // The persisted owner intent authorizes draining even when a later journal write fails.
    const stopped = await runtime.stop();
    if (!isDeepStrictEqual(stopped, { protocolVersion: 1, state: 'stopped' }))
      throw new Refusal('native_shutdown_unconfirmed');
    if (journalError) throw journalError;
    stillOwned();
    operation.receipts[stopKey] = stopped;
    if (!operation.completed.includes(stopKey))
      operation.completed.push(stopKey);
    store.save(operation);
  }
}
