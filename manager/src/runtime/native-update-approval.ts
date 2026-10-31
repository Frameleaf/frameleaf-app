import { createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { digest, Refusal, sha256 } from '../contracts.js';
import { Store } from '../store.js';
import {
  SecureInstallationIdSchema,
  type NativeInstallation,
  type NativeRuntime,
} from './native.js';
import { NativeRecovery, createNativeRecovery } from './native-recovery.js';
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeUpdateApprovalRequest = z
  .object({
    backupOperationId: SecureInstallationIdSchema,
    targetManifestSha256: hex,
    migrationsApproved: z.literal(true),
    key: SecureInstallationIdSchema,
  })
  .strict();
type Context = {
  managerFingerprint: string;
  installation: NativeInstallation;
  libraryId: string;
  name: string;
  release: string;
};
const invalid = () => new Refusal('native_update_approval_unavailable');
const Result = z.object({ snapshotId: hex, recovery: NativeRecovery }).strict();
async function stoppedJournal(context: Context) {
  const root = context.installation.state,
    path = join(root, 'controller-state.json');
  const parent = await lstat(root),
    named = await lstat(path);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1 ||
    named.size > 4096 ||
    (process.platform !== 'win32' &&
      ((parent.mode & 0o077) !== 0 || (named.mode & 0o077) !== 0))
  )
    throw invalid();
  const same = (a: typeof named, b: typeof named) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    b.nlink === 1;
  const file = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!same(named, await file.stat())) throw invalid();
    const bytes = Buffer.alloc(4097);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const fresh = await lstat(root);
    if (
      size !== named.size ||
      !same(named, await file.stat()) ||
      !same(named, await lstat(path)) ||
      fresh.dev !== parent.dev ||
      fresh.ino !== parent.ino ||
      fresh.isSymbolicLink()
    )
      throw invalid();
    const raw = bytes.subarray(0, size),
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (
      value.schemaVersion !== 2 ||
      value.installationId !== context.installation.id ||
      value.secureInstallationId !==
        context.installation.secureInstallationId ||
      value.manifestSha256 !== context.installation.manifestSha256 ||
      value.phase !== 'stopped' ||
      value.restorePending !== false ||
      !SecureInstallationIdSchema.safeParse(value.generation).success ||
      !hex.safeParse(value.profileIdentity).success
    )
      throw invalid();
    return {
      controllerStateSha256: sha256(raw),
      generation: value.generation as string,
    };
  } finally {
    await file.close();
  }
}
/** Explicit migration approval from the existing signed native channel; never execution/admission permission. */
export async function approveNativeUpdate(
  store: Store,
  runtime: NativeRuntime,
  context: Context,
  backupKey: string,
  input: unknown,
) {
  const parsed = NativeUpdateApprovalRequest.safeParse(input);
  if (!parsed.success || !/^[A-Za-z0-9_-]{43}$/.test(backupKey))
    throw invalid();
  const request = parsed.data;
  const latest = () =>
    store.db
      .prepare('SELECT value FROM operations ORDER BY rowid DESC LIMIT 1')
      .get() as { value: string } | undefined;
  const before = latest();
  if (!before) throw invalid();
  const operation = JSON.parse(before.value);
  function evidence() {
    const now = Date.now(),
      binding = store.get<{ fingerprint: string; descriptor: unknown }>(
        'native-installation',
      );
    if (
      latest()?.value !== before!.value ||
      store.db
        .prepare('SELECT 1 FROM operations WHERE active=1 LIMIT 1')
        .get() ||
      runtime.status().state !== 'stopped' ||
      runtime.identity.runtime !== 'native' ||
      runtime.identity.installationId !== context.installation.id ||
      runtime.identity.fingerprint !== digest(context.installation) ||
      store.get('native-library-id') !== context.libraryId ||
      !binding ||
      !hex.safeParse(binding.fingerprint).success ||
      binding.fingerprint !== context.managerFingerprint ||
      digest(binding.descriptor) !== binding.fingerprint ||
      request.targetManifestSha256 === context.installation.manifestSha256 ||
      operation.id !== request.backupOperationId ||
      operation.kind !== 'backup' ||
      operation.state !== 'complete' ||
      !isDeepStrictEqual(operation.input, runtime.identity) ||
      !Number.isSafeInteger(operation.createdAt) ||
      !Number.isSafeInteger(operation.updatedAt) ||
      operation.createdAt < 0 ||
      operation.createdAt > operation.updatedAt ||
      operation.updatedAt > now ||
      now - operation.updatedAt > 600000
    )
      throw invalid();
    const result = Result.safeParse(
      operation.receipts?.['native-backup-verified'],
    );
    if (!result.success) throw invalid();
    if (
      !isDeepStrictEqual(
        createNativeRecovery(
          { ...context, operation },
          result.data.recovery.checkpoint,
        ),
        result.data.recovery,
      )
    )
      throw invalid();
    const checkpoint = result.data.recovery.checkpoint;
    if (
      !isDeepStrictEqual(
        operation.receipts?.['native-backup-database-intent'],
        runtime.identity,
      )
    )
      throw invalid();
    const expected = {
      'native-backup-start-database': {
        protocolVersion: 1,
        state: 'database-ready',
        secureInstallationId: context.installation.secureInstallationId,
        manifestSha256: context.installation.manifestSha256,
        sourceRevision: context.installation.sourceRevision,
        certified: context.installation.certified,
      },
      'native-backup-checkpoint': checkpoint,
      'native-backup-encrypt': result.data,
      'native-backup-verified': result.data,
      'native-backup-owner-cleaned': {
        ...checkpoint,
        state: 'checkpoint-cleaned',
      },
      'native-backup-stage-cleaned': {
        directory: join(store.directory, 'native-backup-staging', operation.id),
        recoverySha256: digest(result.data.recovery),
      },
      'native-backup-stop-database': { protocolVersion: 1, state: 'stopped' },
    };
    for (const [key, value] of Object.entries(expected))
      if (
        !operation.completed?.includes(key) ||
        !isDeepStrictEqual(operation.receipts?.[key], value)
      )
        throw invalid();
    return { binding: binding.fingerprint, result: result.data };
  }
  evidence();
  const journal = await stoppedJournal(context);
  // Revalidate after asynchronous I/O, and serialize idempotent approval publication with lifecycle writes.
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const { binding, result } = evidence();
    const facts = {
      schemaVersion: 1,
      approvalId: request.key,
      installationId: context.installation.id,
      secureInstallationId: context.installation.secureInstallationId,
      libraryId: context.libraryId,
      sourceManifestSha256: context.installation.manifestSha256,
      sourceRevision: context.installation.sourceRevision,
      targetManifestSha256: request.targetManifestSha256,
      managerFingerprint: binding,
      backupOperationId: operation.id,
      snapshotId: result.snapshotId,
      recoverySha256: digest(result.recovery),
      checkpoint: result.recovery.checkpoint,
      ...journal,
      migrationsApproved: true,
    };
    const key = `native-update-approval:${request.key}`;
    const prior = store.get<{
      facts: typeof facts;
      issuedAt: number;
      expiresAt: number;
      approval: string;
    }>(key);
    let receipt = prior;
    if (prior) {
      if (
        !isDeepStrictEqual(prior.facts, facts) ||
        !Number.isSafeInteger(prior.issuedAt) ||
        prior.issuedAt > Date.now() ||
        prior.expiresAt - prior.issuedAt !== 300000 ||
        prior.expiresAt <= Date.now()
      )
        throw invalid();
      const raw = Buffer.from(
        JSON.stringify({
          ...facts,
          issuedAt: prior.issuedAt,
          expiresAt: prior.expiresAt,
        }),
      );
      const expected =
        raw.toString('base64url') +
        '.' +
        createHmac('sha256', backupKey)
          .update('frameleaf-native-update-approval-v1\0')
          .update(raw)
          .digest('hex');
      if (prior.approval !== expected) throw invalid();
    } else {
      const issuedAt = Date.now(),
        expiresAt = issuedAt + 300000;
      const raw = Buffer.from(
        JSON.stringify({ ...facts, issuedAt, expiresAt }),
      );
      const approval =
        raw.toString('base64url') +
        '.' +
        createHmac('sha256', backupKey)
          .update('frameleaf-native-update-approval-v1\0')
          .update(raw)
          .digest('hex');
      receipt = { facts, issuedAt, expiresAt, approval };
      store.set(key, receipt);
    }
    store.db.exec('COMMIT');
    return { approval: receipt!.approval };
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
