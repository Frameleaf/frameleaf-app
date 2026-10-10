import { createHash } from 'node:crypto';
import { BigIntStats, constants } from 'node:fs';
import { FileHandle, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ImportMediaPolicy, ImportRefused, MediaRootMap } from 'src/immich-import/types.js';

const beneath = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
export const mapMediaPath = (
  path: string,
  roots: MediaRootMap[],
  policy?: ImportMediaPolicy,
): { source: string; target: string; root: MediaRootMap } => {
  assertMediaPolicy(roots, policy);
  if (!isAbsolute(path) || path !== resolve(path)) {
    throw new ImportRefused('UNSAFE_MEDIA_PATH');
  }
  const matches = roots.filter(
    (root) => isAbsolute(root.source) && isAbsolute(root.target) && beneath(resolve(root.source), path),
  );
  // Docker resolves a nested mount before its parent. Keep that boundary for containment checks.
  const longestRoot = Math.max(0, ...matches.map((root) => root.source.length));
  const selected =
    policy?.mode === 'manager-in-place' ? matches.filter((root) => root.source.length === longestRoot) : matches;
  if (selected.length !== 1) {
    throw new ImportRefused('AMBIGUOUS_OR_UNMAPPED_MEDIA_ROOT');
  }
  const root = selected[0];
  const target = resolve(root.target, relative(root.source, path));
  if (!beneath(resolve(root.target), target)) {
    throw new ImportRefused('MEDIA_ROOT_ESCAPE');
  }
  return { source: path, target, root };
};

/** Manager identity is an orchestration contract, not a substitute for fencing or filesystem checks. */
export const assertMediaPolicy = (roots: MediaRootMap[], policy?: ImportMediaPolicy): void => {
  if (!policy || policy.mode === 'independent-copy') return;
  if (
    policy.mode !== 'manager-in-place' ||
    policy.authority !== 'frameleaf-manager' ||
    typeof policy.operationId !== 'string' ||
    !policy.operationId.trim() ||
    typeof policy.deploymentId !== 'string' ||
    !policy.deploymentId.trim()
  ) {
    throw new ImportRefused('INVALID_MANAGER_MEDIA_AUTHORITY');
  }
  if (
    roots.some(
      (root) => !isAbsolute(root.source) || root.source !== resolve(root.source) || root.target !== root.source,
    )
  ) {
    throw new ImportRefused('MANAGER_MEDIA_LOCATIONS_MUST_BE_UNCHANGED');
  }
  if (new Set(roots.map((root) => root.target)).size !== roots.length) {
    throw new ImportRefused('AMBIGUOUS_OR_UNMAPPED_MEDIA_ROOT');
  }
};

/** Empty libraries need the same recovery-copy boundary as libraries with current media files. */
export const verifyMediaRoots = async (roots: MediaRootMap[], policy?: ImportMediaPolicy): Promise<void> => {
  assertMediaPolicy(roots, policy);
  if (policy?.mode === 'manager-in-place') return;
  if (
    roots.length === 0 ||
    roots.some((root) => [root.source, root.target].some((path) => !isAbsolute(path) || path !== resolve(path)))
  ) {
    throw new ImportRefused('UNSAFE_MEDIA_ROOT');
  }
  const resolved = await Promise.all(
    roots.map(async (root) => ({ source: await realpath(root.source), target: await realpath(root.target) })),
  );
  for (const root of resolved) {
    if (!(await stat(root.source)).isDirectory() || !(await stat(root.target)).isDirectory()) {
      throw new ImportRefused('MEDIA_ROOT_MUST_BE_DIRECTORY');
    }
    if (resolved.some((other) => beneath(other.source, root.target) || beneath(root.target, other.source))) {
      throw new ImportRefused('DESTINATION_MEDIA_MUST_BE_INDEPENDENT_COPY');
    }
  }
  // Overlapping source maps are ambiguous; overlapping destinations can alias future library files.
  for (const maps of [roots, resolved]) {
    if (
      maps.some((root, index) =>
        maps.some(
          (other, otherIndex) =>
            index !== otherIndex && (beneath(root.source, other.source) || beneath(root.target, other.target)),
        ),
      )
    ) {
      throw new ImportRefused('AMBIGUOUS_OR_UNMAPPED_MEDIA_ROOT');
    }
  }
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

/** Opens and hashes are read-only in both independent-copy and Manager in-place modes. */
export const verifyMediaFile = async (
  path: string,
  roots: MediaRootMap[],
  checksum?: string,
  algorithm?: string,
  policy?: ImportMediaPolicy,
  onVerified?: (sha256: string) => void,
): Promise<string> => {
  await verifyMediaRoots(roots, policy);
  const inPlace = policy?.mode === 'manager-in-place';
  const mapping = mapMediaPath(path, roots, policy);
  if (inPlace) {
    // Preserve the existing per-file Manager check that every declared mount resolves.
    await Promise.all(roots.flatMap((root) => [realpath(root.source), realpath(root.target)]));
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
      if (inPlace && (source !== target || !sameFile(before, targetBefore))) {
        throw new ImportRefused('MANAGER_MEDIA_LOCATIONS_MUST_BE_UNCHANGED');
      }
      if (!inPlace && (source === target || sameFile(before, targetBefore) || targetBefore.nlink !== 1n)) {
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
      onVerified?.(sourceDigest.sha256);
      return mapping.target;
    } finally {
      await targetFile.close();
    }
  } finally {
    await sourceFile.close();
  }
};
