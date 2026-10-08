import { lstat, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AttemptDirectoryWindows } from 'src/utils/attempt-directory.js';

export const ATTEMPT_GRACE_MS = 24 * 60 * 60 * 1000;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const SHARP_STAGING = /^\.sharp-[a-zA-Z0-9]{6}$/;
export type AttemptIdentity = { jobId: string; token: string };
export type AttemptCursor = { root: number; stack: { path: string; after: string }[] };
export const emptyAttemptCursor = (): AttemptCursor => ({ root: 0, stack: [] });

export function attemptIdentity(path: string): AttemptIdentity | undefined {
  const parts = resolve(path).split(sep);
  const index = parts.lastIndexOf('.attempts');
  if (
    index === -1 ||
    !(parts.length === index + 4 || (parts.length === index + 5 && SHARP_STAGING.test(parts[index + 3]))) ||
    !UUID.test(parts[index + 1]) ||
    !UUID.test(parts[index + 2])
  )
    return;
  return { jobId: parts[index + 1], token: parts[index + 2] };
}

/** Check each component before descending: a symlink is never a directory to traverse. */
export async function realAttemptEntry(path: string) {
  const absolute = resolve(path);
  let current: string = sep;
  try {
    const parts = absolute.split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) return;
      if (index === parts.length - 1) return stat;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Only the exact inode inspected as an old regular file may be removed. No recursive deletes. */
export async function unlinkOldAttempt(path: string, cutoff: number, identity: { dev: number; ino: number }) {
  const stat = await realAttemptEntry(path);
  if (!stat?.isFile() || stat.mtimeMs >= cutoff || stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function removeEmptyAttempt(path: string, cutoff: number, identity: { dev: number; ino: number }) {
  const stat = await realAttemptEntry(path);
  if (!stat?.isDirectory() || stat.mtimeMs >= cutoff || stat.dev !== identity.dev || stat.ino !== identity.ino)
    return false;
  try {
    await rmdir(path);
    // The caller still holds this job's stop proof and lock. Its now-empty parent
    // job directory is safe to release too; never recurse or remove .attempts itself.
    // A staging directory's parent is the claim directory and needs its own age check.
    if (!SHARP_STAGING.test(basename(path)) && (await realAttemptEntry(dirname(path)))?.isDirectory()) {
      await rmdir(dirname(path)).catch((error: NodeJS.ErrnoException) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error;
      });
    }
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

/**
 * Persisted lexicographic DFS; the next invocation continues after the last examined entry.
 * Directory listings are streamed in bounded lexical windows. A partial window continues
 * next slice, or rescans from the same lexical position after a process restart.
 * Newly inserted names before a cursor are also visited on the next traversal.
 */
export async function sweepAttemptTree(options: {
  roots: string[];
  cursor: AttemptCursor;
  remove: (path: string, identity: AttemptIdentity, unlink: () => Promise<boolean>) => Promise<boolean>;
  now?: number;
  maxEntries?: number;
  maxFiles?: number;
  maxMs?: number;
  maxDirectoryEntries?: number;
  windows?: AttemptDirectoryWindows;
}) {
  const {
    roots,
    remove,
    now = Date.now(),
    maxEntries = 1000,
    maxFiles = 100,
    maxMs = 5000,
    maxDirectoryEntries = 4096,
  } = options;
  const cursor = structuredClone(options.cursor);
  const deadline = Date.now() + maxMs;
  const windows = options.windows ?? new AttemptDirectoryWindows();
  const budget = { reads: 0, maximum: maxDirectoryEntries, deadline };
  const cutoff = now - ATTEMPT_GRACE_MS;
  let visited = 0;
  let examined = 0;
  let deleted = 0;
  let incomplete = false;
  // Metadata corruption or a changed mount must never expand the configured roots.
  const root = roots[cursor.root];
  if (
    !Number.isSafeInteger(cursor.root) ||
    cursor.root < 0 ||
    cursor.root > roots.length ||
    cursor.stack.length > 16 ||
    cursor.stack.some(
      (entry) =>
        !root ||
        isAbsolute(relative(resolve(root), entry.path)) ||
        relative(resolve(root), entry.path).split(sep).includes('..'),
    )
  ) {
    throw new Error('Invalid attempt cleanup cursor');
  }
  try {
    while (cursor.root < roots.length && visited < maxEntries && examined < maxFiles && Date.now() < deadline) {
      if (cursor.stack.length === 0) cursor.stack.push({ path: resolve(roots[cursor.root]), after: '' });
      const frame = cursor.stack.at(-1)!;
      const stat = await realAttemptEntry(frame.path);
      if (!stat?.isDirectory()) {
        incomplete = true;
        windows.release(frame.path);
        cursor.stack.pop();
        if (cursor.stack.length === 0) cursor.root++;
        visited++;
        continue;
      }
      const names = await windows.read(frame.path, frame.after, budget);
      if (!names) break;
      const name = names.find((name) => name > frame.after);
      if (!name) {
        // Keep evidence for an empty claim directory until its own grace period has
        // elapsed. This also bounds directory/inode growth across repeated runs.
        const identity = attemptIdentity(join(frame.path, '_empty'));
        if (identity) {
          examined++;
          await remove(frame.path, identity, () => removeEmptyAttempt(frame.path, cutoff, stat));
        }
        windows.release(frame.path);
        cursor.stack.pop();
        if (cursor.stack.length === 0) cursor.root++;
        continue;
      }
      frame.after = name;
      visited++;
      const path = join(frame.path, name);
      if (
        name.startsWith('.') &&
        name !== '.attempts' &&
        !(SHARP_STAGING.test(name) && attemptIdentity(join(path, '_empty')))
      )
        continue;
      const entry = await realAttemptEntry(path);
      if (!entry || (entry.isDirectory() && cursor.stack.length >= 16)) incomplete = true;
      if (entry?.isDirectory() && cursor.stack.length < 16) {
        cursor.stack.push({ path, after: '' });
      } else if (entry?.isFile()) {
        const identity = attemptIdentity(path);
        if (!identity) continue;
        examined++;
        if (await remove(path, identity, () => unlinkOldAttempt(path, cutoff, entry))) deleted++;
      }
    }
    const done = cursor.root === roots.length;
    return { cursor: done ? emptyAttemptCursor() : cursor, visited, examined, deleted, incomplete, done };
  } finally {
    if (!options.windows) await windows.close();
  }
}
