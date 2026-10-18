import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { digest, Refusal, type Operation } from '../contracts.js';
import { Store } from '../store.js';
import { nativeStopped, type NativeRuntime } from './native.js';
import { z } from 'zod';
import { createNativeRecovery, NativeRecovery } from './native-recovery.js';
import { completeNativeDatabaseBackup } from './native-backup-journal.js';
import { stageNativeRestoreInput } from './native-restore-input.js';
import { NativeRestoreContextSchema } from './native-restore-review.js';
import {
  NativeRestorePreparedSchema,
  NativeRestoreVerifiedSchema,
  NativeRestoreSelectionSchema,
  NativeRestoreFinalizedSchema,
  type NativeRestorePrepared,
} from './native-restore-contract.js';

type Context = Parameters<typeof stageNativeRestoreInput>[1];

/** Keeps the parent restore locked while the original database is backed up and drained. */
export async function runNativeRestorePrebackup(
  store: Store,
  runtime: NativeRuntime,
  backups: Parameters<typeof completeNativeDatabaseBackup>[2],
  input: Parameters<typeof completeNativeDatabaseBackup>[3],
  operation: Operation,
  signal?: AbortSignal,
) {
  const { name, ...reviewContext } = input;
  const context = NativeRestoreContextSchema.parse(reviewContext);
  const identity = {
    runtime: 'native',
    installationId: context.installation.id,
    fingerprint: digest(context.installation),
  };
  const invalid = () => new Refusal('native_restore_journal_invalid');
  function stillOwned() {
    if (
      operation.kind !== 'restore' ||
      operation.state !== 'running' ||
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
  cancelled();
  const staged = await stageNativeRestoreInput(store, context, operation);
  stillOwned();
  cancelled();
  const key = 'native-restore-prebackup-intent';
  const intent = { schemaVersion: 1, binding: staged.binding };
  if (
    operation.receipts[key] !== undefined &&
    !isDeepStrictEqual(operation.receipts[key], intent)
  )
    throw invalid();
  const status = runtime.status();
  if (
    status.state === 'starting' ||
    status.state === 'stopping' ||
    (status.state === 'unknown' &&
      status.code !== 'native_owner_not_attached' &&
      operation.receipts[key] === undefined)
  )
    throw new Refusal('native_restore_owner_unavailable');
  const stopIntent = { ...identity, operationId: operation.id };
  if (
    operation.receipts['native-restore-prebackup-stop-intent'] !== undefined &&
    !isDeepStrictEqual(
      operation.receipts['native-restore-prebackup-stop-intent'],
      stopIntent,
    )
  )
    throw invalid();
  record(key, intent);
  // Persist authorization before stopping writers or recovering an interrupted maintenance owner.
  record('native-restore-prebackup-stop-intent', stopIntent);
  await drain();
  cancelled();
  let ownsHost = false;
  try {
    if (!operation.completed.includes('native-backup-owner-cleaned')) {
      const cleanup = operation.completed.includes('native-backup-verified');
      stillOwned();
      operation.step = cleanup
        ? 'native-restore-prebackup-start-cleanup'
        : 'native-restore-prebackup-start-database';
      store.save(operation);
      ownsHost = true;
      const ready = cleanup
        ? await runtime.startCheckpointCleanup()
        : await runtime.startDatabase();
      stillOwned();
      cancelled();
      if (
        !isDeepStrictEqual(ready, {
          protocolVersion: 1,
          state: cleanup ? 'checkpoint-cleanup-ready' : 'database-ready',
          manifestSha256: context.installation.manifestSha256,
          sourceRevision: context.installation.sourceRevision,
          certified: context.installation.certified,
        })
      )
        throw new Refusal('native_host_identity_changed');
    }
    const result = await completeNativeDatabaseBackup(
      store,
      runtime,
      backups,
      { ...context, name },
      operation,
    );
    stillOwned();
    cancelled();
    return result;
  } finally {
    if (ownsHost) await drain();
  }
  function record(key: string, value: unknown) {
    stillOwned();
    operation.step = key;
    operation.receipts[key] = value;
    if (!operation.completed.includes(key)) operation.completed.push(key);
    store.save(operation);
  }
  async function drain() {
    let journalError: unknown;
    try {
      stillOwned();
      operation.step = 'native-restore-prebackup-stop-owner';
      store.save(operation);
    } catch (error) {
      journalError = error;
    }
    const stopped = nativeStopped(await runtime.stop(), context.installation);
    if (journalError) throw journalError;
    record('native-restore-prebackup-stop-owner', stopped);
  }
}

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
    const stopped = nativeStopped(await runtime.stop(), context.installation);
    if (journalError) throw journalError;
    stillOwned();
    operation.receipts[stopKey] = stopped;
    if (!operation.completed.includes(stopKey))
      operation.completed.push(stopKey);
    store.save(operation);
  }
}

/** Leaves the restore operation running/locked until separate writer finalization succeeds. */
export async function runNativeRestoreSelection(
  store: Store,
  runtime: NativeRuntime,
  input: Omit<Parameters<typeof createNativeRecovery>[0], 'operation'>,
  operation: Operation,
  signal?: AbortSignal,
) {
  return NativeRestoreSelectionSchema.parse(
    await runNativeRestoreAdmission(
      store,
      runtime,
      input,
      operation,
      false,
      signal,
    ),
  );
}

/** Retains the restore lock until the caller confirms normal server readiness. */
export async function runNativeRestoreFinalization(
  store: Store,
  runtime: NativeRuntime,
  input: Omit<Parameters<typeof createNativeRecovery>[0], 'operation'>,
  operation: Operation,
  signal?: AbortSignal,
) {
  return NativeRestoreFinalizedSchema.parse(
    await runNativeRestoreAdmission(
      store,
      runtime,
      input,
      operation,
      true,
      signal,
    ),
  );
}

async function runNativeRestoreAdmission(
  store: Store,
  runtime: NativeRuntime,
  input: Omit<Parameters<typeof createNativeRecovery>[0], 'operation'>,
  operation: Operation,
  finalize: boolean,
  signal?: AbortSignal,
) {
  const { name, ...reviewContext } = input;
  const context = NativeRestoreContextSchema.parse(reviewContext);
  const identity = {
    runtime: 'native',
    installationId: context.installation.id,
    fingerprint: digest(context.installation),
  };
  const invalid = () => new Refusal('native_restore_journal_invalid');
  function stillOwned() {
    if (
      operation.kind !== 'restore' ||
      operation.state !== 'running' ||
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
  cancelled();
  if (!Array.isArray(operation.completed) || !operation.receipts)
    throw invalid();
  const backup = z
    .object({
      snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
      recovery: NativeRecovery,
    })
    .strict()
    .parse(operation.receipts['native-backup-verified']);
  const recovery = createNativeRecovery(
    { ...context, name, operation },
    backup.recovery.checkpoint,
  );
  const required = {
    'native-backup-verified': backup,
    'native-backup-encrypt': backup,
    'native-backup-owner-cleaned': {
      ...recovery.checkpoint,
      state: 'checkpoint-cleaned',
    },
    'native-backup-stage-cleaned': {
      directory: join(store.directory, 'native-backup-staging', operation.id),
      recoverySha256: digest(recovery),
    },
  };
  if (!isDeepStrictEqual(backup.recovery, recovery)) throw invalid();
  for (const [key, value] of Object.entries(required))
    if (
      !operation.completed.includes(key) ||
      !isDeepStrictEqual(operation.receipts[key], value)
    )
      throw invalid();
  const phase = finalize ? 'finalization' : 'selection';
  const intentKey = `native-restore-${phase}-owner-intent`,
    selectedKey = finalize
      ? 'native-restore-finalized'
      : 'native-restore-selected';
  const receiptSchema = finalize
    ? NativeRestoreFinalizedSchema
    : NativeRestoreSelectionSchema;
  if (finalize) {
    const selected = NativeRestoreSelectionSchema.safeParse(
      operation.receipts['native-restore-selected'],
    );
    if (
      !operation.completed.includes('native-restore-selected') ||
      !selected.success ||
      selected.data.operationId !== operation.id
    )
      throw invalid();
  } else if (
    operation.receipts['native-restore-finalization-owner-intent'] !==
      undefined ||
    operation.receipts['native-restore-finalized'] !== undefined
  ) {
    throw invalid();
  }
  const intent = { ...identity, operationId: operation.id };
  if (
    operation.receipts[intentKey] !== undefined &&
    !isDeepStrictEqual(operation.receipts[intentKey], intent)
  )
    throw invalid();
  const prior = operation.receipts[selectedKey];
  if (
    operation.completed.includes(selectedKey) !== (prior !== undefined) ||
    (prior !== undefined &&
      receiptSchema.parse(prior).operationId !== operation.id)
  )
    throw invalid();
  const prepared = await runNativeRestorePreparation(
    store,
    runtime,
    context,
    operation,
    signal,
  );
  stillOwned();
  cancelled();
  const safety = {
    snapshotId: backup.snapshotId,
    recoverySha256: digest(recovery),
    checkpoint: recovery.checkpoint,
  };
  let ownsHost = false;
  try {
    record(intentKey, intent);
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
    operation.step = 'native-restore-verify';
    store.save(operation);
    const verified = NativeRestoreVerifiedSchema.parse(
      await runtime.verifyRestore(prepared, signal),
    );
    stillOwned();
    cancelled();
    const { protocolVersion, ...target } = prepared;
    if (!isDeepStrictEqual(verified.prepared, target)) throw invalid();
    // Journal evidence is never reused as a live private capability on retry.
    record(
      finalize
        ? 'native-restore-finalization-verification'
        : 'native-restore-verification',
      verified,
    );
    record(`native-restore-${phase}-request`, {
      operationId: operation.id,
      verificationId: verified.verificationId,
      safety,
    });
    const selected = receiptSchema.parse(
      finalize
        ? await runtime.finalizeRestore(verified, safety, signal)
        : await runtime.selectRestore(verified, safety, signal),
    );
    if (selected.operationId !== operation.id) throw invalid();
    ownsHost = false;
    stillOwned();
    cancelled();
    record(selectedKey, selected);
    return selected;
  } finally {
    if (ownsHost) await drain();
  }
  function record(key: string, value: unknown) {
    stillOwned();
    operation.step = key;
    operation.receipts[key] = value;
    if (!operation.completed.includes(key)) operation.completed.push(key);
    store.save(operation);
  }
  async function drain() {
    let journalError: unknown;
    try {
      stillOwned();
      operation.step = `native-restore-stop-${phase}-owner`;
      store.save(operation);
    } catch (error) {
      journalError = error;
    }
    const stopped = nativeStopped(await runtime.stop(), context.installation);
    if (journalError) throw journalError;
    record(`native-restore-stop-${phase}-owner`, stopped);
  }
}
