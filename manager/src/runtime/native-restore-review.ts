import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { digest, Refusal, releaseTag } from '../contracts.js';
import type { Backups } from '../backups.js';
import { Store } from '../store.js';
import { NativeInstallationSchema } from './native.js';
import { NativeRecovery } from './native-recovery.js';
import { readNativeBackupDirectory } from './native-checkpoint-staging.js';

const Context = z
  .object({
    installation: NativeInstallationSchema,
    libraryId: z.string().regex(/^[a-f0-9]{12}$/),
    release: releaseTag,
  })
  .strict();
type Context = z.infer<typeof Context>;
const Prepared = z
  .object({
    id: z.string().uuid(),
    state: z.literal('prepared'),
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    expires: z.number().int().nonnegative(),
    contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    recovery: NativeRecovery,
  })
  .strict();
const refused = (code: string) => new Refusal(code);

async function privateDirectory(path: string) {
  const value = await lstat(path);
  if (
    path !== resolve(path) ||
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    (process.platform !== 'win32' && (value.mode & 0o077) !== 0)
  )
    throw refused('native_restore_review_changed');
  return value;
}

/** Prepares review evidence only. It grants no authority to stop a host or write a database. */
export async function prepareNativeRestoreReview(
  store: Store,
  backups: Pick<Backups, 'restore'>,
  input: Context,
  snapshot: string,
) {
  const parsed = Context.safeParse(input);
  if (
    !parsed.success ||
    !z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .safeParse(snapshot).success ||
    store.get('native-library-id') !== parsed.data.libraryId
  )
    throw refused('native_restore_request_invalid');
  const context = parsed.data;
  await privateDirectory(store.directory);
  const root = join(store.directory, 'native-restore-reviews');
  await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const parent = await privateDirectory(root);
  const id = randomUUID();
  const intent = {
    id,
    snapshot,
    expires: Date.now() + 900_000,
    contextFingerprint: digest(context),
  };
  const key = `native-restore-review:${id}`;
  if (!store.createOnce(key, { ...intent, state: 'preparing' }))
    throw refused('native_restore_review_changed');
  try {
    const path = join(root, id);
    await backups.restore(snapshot, path);
    const recovery = await readNativeBackupDirectory(path);
    const fresh = await privateDirectory(root);
    if (
      intent.expires <= Date.now() ||
      fresh.dev !== parent.dev ||
      fresh.ino !== parent.ino ||
      recovery.libraryId !== context.libraryId ||
      store.get('native-library-id') !== context.libraryId
    )
      throw refused('native_restore_review_changed');
    const review = Prepared.parse({ ...intent, state: 'prepared', recovery });
    store.set(key, review);
    return {
      id,
      expires: review.expires,
      libraryId: recovery.libraryId,
      release: recovery.installation.release,
      targetRelease: context.release,
      createdAt: recovery.createdAt,
      mediaIncluded: false as const,
      requiresRuntimeChange:
        recovery.installation.release !== context.release ||
        recovery.checkpoint.sourceRevision !==
          context.installation.sourceRevision,
    };
  } catch {
    // Unknown or changed files are retained with this failed review; never sweep caller-controlled restore contents.
    store.set(key, {
      ...intent,
      state: 'failed',
      error: 'native_restore_verification_failed',
    });
    throw refused('native_restore_verification_failed');
  }
}

/** Recheck immediately before the later restore operation takes any host action. */
export async function revalidateNativeRestoreReview(
  store: Store,
  input: Context,
  id: string,
) {
  const context = Context.safeParse(input);
  if (!context.success || !z.string().uuid().safeParse(id).success)
    throw refused('native_restore_review_changed');
  const parsed = Prepared.safeParse(store.get(`native-restore-review:${id}`));
  if (
    !parsed.success ||
    parsed.data.id !== id ||
    parsed.data.contextFingerprint !== digest(context.data) ||
    parsed.data.recovery.libraryId !== context.data.libraryId ||
    store.get('native-library-id') !== context.data.libraryId
  )
    throw refused('native_restore_review_changed');
  const review = parsed.data;
  if (review.expires <= Date.now())
    throw refused('native_restore_review_expired');
  try {
    await privateDirectory(store.directory);
    const root = join(store.directory, 'native-restore-reviews');
    await privateDirectory(root);
    const recovery = await readNativeBackupDirectory(join(root, id));
    if (digest(recovery) !== digest(review.recovery))
      throw refused('native_restore_review_changed');
  } catch {
    throw refused('native_restore_review_changed');
  }
  if (review.expires <= Date.now())
    throw refused('native_restore_review_expired');
  if (store.get('native-library-id') !== context.data.libraryId)
    throw refused('native_restore_review_changed');
  return review;
}

export {
  Context as NativeRestoreContextSchema,
  Prepared as NativeRestoreReviewSchema,
};
