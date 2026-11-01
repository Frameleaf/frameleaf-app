import { createHash } from 'node:crypto';
import { BigIntStats, constants } from 'node:fs';
import { FileHandle, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ImportManifest, parseImportManifest } from 'src/library-import/manifest.js';

export class BundleVerificationError extends Error {
  constructor(readonly code: string) {
    super(`Library import refused: ${code}`);
  }
}
const refuse = (code: string): never => {
  throw new BundleVerificationError(code);
};
const sameIdentity = (before: BigIntStats, after: BigIntStats): boolean =>
  before.dev === after.dev && before.ino === after.ino;
const unchangedFile = (before: BigIntStats, after: BigIntStats): boolean =>
  sameIdentity(before, after) &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs &&
  before.nlink === after.nlink;

// Root acquisition must not follow a swapped ancestor before containment is established.
const openRoot = async (path: string): Promise<FileHandle> => {
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const parts = path.split('/').filter(Boolean);
    for (const part of parts) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.close();
      } catch (error) {
        await next.close();
        throw error;
      }
      directory = next;
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
};

// Linux descriptor paths keep each lookup anchored when an ancestor is renamed or replaced.
const openContained = async (root: FileHandle, path: string): Promise<FileHandle> => {
  const parts = path.split('/');
  let directory = root;
  try {
    for (let index = 0; index < parts.length; index++) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${parts[index]}`,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (index < parts.length - 1 ? constants.O_DIRECTORY : 0),
      );
      if (index === parts.length - 1) return next;
      const previous = directory;
      directory = next;
      if (previous !== root) await previous.close();
    }
    return refuse('BUNDLE_PATH_ESCAPE');
  } finally {
    if (directory !== root) await directory.close();
  }
};

/** Read-only evidence for declared media bytes; does not establish source ownership or export completeness. */
export const verifyBundleFiles = async (
  root: string,
  input: ImportManifest,
): Promise<{ files: number; bytes: string }> => {
  const manifest = parseImportManifest(input);
  if (process.platform !== 'linux') refuse('BUNDLE_REQUIRES_LINUX_CONTAINER');
  try {
    const canonicalRoot = resolve(root);
    if (!isAbsolute(root) || root !== canonicalRoot) refuse('BUNDLE_ROOT_INVALID');
    const rootHandle = await openRoot(canonicalRoot);
    try {
      const rootBefore = await rootHandle.stat({ bigint: true });
      let bytes = 0n;
      for (const entry of manifest.files) {
        const path = resolve(canonicalRoot, entry.path);
        const resolved = await realpath(path);
        const remainder = relative(canonicalRoot, resolved);
        if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder))
          refuse('BUNDLE_PATH_ESCAPE');
        // Resolve contained export links, then refuse a replaced final symlink or special file at open.
        const file = await openContained(rootHandle, remainder);
        try {
          const before = await file.stat({ bigint: true });
          if (!before.isFile() || before.size !== BigInt(entry.bytes)) refuse('BUNDLE_FILE_MISMATCH');
          const hash = createHash('sha256');
          for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
          const after = await file.stat({ bigint: true });
          const currentPath = await realpath(path);
          const current = await stat(path, { bigint: true });
          if (!unchangedFile(before, after) || !unchangedFile(before, current) || currentPath !== resolved) {
            refuse('BUNDLE_CHANGED_DURING_VERIFICATION');
          }
          if (hash.digest('hex') !== entry.sha256) refuse('BUNDLE_FILE_MISMATCH');
          bytes += before.size;
        } finally {
          await file.close();
        }
      }
      if ((await realpath(root)) !== canonicalRoot || !sameIdentity(rootBefore, await stat(root, { bigint: true }))) {
        refuse('BUNDLE_CHANGED_DURING_VERIFICATION');
      }
      return { files: manifest.files.length, bytes: String(bytes) };
    } finally {
      await rootHandle.close();
    }
  } catch (error) {
    if (error instanceof BundleVerificationError) throw error;
    // Filesystem errors contain host paths; callers receive only a stable refusal code.
    throw new BundleVerificationError('BUNDLE_FILE_UNAVAILABLE');
  }
};
