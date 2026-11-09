import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** A manifest path is never authority: caller supplies only current owner-managed roots. */
export const assertOwnerRestorePath = async (roots: string[], target: string): Promise<void> => {
  if (!isAbsolute(target) || target.includes('\0') || target.split(/[\\/]/).includes('..'))
    throw new Error('Owner restore destination unavailable');
  const path = resolve(target);
  for (const root of roots) {
    const base = resolve(root);
    const below = relative(base, path);
    if (!below || below.startsWith(`..${sep}`) || below === '..' || isAbsolute(below)) continue;
    // Roots, every existing descendant and the destination itself must have no symlink indirection.
    try {
      if ((await realpath(base)) !== base || !(await lstat(base)).isDirectory()) continue;
    } catch {
      continue;
    }
    let at = path;
    while (at !== base) {
      try {
        const info = await lstat(at);
        if (info.isSymbolicLink() || (at === path ? !info.isFile() || info.nlink > 1 : !info.isDirectory()))
          throw new Error('Owner restore destination unavailable');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      at = dirname(at);
    }
    return;
  }
  throw new Error('Owner restore destination unavailable');
};

/** Identity is evidence about this file version, not authority to access its path. */
const ownerRestoreFileIdentity = async (target: string): Promise<string | null> => {
  try {
    const info = await lstat(target, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
      throw new Error('Owner restore destination unavailable');
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

/** A rename changes ctime: an identity without that final field, for the verified staged inode. */
const withoutCtime = (value: string | null) => value?.split(':').slice(0, 4).join(':') ?? null;

export const assertOwnerRestoreFile = async (
  target: string,
  identity: string | null,
  renamed = false,
): Promise<void> => {
  const current = await ownerRestoreFileIdentity(target);
  // A rename changes ctime. Only that final field may differ for the verified staged inode.
  const comparable = (value: string | null) => (renamed ? withoutCtime(value) : value);
  if (comparable(current) !== comparable(identity)) throw new Error('Owner restore original changed');
};

/**
 * FL-1333: the check after a verified staged file was published at `target`. Returns the published file's identity,
 * the evidence any later check compares with. A hard link is the staged file, with its identity. A drive without
 * hard links gets a copy, with an identity of its own: it is kept only as one regular file (one name) of the staged
 * size that hashes to `sha256`, the checked bytes, and that stays the same file while it is hashed. Anything else
 * is refused as changed.
 */
export const assertOwnerRestorePublished = async (
  target: string,
  staged: { identity: string | null; size: bigint | null },
  sha256: string,
  hash: (target: string) => Promise<string>,
): Promise<string> => {
  // a regular file with one name, or refused as unavailable; null when nothing is there
  const current = await ownerRestoreFileIdentity(target);
  if (current !== null && withoutCtime(current) === withoutCtime(staged.identity)) return current;
  if (current === null || staged.size === null || BigInt(current.split(':', 3)[2]) !== staged.size)
    throw new Error('Owner restore original changed');
  if ((await hash(target)) !== sha256) throw new Error('Owner restore original changed');
  await assertOwnerRestoreFile(target, current);
  return current;
};

/** Whole-file I/O belongs before the short publication transaction. Bind even a missing target. */
export const captureOwnerRestoreFile = async (
  target: string,
  hash: (target: string) => Promise<string>,
): Promise<{ identity: string | null; sha256: string | null; size: bigint | null }> => {
  const identity = await ownerRestoreFileIdentity(target);
  const sha256 = identity === null ? null : await hash(target);
  await assertOwnerRestoreFile(target, identity);
  return { identity, sha256, size: identity === null ? null : BigInt(identity.split(':', 3)[2]) };
};
