import { dirname } from 'node:path';
import type { CryptoRepository } from 'src/repositories/crypto.repository.js';
import type { StorageRepository } from 'src/repositories/storage.repository.js';
import { retainFile } from 'src/utils/media-health-roots.js';

/**
 * Moves a file into or out of the universal storage file trash without ever replacing a file already at
 * the destination (FL-1333): it is linked, or copied across filesystems, and the source is removed only
 * once the destination holds the same bytes. Rejects with ENOENT when the source is gone.
 */
export const moveFileWithin = async (storage: StorageRepository, from: string, to: string): Promise<void> => {
  storage.mkdirSync(dirname(to));
  await retainFile(from, to);
};

/** What identifies a file on disk without reading it: the same file, unchanged, keeps the same key. */
export const fileIdentity = async (
  storage: Pick<StorageRepository, 'stat'>,
  path: string,
): Promise<{ key: string; size: number } | null> => {
  try {
    const stats = await storage.stat(path);
    return stats.isFile()
      ? { key: [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(':'), size: stats.size }
      : null;
  } catch {
    return null;
  }
};

/**
 * FL-412: proves the file at `path` holds exactly the expected bytes before another copy of them is let
 * go: the same size, and the same digest in the checksum's own algorithm (SHA-256; SHA-1 only for an
 * older record), read while the file did not change. Returns the file's identity, so a caller can check
 * under its locks that it is still that file without reading it again; null when the file is gone,
 * unreadable, changed while it was read, or holds other bytes.
 */
export const verifyStoredCopy = async (
  storage: Pick<StorageRepository, 'stat'>,
  crypto: Pick<CryptoRepository, 'hashFileMatching'>,
  path: string,
  expected: { checksum: Buffer; sizeInBytes: number },
): Promise<string | null> => {
  const before = await fileIdentity(storage, path);
  if (!before || before.size !== expected.sizeInBytes) {
    return null;
  }
  let digest: Buffer;
  try {
    digest = await crypto.hashFileMatching(path, expected.checksum);
  } catch {
    return null;
  }
  const after = await fileIdentity(storage, path);
  return after?.key === before.key && digest.equals(expected.checksum) ? before.key : null;
};

/**
 * The checks `PhysicalFileRepository.linkUploadedOriginal` makes before an existing file takes the place of
 * a new copy (FL-412). `onMismatch` hears of a file that is there but does not hold the expected bytes.
 */
export const storedCopyChecks = (
  storage: Pick<StorageRepository, 'stat'>,
  crypto: Pick<CryptoRepository, 'hashFileMatching'>,
  expected: { checksum: Buffer; sizeInBytes: number },
  onMismatch: (path: string) => void,
) => ({
  verify: async (path: string) => {
    const identity = await verifyStoredCopy(storage, crypto, path, expected);
    if (!identity && (await fileIdentity(storage, path))) {
      onMismatch(path);
    }
    return identity;
  },
  identify: async (path: string) => (await fileIdentity(storage, path))?.key ?? null,
});
