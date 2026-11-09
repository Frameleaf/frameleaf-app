import glob from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import type { Dir, Dirent, Stats } from 'node:fs';
import type { WalkOptionsDto } from 'src/dtos/library.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { advanceJobProgress } from 'src/queue/context.js';
import { mimeTypes } from 'src/utils/mime-types.js';

// Node ESM requires the actual CommonJS namespace; Vite can synthesize absent named exports.
// eslint-disable-next-line import-x/no-named-as-default-member -- Native CJS exports are properties of the default namespace.
const { generateTasks, isDynamicPattern } = glob;

/** Each open directory has a fixed native buffer; no directory listing or lifetime path index. */
export const LIBRARY_WALK_BUFFER = 32;
/** Time between liveness reports, well inside the job deadline, so a tree that is slow to yield media outlives it. */
export const LIBRARY_WALK_LIVENESS_MS = 30_000;
export type LibraryWalkOptions = WalkOptionsDto & { signal?: AbortSignal };
export type LibraryWalkStorage = {
  opendir: (folder: string, options: { bufferSize: number }) => Promise<Pick<Dir, 'read' | 'close'>>;
  realpath: (file: string) => Promise<string>;
  stat: (file: string) => Promise<Pick<Stats, 'isDirectory' | 'isFile'>>;
};

/**
 * Pull-based DFS. Memory is O(roots + depth * bufferSize + take), independent of matched files
 * and directory width. Configured roots own their lexical subtrees; alias paths remain distinct
 * asset paths, as with glob's path-based uniqueness. Only active real ancestors guard link cycles.
 * Ordering is filesystem order. Missing entries are skipped; other I/O errors fail closed.
 */
export async function* walkLibraryPaths(
  options: LibraryWalkOptions,
  storage: LibraryWalkStorage = fs,
): AsyncGenerator<string[]> {
  const { signal, take, includeHidden, exclusionPatterns = [] } = options;
  if (!Number.isSafeInteger(take) || take < 1) throw new Error('Library walk batch size must be positive');
  const roots = [...new Set(options.pathsToCrawl.map((root) => path.resolve(root)))];
  // Keep explicit nested roots: their base is not filtered by glob's parent deep-filter.
  // The broad root yields ownership at each explicit child directory, so each lexical path
  // is produced by exactly one configured root without keeping a matched-path set.
  const ownedRoots = new Set(roots);
  // Production glob uses absolute roots, so ignores see absolute entry paths. Its deep filter
  // prunes only static basenames or /** subtrees, and never filters the configured root itself.
  const matcher = (pattern: string) => picomatch(pattern, { nocase: true, dot: true, posix: true });
  // Reuse the public glob planner's brace/slash/negative-ignore normalization. It expands
  // only configured patterns; no filesystem traversal or matched-path index is allocated.
  const patterns = generateTasks(['**/*'], { ignore: exclusionPatterns, caseSensitiveMatch: false }).flatMap(
    (task) => task.negative,
  );
  const ignored = patterns.map((pattern) => matcher(pattern));
  const ignoredDirectories = patterns
    .filter((pattern) => pattern.endsWith('/**') || !isDynamicPattern(path.posix.basename(pattern)))
    .map((pattern) => matcher(pattern));
  const excluded = (file: string, directory = false) =>
    (directory ? ignoredDirectories : ignored).some((match) => match(file));
  const supported = picomatch(`*{${mimeTypes.getSupportedFileExtensions().join(',')}}`, {
    nocase: true,
    dot: includeHidden,
  });
  let batch: string[] = [];
  let reportedAt = Date.now();
  for (const root of roots) {
    signal?.throwIfAborted();
    const stack: Array<{ folder: string; real: string; directory: Pick<Dir, 'read' | 'close'> }> = [];
    const ancestors = new Set<string>();
    const open = async (folder: string) => {
      signal?.throwIfAborted();
      const real = await storage.realpath(folder);
      signal?.throwIfAborted();
      if (ancestors.has(real) || StorageCore.isImmichPath(real)) return;
      const directory = await storage.opendir(folder, { bufferSize: LIBRARY_WALK_BUFFER });
      // Keep the descriptor in the stack before checking cancellation so finally always closes it.
      stack.push({ folder, real, directory });
      ancestors.add(real);
      signal?.throwIfAborted();
    };
    try {
      await open(root);
      while (stack.length > 0) {
        signal?.throwIfAborted();
        const frame = stack.at(-1)!;
        const entry: Dirent | null = await frame.directory.read();
        signal?.throwIfAborted();
        if (!entry) {
          await frame.directory.close();
          stack.pop();
          ancestors.delete(frame.real);
          continue;
        }
        // A share that stops answering sends nothing here, so the job deadline still catches a real hang.
        if (Date.now() - reportedAt >= LIBRARY_WALK_LIVENESS_MS) {
          reportedAt = Date.now();
          advanceJobProgress(1);
        }
        if (!includeHidden && entry.name.startsWith('.')) continue;
        const file = path.join(frame.folder, entry.name);
        let kind: Pick<Stats, 'isDirectory' | 'isFile'> = entry;
        if (entry.isSymbolicLink()) {
          try {
            kind = await storage.stat(file);
          } catch (error) {
            if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
            throw error;
          }
          signal?.throwIfAborted();
        }
        if (excluded(file, kind.isDirectory())) continue;
        if (kind.isDirectory()) {
          if (ownedRoots.has(file)) continue;
          try {
            await open(file);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        } else if (kind.isFile() && supported(entry.name)) {
          // File links into media storage must not become external assets, even during empty checks.
          if (entry.isSymbolicLink() && StorageCore.isImmichPath(await storage.realpath(file))) continue;
          signal?.throwIfAborted();
          batch.push(file);
          if (batch.length === take) {
            yield batch;
            batch = [];
          }
        }
      }
    } finally {
      // Includes early consumer return and abort after a pending read/open settles.
      await Promise.all(stack.map(({ directory }) => directory.close()));
    }
  }
  signal?.throwIfAborted();
  if (batch.length > 0) yield batch;
}
