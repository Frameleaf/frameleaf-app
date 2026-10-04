import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ImportRefused, MediaRootMap } from './types.js';

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
const fileDigest = async (path: string, algorithm = 'sha256'): Promise<string> => {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
};
export const verifyMediaFile = async (
  path: string,
  roots: MediaRootMap[],
  checksum?: string,
  algorithm?: string,
): Promise<string> => {
  const mapping = mapMediaPath(path, roots);
  const [source, target, sourceRoot, targetRoot] = await Promise.all([
    realpath(mapping.source),
    realpath(mapping.target),
    realpath(mapping.root.source),
    realpath(mapping.root.target),
  ]);
  if (!beneath(sourceRoot, source) || !beneath(targetRoot, target)) {
    throw new ImportRefused('MEDIA_SYMLINK_ESCAPE');
  }
  const [before, targetBefore] = await Promise.all([stat(source), stat(target)]);
  if (!before.isFile() || !targetBefore.isFile() || before.size !== targetBefore.size) {
    throw new ImportRefused('MEDIA_FILE_MISMATCH');
  }
  const sourceDigest = await fileDigest(source);
  const targetDigest = await fileDigest(target);
  const [after, targetAfter] = await Promise.all([stat(source), stat(target)]);
  if (
    sourceDigest !== targetDigest ||
    before.mtimeMs !== after.mtimeMs ||
    before.size !== after.size ||
    targetBefore.mtimeMs !== targetAfter.mtimeMs ||
    targetBefore.size !== targetAfter.size
  ) {
    throw new ImportRefused('MEDIA_CHANGED_OR_MISMATCHED');
  }
  if (checksum) {
    const expected = checksum.replace(/^\\x/u, '');
    const checksumAlgorithm = algorithm === 'sha256' ? 'sha256' : algorithm === 'sha1' ? 'sha1' : undefined;
    const actual =
      algorithm === 'sha1-path'
        ? createHash('sha1').update(`path:${path}`).digest('hex')
        : checksumAlgorithm
          ? await fileDigest(source, checksumAlgorithm)
          : null;
    if (actual !== expected) {
      throw new ImportRefused('ORIGINAL_CHECKSUM_MISMATCH');
    }
  }
  return mapping.target;
};
