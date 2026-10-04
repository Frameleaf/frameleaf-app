import { createHash } from 'node:crypto';
import { BigIntStats, constants } from 'node:fs';
import { FileHandle, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ImportRefused, MediaRootMap } from 'src/immich-import/types.js';

const beneath = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
export const mapMediaPath = (
  path: string,
  roots: MediaRootMap[],
): { source: string; target: string; root: MediaRootMap } => {
  if (!isAbsolute(path) || path !== resolve(path)) {
    throw new ImportRefused('UNSAFE_MEDIA_PATH');
  }
  const matches = roots.filter(
    (root) => isAbsolute(root.source) && isAbsolute(root.target) && beneath(resolve(root.source), path),
  );
  if (matches.length !== 1) {
    throw new ImportRefused('AMBIGUOUS_OR_UNMAPPED_MEDIA_ROOT');
  }
  const root = matches[0];
  const target = resolve(root.target, relative(root.source, path));
  if (!beneath(resolve(root.target), target)) {
    throw new ImportRefused('MEDIA_ROOT_ESCAPE');
  }
  return { source: path, target, root };
};

export const pathChecksum = (path: string): string => createHash('sha1').update(`path:${path}`).digest('hex');
const sameFile = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino;
const unchanged = (before: BigIntStats, after: BigIntStats): boolean =>
  sameFile(before, after) &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs &&
  before.nlink === after.nlink;
const fileDigests = async (file: FileHandle): Promise<{ sha1: string; sha256: string }> => {
  const sha1 = createHash('sha1');
  const sha256 = createHash('sha256');
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
    sha1.update(chunk);
    sha256.update(chunk);
  }
  return { sha1: sha1.digest('hex'), sha256: sha256.digest('hex') };
};

/** Only independently copied destination files can become managed originals. Opens and hashes are read-only. */
export const verifyMediaFile = async (
  path: string,
  roots: MediaRootMap[],
  checksum?: string,
  algorithm?: string,
): Promise<string> => {
  const mapping = mapMediaPath(path, roots);
  const resolvedRoots = await Promise.all(
    roots.map(async (root) => ({
      source: await realpath(root.source),
      target: await realpath(root.target),
    })),
  );
  // Check every map, including aliases between different maps. Nested roots also allow later storage
  // operations to enter the source tree, even when this particular file is a distinct inode.
  if (
    resolvedRoots.some((target) =>
      resolvedRoots.some((source) => beneath(source.source, target.target) || beneath(target.target, source.source)),
    )
  ) {
    throw new ImportRefused('DESTINATION_MEDIA_MUST_BE_INDEPENDENT_COPY');
  }
  const [source, target, sourceRoot, targetRoot] = await Promise.all([
    realpath(mapping.source),
    realpath(mapping.target),
    realpath(mapping.root.source),
    realpath(mapping.root.target),
  ]);
  if (!beneath(sourceRoot, source) || !beneath(targetRoot, target)) {
    throw new ImportRefused('MEDIA_SYMLINK_ESCAPE');
  }
  const sourceFile = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const targetFile = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const [before, targetBefore] = await Promise.all([
        sourceFile.stat({ bigint: true }),
        targetFile.stat({ bigint: true }),
      ]);
      if (source === target || sameFile(before, targetBefore) || targetBefore.nlink !== 1n) {
        throw new ImportRefused('DESTINATION_MEDIA_MUST_BE_INDEPENDENT_COPY');
      }
      if (!before.isFile() || !targetBefore.isFile() || before.size !== targetBefore.size) {
        throw new ImportRefused('MEDIA_FILE_MISMATCH');
      }
      const [sourceDigest, targetDigest] = await Promise.all([fileDigests(sourceFile), fileDigests(targetFile)]);
      const [after, targetAfter, sourcePathAfter, targetPathAfter, sourceResolvedAfter, targetResolvedAfter] =
        await Promise.all([
          sourceFile.stat({ bigint: true }),
          targetFile.stat({ bigint: true }),
          stat(mapping.source, { bigint: true }),
          stat(mapping.target, { bigint: true }),
          realpath(mapping.source),
          realpath(mapping.target),
        ]);
      if (
        sourceDigest.sha256 !== targetDigest.sha256 ||
        !unchanged(before, after) ||
        !unchanged(targetBefore, targetAfter) ||
        !unchanged(before, sourcePathAfter) ||
        !unchanged(targetBefore, targetPathAfter) ||
        sourceResolvedAfter !== source ||
        targetResolvedAfter !== target
      ) {
        throw new ImportRefused('MEDIA_CHANGED_OR_MISMATCHED');
      }
      if (checksum) {
        const actual =
          algorithm === 'sha1-path'
            ? pathChecksum(path)
            : algorithm === 'sha1'
              ? sourceDigest.sha1
              : algorithm === 'sha256'
                ? sourceDigest.sha256
                : null;
        if (actual !== checksum.replace(/^\\x/u, '')) {
          throw new ImportRefused('ORIGINAL_CHECKSUM_MISMATCH');
        }
      }
      return mapping.target;
    } finally {
      await targetFile.close();
    }
  } finally {
    await sourceFile.close();
  }
};
