import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { digest, Refusal, type Operation } from '../contracts.js';
import { Store } from '../store.js';
import {
  NativeRestoreContextSchema,
  NativeRestoreReviewSchema,
  revalidateNativeRestoreReview,
} from './native-restore-review.js';
import {
  readNativeBackupDirectory,
  readNativeCheckpointJson,
} from './native-checkpoint-staging.js';

export const NativeRestoreInputBinding = z
  .object({
    schemaVersion: z.literal(1),
    runtime: z.literal('native'),
    operationId: z.string().uuid(),
    reviewId: z.string().uuid(),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    installationId: z.string().regex(/^[a-f0-9]{12}$/),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    libraryId: z.string().regex(/^[a-f0-9]{12}$/),
    recoverySha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const Accepted = z
  .object({
    review: NativeRestoreReviewSchema,
    acceptedAt: z.number().int().nonnegative(),
  })
  .strict();
const changed = () => new Refusal('native_restore_input_changed');
async function directory(path: string) {
  const value = await lstat(path);
  if (
    path !== resolve(path) ||
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    (process.platform !== 'win32' && (value.mode & 0o077) !== 0)
  )
    throw changed();
  return value;
}
async function syncDirectory(path: string) {
  // Staging remains reconstructible from the accepted review on Windows; it is not activation authority.
  if (process.platform === 'win32') return;
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Stages immutable input only, under the existing restore operation lock. It never starts or changes PostgreSQL. */
export async function stageNativeRestoreInput(
  store: Store,
  input: z.infer<typeof NativeRestoreContextSchema>,
  operation: Operation,
) {
  const context = NativeRestoreContextSchema.parse(input);
  const reviewId = operation.input?.reviewId;
  if (
    operation.kind !== 'restore' ||
    operation.state !== 'running' ||
    !z.string().uuid().safeParse(operation.id).success ||
    !z.string().uuid().safeParse(reviewId).success ||
    !Array.isArray(operation.completed) ||
    !operation.receipts ||
    !isDeepStrictEqual(operation.input, {
      reviewId,
      runtime: 'native',
      installationId: context.installation.id,
      fingerprint: digest(context.installation),
    }) ||
    !isDeepStrictEqual(
      store.history().find((value) => value.id === operation.id),
      operation,
    ) ||
    store.get('native-library-id') !== context.libraryId
  )
    throw changed();
  function stillOwned() {
    if (
      !isDeepStrictEqual(
        store.history().find((value) => value.id === operation.id),
        operation,
      ) ||
      store.get('native-library-id') !== context.libraryId
    )
      throw changed();
  }
  const intentKey = 'native-restore-review-accepted',
    key = 'native-restore-input';
  let accepted: z.infer<typeof Accepted>;
  if (operation.receipts[intentKey] === undefined) {
    const review = await revalidateNativeRestoreReview(
      store,
      context,
      reviewId as string,
    );
    const acceptedAt = Date.now();
    if (acceptedAt >= review.expires)
      throw new Refusal('native_restore_review_expired');
    stillOwned();
    accepted = { review, acceptedAt };
    operation.receipts[intentKey] = accepted;
    operation.step = key;
    store.save(operation);
  } else {
    const parsed = Accepted.safeParse(operation.receipts[intentKey]);
    if (!parsed.success) throw changed();
    accepted = parsed.data;
  }
  const { review } = accepted;
  if (
    review.id !== reviewId ||
    review.contextFingerprint !== digest(context) ||
    review.recovery.libraryId !== context.libraryId ||
    accepted.acceptedAt >= review.expires
  )
    throw changed();
  const binding = NativeRestoreInputBinding.parse({
    schemaVersion: 1,
    runtime: 'native',
    operationId: operation.id,
    reviewId,
    snapshotId: review.snapshot,
    installationId: context.installation.id,
    manifestSha256: context.installation.manifestSha256,
    sourceRevision: context.installation.sourceRevision,
    libraryId: context.libraryId,
    recoverySha256: digest(review.recovery),
  });
  const root = join(context.installation.state, 'restore-input'),
    target = join(root, operation.id);
  const result = { directory: target, binding };
  if (
    operation.completed.includes(key) !==
      Object.hasOwn(operation.receipts, key) ||
    (operation.receipts[key] !== undefined &&
      !isDeepStrictEqual(operation.receipts[key], result))
  )
    throw changed();
  try {
    const profile = await directory(context.installation.state);
    const marker = await readNativeCheckpointJson(
      join(context.installation.state, 'host-state.json'),
    );
    if (
      !isDeepStrictEqual(marker, {
        schemaVersion: 1,
        manifestSha256: binding.manifestSha256,
        sourceRevision: binding.sourceRevision,
        postgresMajor: '19',
      })
    )
      throw changed();
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const parent = await directory(root);
    async function sameParents() {
      const freshProfile = await directory(context.installation.state),
        freshParent = await directory(root);
      if (
        profile.dev !== freshProfile.dev ||
        profile.ino !== freshProfile.ino ||
        parent.dev !== freshParent.dev ||
        parent.ino !== freshParent.ino ||
        store.get('native-library-id') !== context.libraryId
      )
        throw changed();
      if (
        !isDeepStrictEqual(
          await readNativeCheckpointJson(
            join(context.installation.state, 'host-state.json'),
          ),
          marker,
        )
      )
        throw changed();
      stillOwned();
    }
    async function verifyPublished() {
      await directory(target);
      if (
        (await readdir(target)).sort().join(',') !== 'input,restore-intent.json'
      )
        throw changed();
      const record = join(target, 'restore-intent.json'),
        metadata = await lstat(record);
      if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
        throw changed();
      if (
        !isDeepStrictEqual(
          NativeRestoreInputBinding.parse(
            await readNativeCheckpointJson(record),
          ),
          binding,
        ) ||
        !isDeepStrictEqual(
          await readNativeBackupDirectory(join(target, 'input')),
          review.recovery,
        )
      )
        throw changed();
      await sameParents();
    }
    const exists = await lstat(target)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
    if (!exists) {
      const source = join(store.directory, 'native-restore-reviews', review.id);
      await directory(store.directory);
      await directory(join(store.directory, 'native-restore-reviews'));
      if (
        !isDeepStrictEqual(
          await readNativeBackupDirectory(source),
          review.recovery,
        )
      )
        throw changed();
      const attemptId = randomUUID(),
        temporary = join(root, `.${operation.id}.${attemptId}.partial`);
      // Record every exclusive attempt before copying; interrupted or unknown contents are retained, never swept.
      stillOwned();
      operation.receipts[`native-restore-input-attempt:${attemptId}`] = {
        binding,
      };
      store.save(operation);
      await mkdir(temporary, { mode: 0o700 });
      await mkdir(join(temporary, 'input'), { mode: 0o700 });
      for (const name of ['database.dump', 'recovery.json']) {
        const destination = join(temporary, 'input', name);
        await copyFile(
          join(source, name),
          destination,
          constants.COPYFILE_EXCL,
        );
        const file = await open(
          destination,
          constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          await file.chmod(0o600);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      if (
        !isDeepStrictEqual(
          await readNativeBackupDirectory(join(temporary, 'input')),
          review.recovery,
        ) ||
        !isDeepStrictEqual(
          await readNativeBackupDirectory(source),
          review.recovery,
        )
      )
        throw changed();
      const file = await open(
        join(temporary, 'restore-intent.json'),
        'wx',
        0o600,
      );
      try {
        await file.writeFile(JSON.stringify(binding) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(join(temporary, 'input'));
      await syncDirectory(temporary);
      await sameParents();
      await rename(temporary, target);
    }
    await verifyPublished();
    await syncDirectory(root);
    stillOwned();
    operation.receipts[key] = result;
    if (!operation.completed.includes(key)) operation.completed.push(key);
    store.save(operation);
    return result;
  } catch {
    throw changed();
  }
}
