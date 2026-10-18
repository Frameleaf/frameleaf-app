import { lstat, mkdir, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { Backups } from '../backups.js';
import { digest, Refusal, type Operation } from '../contracts.js';
import { Store } from '../store.js';
import { NativeCheckpointSchema, type NativeRuntime } from './native.js';
import { createNativeRecovery, NativeRecovery } from './native-recovery.js';
import { stageNativeRestoreInput } from './native-restore-input.js';
import {
  stageNativeCheckpoint,
  verifyNativeBackupDirectory,
  cleanupNativeCheckpointStage,
} from './native-checkpoint-staging.js';

const Result = z
  .object({
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    recovery: NativeRecovery,
  })
  .strict();
type Context = Omit<Parameters<typeof createNativeRecovery>[0], 'operation'>;
type Engine = Pick<Backups, 'initialize' | 'snapshot' | 'restore'>;
const invalid = () => new Refusal('native_backup_journal_invalid');
const verificationFailed = () =>
  new Refusal('native_backup_verification_failed');
function receipt(operation: Operation, key: string): unknown | undefined {
  const completed = operation.completed.includes(key),
    present = Object.hasOwn(operation.receipts, key);
  if (completed !== present) throw invalid();
  return present ? operation.receipts[key] : undefined;
}
function assertNativeBackupOwner(store: Store, operation: Operation) {
  if (
    operation.state !== 'running' ||
    !isDeepStrictEqual(
      store.history().find((value) => value.id === operation.id),
      operation,
    )
  )
    throw invalid();
}
async function step(
  store: Store,
  operation: Operation,
  key: string,
  work: () => Promise<unknown>,
) {
  assertNativeBackupOwner(store, operation);
  operation.step = key;
  store.save(operation);
  const value = await work();
  assertNativeBackupOwner(store, operation);
  operation.receipts[key] = value;
  if (!operation.completed.includes(key)) operation.completed.push(key);
  store.save(operation);
  return value;
}
async function clearVerificationCache(path: string): Promise<void> {
  const directory = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!directory) return;
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (await realpath(path)) !== path
  )
    throw verificationFailed();
  const names = await readdir(path);
  if (names.some((name) => !['database.dump', 'recovery.json'].includes(name)))
    throw verificationFailed();
  for (const name of names) {
    const file = join(path, name),
      value = await lstat(file),
      fresh = await lstat(path);
    if (
      !value.isFile() ||
      value.isSymbolicLink() ||
      value.nlink !== 1 ||
      (await realpath(file)) !== file ||
      directory.dev !== fresh.dev ||
      directory.ino !== fresh.ino
    )
      throw verificationFailed();
    await rm(file);
  }
  await rmdir(path);
}

/** Leaves the Store operation locked/running; the caller must finish receipt-bound owner and stage cleanup. */
export async function createNativeDatabaseBackup(
  store: Store,
  runtime: NativeRuntime,
  backups: Engine,
  context: Context,
  operation: Operation,
): Promise<z.infer<typeof Result>> {
  if (
    !['backup', 'restore'].includes(operation.kind) ||
    operation.state !== 'running' ||
    !Array.isArray(operation.completed) ||
    !isDeepStrictEqual(
      operation.input,
      operation.kind === 'restore'
        ? { reviewId: operation.input?.reviewId, ...runtime.identity }
        : runtime.identity,
    ) ||
    runtime.identity.runtime !== 'native' ||
    runtime.identity.installationId !== context.installation.id ||
    runtime.identity.fingerprint !== digest(context.installation) ||
    !isDeepStrictEqual(
      store.history().find((value) => value.id === operation.id),
      operation,
    )
  )
    throw invalid();
  if (operation.kind === 'restore') {
    const intent = operation.receipts['native-restore-prebackup-intent'];
    if (
      !intent ||
      !operation.completed.includes('native-restore-input') ||
      !operation.receipts['native-restore-input']
    )
      throw invalid();
    const staged = await stageNativeRestoreInput(
      store,
      {
        installation: context.installation,
        libraryId: context.libraryId,
        release: context.release,
      },
      operation,
    );
    const status = runtime.status();
    if (
      !isDeepStrictEqual(intent, {
        schemaVersion: 1,
        binding: staged.binding,
      }) ||
      status.state !== 'unknown' ||
      status.code !== 'native_database_maintenance'
    )
      throw invalid();
  }
  const bound = { ...context, operation };
  const result = (value: unknown) => {
    const parsed = Result.safeParse(value);
    if (!parsed.success) throw invalid();
    try {
      if (
        !isDeepStrictEqual(
          createNativeRecovery(bound, parsed.data.recovery.checkpoint),
          parsed.data.recovery,
        )
      )
        throw invalid();
    } catch {
      throw invalid();
    }
    return parsed.data;
  };
  // Backup retries reuse durable proof; restore retries must freshly read the safety snapshot.
  const verified = receipt(operation, 'native-backup-verified');
  if (verified !== undefined && operation.kind === 'backup')
    return result(verified);
  let encrypted = receipt(operation, 'native-backup-encrypt');
  if (
    verified !== undefined &&
    (encrypted === undefined ||
      !isDeepStrictEqual(result(verified), result(encrypted)))
  )
    throw invalid();
  if (encrypted === undefined) {
    let checkpoint = receipt(operation, 'native-backup-checkpoint');
    if (checkpoint === undefined)
      checkpoint = await step(
        store,
        operation,
        'native-backup-checkpoint',
        async () => {
          const value = await runtime.checkpoint(operation.id);
          createNativeRecovery(bound, value);
          return value;
        },
      );
    const parsed = NativeCheckpointSchema.safeParse(checkpoint);
    if (!parsed.success) throw invalid();
    const recovery = createNativeRecovery(bound, parsed.data);
    const priorStage = receipt(operation, 'native-backup-stage');
    if (priorStage !== undefined) {
      const expected = {
        directory: join(store.directory, 'native-backup-staging', operation.id),
        recovery,
      };
      if (!isDeepStrictEqual(priorStage, expected)) throw invalid();
    }
    const stage = (await step(store, operation, 'native-backup-stage', () =>
      stageNativeCheckpoint(store.directory, bound, parsed.data),
    )) as { directory: string; recovery: z.infer<typeof NativeRecovery> };
    encrypted = await step(
      store,
      operation,
      'native-backup-encrypt',
      async () => {
        await backups.initialize();
        const snapshotId = await backups.snapshot(
          stage.directory,
          operation.id,
        );
        await verifyNativeBackupDirectory(stage.directory, recovery);
        return result({ snapshotId, recovery });
      },
    );
  }
  const pending = result(encrypted);
  const root = join(store.directory, 'native-backup-verification');
  const cache = join(root, operation.id);
  const intent = {
    directory: cache,
    snapshotId: pending.snapshotId,
    recoverySha256: digest(pending.recovery),
  };
  const intentKey = 'native-backup-verification-intent';
  const existingIntent = operation.receipts[intentKey];
  if (
    existingIntent !== undefined &&
    !isDeepStrictEqual(existingIntent, intent)
  )
    throw invalid();
  await step(store, operation, 'native-backup-verified', async () => {
    try {
      if (
        store.directory !== resolve(store.directory) ||
        (await realpath(store.directory)) !== store.directory
      )
        throw verificationFailed();
      await mkdir(root, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
      const parent = await lstat(root);
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        (await realpath(root)) !== root
      )
        throw verificationFailed();
      if (existingIntent === undefined) {
        const exists = await lstat(cache)
          .then(() => true)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          });
        if (exists) throw verificationFailed();
        assertNativeBackupOwner(store, operation);
        operation.receipts[intentKey] = intent;
        store.save(operation);
      }
      await clearVerificationCache(cache);
      try {
        await backups.restore(pending.snapshotId, cache);
        await verifyNativeBackupDirectory(cache, pending.recovery);
      } finally {
        await clearVerificationCache(cache);
      }
      return pending;
    } catch {
      throw verificationFailed();
    }
  });
  return pending;
}

/** Completes cleanup but leaves Store lock release to the owning NativeOperations runner. */
export async function completeNativeDatabaseBackup(
  store: Store,
  runtime: NativeRuntime,
  backups: Engine,
  context: Context,
  operation: Operation,
): Promise<z.infer<typeof Result>> {
  if (
    !Array.isArray(operation.completed) ||
    !operation.receipts ||
    typeof operation.receipts !== 'object'
  )
    throw invalid();
  const ownerKey = 'native-backup-owner-cleaned',
    stageKey = 'native-backup-stage-cleaned';
  const intentKey = 'native-backup-stage-cleanup-intent';
  const owner = receipt(operation, ownerKey),
    stage = receipt(operation, stageKey);
  const intent = operation.receipts[intentKey];
  if (
    ((owner !== undefined || stage !== undefined || intent !== undefined) &&
      receipt(operation, 'native-backup-verified') === undefined) ||
    ((stage !== undefined || intent !== undefined) && owner === undefined) ||
    (stage !== undefined && intent === undefined)
  )
    throw invalid();
  const result = await createNativeDatabaseBackup(
    store,
    runtime,
    backups,
    context,
    operation,
  );
  assertNativeBackupOwner(store, operation);
  const expectedOwner = {
    ...result.recovery.checkpoint,
    state: 'checkpoint-cleaned',
  };
  const expectedStage = {
    directory: join(store.directory, 'native-backup-staging', operation.id),
    recoverySha256: digest(result.recovery),
  };
  if (
    (owner !== undefined && !isDeepStrictEqual(owner, expectedOwner)) ||
    (intent !== undefined && !isDeepStrictEqual(intent, expectedStage)) ||
    (stage !== undefined && !isDeepStrictEqual(stage, expectedStage))
  )
    throw invalid();
  if (stage !== undefined) return result;
  if (owner === undefined)
    await step(store, operation, ownerKey, async () => {
      const cleaned = await runtime.cleanupCheckpoint(
        result.recovery.checkpoint,
      );
      if (!isDeepStrictEqual(cleaned, expectedOwner)) throw invalid();
      return cleaned;
    });
  if (intent === undefined) {
    assertNativeBackupOwner(store, operation);
    operation.receipts[intentKey] = expectedStage;
    store.save(operation);
  }
  await step(store, operation, stageKey, async () => {
    const cleaned = await cleanupNativeCheckpointStage(
      store.directory,
      result.recovery,
    );
    if (!isDeepStrictEqual(cleaned, expectedStage)) throw invalid();
    return cleaned;
  });
  return result;
}
