import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Library Care search locations (FL-69).
 *
 * A missing or damaged original is only ever recovered from an exact copy, and the review shows
 * where each copy was found. Three kinds of location are searched:
 *
 * - `managed`: the server's own library storage (upload and library folders). A copy found here is
 *   already managed, so a missing original is relinked to it in place.
 * - `library`: an external library's import paths. External originals stay where their library
 *   keeps them, so they are only ever relinked in place, within the same library.
 * - `recovery`: a location the operator configured for recovery, such as a mounted backup
 *   (`FRAMELEAF_RECOVERY_ROOTS`). Nothing there is ever linked in place: a verified copy is
 *   published into managed storage first, and the location itself is only read.
 */
export type MediaHealthRootKind = 'managed' | 'library' | 'recovery';

export type RecoveryRootConfig = { label: string; path: string };

export type MediaHealthRoot = {
  id: string;
  kind: MediaHealthRootKind;
  label: string;
  /** Absolute, normalized directories. A managed root has one per account folder. */
  paths: string[];
};

export const MANAGED_ROOT_ID = 'managed';

export const libraryRootId = (libraryId: string) => `library:${libraryId}`;

/** A location's path without a trailing separator, so `/mnt/backup/` and `/mnt/backup` are one location. */
const normalizeRootPath = (rootPath: string) => {
  const normalized = path.normalize(rootPath);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

/**
 * A recovery root is named by its path, not its position, so reordering the configuration never
 * turns a saved choice into a different location.
 */
export const recoveryRootId = (rootPath: string) =>
  `recovery:${createHash('sha1').update(normalizeRootPath(rootPath)).digest('hex').slice(0, 12)}`;

export const rootKindOf = (rootId: string): MediaHealthRootKind | undefined => {
  if (rootId === MANAGED_ROOT_ID) {
    return 'managed';
  }
  if (rootId.startsWith('library:')) {
    return 'library';
  }
  if (rootId.startsWith('recovery:')) {
    return 'recovery';
  }
  return undefined;
};

/**
 * Parse `FRAMELEAF_RECOVERY_ROOTS`: entries separated by `;` or a newline, each either
 * `Label=/absolute/path` or just `/absolute/path` (labelled by its last folder). Relative paths,
 * the filesystem root and repeated paths are refused, so a typo fails at startup instead of
 * quietly searching somewhere unexpected.
 */
export const parseRecoveryRoots = (value?: string | null): RecoveryRootConfig[] => {
  if (!value || value.trim() === '') {
    return [];
  }

  const roots: RecoveryRootConfig[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(/[;\n]/)) {
    const entry = raw.trim();
    if (entry === '') {
      continue;
    }

    const separator = entry.indexOf('=');
    const label = separator === -1 ? '' : entry.slice(0, separator).trim();
    const rawPath = (separator === -1 ? entry : entry.slice(separator + 1)).trim();
    if (!path.isAbsolute(rawPath)) {
      throw new Error(`FRAMELEAF_RECOVERY_ROOTS: "${rawPath}" is not an absolute path`);
    }

    const normalized = path.normalize(rawPath).replace(/(.)\/+$/, '$1');
    if (normalized === path.parse(normalized).root) {
      throw new Error('FRAMELEAF_RECOVERY_ROOTS: the filesystem root cannot be a recovery location');
    }
    if (seen.has(normalized)) {
      throw new Error(`FRAMELEAF_RECOVERY_ROOTS: "${normalized}" is listed more than once`);
    }

    seen.add(normalized);
    roots.push({ label: label || path.basename(normalized), path: normalized });
  }

  return roots;
};

/** True when `candidate` is strictly inside `root`, lexically. */
export const isPathWithin = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** The root a path lies in. A path inside two roots belongs to the most specific one. */
export const rootForPath = (roots: readonly MediaHealthRoot[], candidate: string): MediaHealthRoot | undefined => {
  let best: { root: MediaHealthRoot; depth: number } | undefined;
  for (const root of roots) {
    for (const rootPath of root.paths) {
      if (!isPathWithin(rootPath, candidate)) {
        continue;
      }

      const depth = rootPath.split(path.sep).length;
      if (!best || depth > best.depth) {
        best = { root, depth };
      }
    }
  }
  return best?.root;
};

/**
 * The real location of a candidate, or undefined when it has escaped its root.
 *
 * The directory walk already skips symbolic links, but a candidate is read again much later, when
 * it is recovered, and anything may have changed on disk in between. So the candidate must still be
 * a regular file that is not itself a link, and its resolved path must still be inside the resolved
 * root: a link planted in a parent directory cannot point a recovery at a file outside it.
 */
export const resolveInsideRoot = async (rootPath: string, candidate: string): Promise<string | undefined> => {
  try {
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return undefined;
    }

    const [realRoot, realCandidate] = await Promise.all([realpath(rootPath), realpath(candidate)]);
    return isPathWithin(realRoot, realCandidate) ? realCandidate : undefined;
  } catch {
    return undefined;
  }
};

export type FileDigests = { sha1: Buffer; sha256: Buffer; sizeInBytes: number };

/**
 * Publish a copy of `source` at `destination` without ever replacing a file that is already there.
 *
 * The bytes are written to a private temporary name, flushed, and then hard-linked into place:
 * `link` fails rather than overwrites, so a published file is either complete or absent, and an
 * original can never be overwritten by a recovery. A destination that already exists (a retried
 * batch) is accepted only when its content is exactly what was expected. The result is verified by
 * reading the published file back, not by trusting the copy.
 */
export const publishVerifiedCopy = async (input: {
  source: string;
  destination: string;
  expected: FileDigests;
  hash: (filePath: string) => Promise<FileDigests>;
}): Promise<FileDigests> => {
  const { source, destination, expected, hash } = input;
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.partial`;
  const matches = (digests: FileDigests) =>
    digests.sha1.equals(expected.sha1) &&
    digests.sha256.equals(expected.sha256) &&
    digests.sizeInBytes === expected.sizeInBytes;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    const file = await open(temporary, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }

    // A source that changed since it was verified is never published: the name stays free for a
    // later attempt instead of holding the wrong bytes.
    if (!matches(await hash(temporary))) {
      throw new Error('The copied file does not match the verified original');
    }

    try {
      await link(temporary, destination);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }
    }

    const directory = await open(path.dirname(destination), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }

  const published = await hash(destination);
  if (!matches(published)) {
    throw new Error('The published copy does not match the verified original');
  }

  return published;
};

const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;

/**
 * Move a file to a new name without ever replacing anything (FL-69).
 *
 * The new name is hard-linked first, which fails rather than overwrites, and the old name is only
 * removed once the new one holds the same file. Across filesystems the bytes are copied to the new
 * name exclusively and flushed before the old name is removed. A repeat after an interruption finds
 * both names on the same file and just removes the old one; a different file already at the new name
 * is an error and nothing is changed.
 */
export const retainFile = async (source: string, destination: string): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await link(source, destination);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EXDEV') {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      const file = await open(destination, 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    } else if (code === 'EEXIST') {
      const [from, to] = await Promise.all([lstat(source), lstat(destination)]);
      if (from.ino !== to.ino || from.dev !== to.dev) {
        throw new Error(`${destination} already holds a different file`, { cause: error });
      }
    } else {
      throw error;
    }
  }

  const directory = await open(path.dirname(destination), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  await unlink(source);
};
