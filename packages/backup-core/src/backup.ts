import { chunkStream } from './chunker.js';
import { blobId } from './keys.js';
import { PackWriter, type Repository, type Snapshot } from './repository.js';
import { type Entry, type Source, type SourceEntry, encodeTree, fileChunks, readTree } from './tree.js';

/** A file's chunk ids sit in its folder's tree up to this many; beyond it they move into list blobs. */
const INLINE_CHUNKS = 1024;
const LIST_CHUNKS = 32_768;

export interface BackupProblem {
  path: string[];
  message: string;
}

export interface BackupResult {
  key: string;
  snapshot: Snapshot;
  /** For the signed receipt Cloud keeps: the hash of the snapshot object as stored. */
  ciphertextSha256: string;
  /** Files that could not be read, or changed while they were read. The backup still finishes. */
  problems: BackupProblem[];
  /** Files taken from the previous backup without being read again. */
  unchanged: number;
}

export interface BackupOptions {
  time?: Date;
  /** Bytes per pack. Tests make it small. */
  packTarget?: number;
  /** Stops the run, for a window that closes or a user who presses Stop. What was stored is kept for the next run. */
  signal?: AbortSignal;
}

/** The source could not give a file's content. */
class SourceError extends Error {}

async function* guarded(stream: AsyncIterable<Uint8Array>) {
  try {
    for await (const part of stream) {
      yield part;
    }
  } catch (error) {
    throw new SourceError(error instanceof Error ? error.message : String(error));
  }
}

const same = (before: Entry, now: SourceEntry) =>
  before.type === 'file' &&
  (before.key !== undefined && now.key !== undefined
    ? before.key === now.key
    : before.size === now.size && before.mtime === now.mtime);

/**
 * Backs up everything `source` offers as one new snapshot.
 * Order matters for safety: packs first, then the index, then the snapshot. A run that stops early
 * leaves packs nobody points at, which the next run adopts; it never leaves a snapshot pointing at
 * something missing.
 */
export async function backup(
  repository: Repository,
  source: Source,
  options: BackupOptions = {},
): Promise<BackupResult> {
  await repository.loadIndex();
  const data = new PackWriter(repository, options.packTarget);
  const trees = new PackWriter(repository, options.packTarget);
  const problems: BackupProblem[] = [];
  const stats = { files: 0, folders: 0, bytes: 0, storedBytes: 0 };
  let unchanged = 0;

  const parentKey = (await repository.listSnapshots()).at(-1)?.key ?? null;
  const parent = parentKey ? await repository.readSnapshot(parentKey) : null;

  const store = async (writer: PackWriter, plain: Buffer) => {
    const id = blobId(repository.keys, plain);
    await writer.add(id, plain);
    return id.toString('hex');
  };

  const readFile = async (path: string[]) => {
    const ids: string[] = [];
    let bytes = 0;
    for await (const chunk of chunkStream(guarded(source.read(path)), repository.config.chunker, repository.gear)) {
      options.signal?.throwIfAborted();
      ids.push(await store(data, chunk));
      bytes += chunk.length;
    }
    return { ids, bytes };
  };

  const file = async (path: string[], now: SourceEntry, before: Entry | undefined): Promise<Entry | null> => {
    const { size: _, ...rest } = now;
    if (before && same(before, now)) {
      const ids = await fileChunks(repository, before).catch(() => null);
      // Reuse only what storage really holds; anything else is read again.
      if (ids?.every((id) => repository.index.has(id))) {
        unchanged++;
        return {
          ...rest,
          size: before.size,
          ...(before.lists ? { lists: before.lists } : { chunks: before.chunks ?? [] }),
        };
      }
    }
    let read: Awaited<ReturnType<typeof readFile>>;
    try {
      read = await readFile(path);
      // A file that grew or shrank while it was read is read once more, then kept as read.
      if (read.bytes !== now.size) {
        read = await readFile(path);
        if (read.bytes !== now.size) {
          problems.push({ path, message: 'This file changed while it was being backed up' });
        }
      }
    } catch (error) {
      // Only a file that can't be read is skipped. A storage failure or a stop ends the run.
      if (!(error instanceof SourceError)) {
        throw error;
      }
      problems.push({ path, message: error.message });
      return null;
    }
    if (read.ids.length <= INLINE_CHUNKS) {
      return { ...rest, size: read.bytes, chunks: read.ids };
    }
    const lists: string[] = [];
    for (let at = 0; at < read.ids.length; at += LIST_CHUNKS) {
      lists.push(await store(trees, Buffer.from(read.ids.slice(at, at + LIST_CHUNKS).join(''), 'hex')));
    }
    return { ...rest, size: read.bytes, lists };
  };

  const folder = async (path: string[], beforeTree: string | undefined): Promise<string> => {
    const before = new Map<string, Entry>();
    if (beforeTree) {
      for (const entry of await readTree(repository, beforeTree).catch(() => [])) {
        before.set(entry.name, entry);
      }
    }
    const entries: Entry[] = [];
    let listed: SourceEntry[] = [];
    try {
      listed = await source.list(path);
    } catch (error) {
      problems.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
    for (const now of listed) {
      const child = [...path, now.name];
      const earlier = before.get(now.name);
      if (now.type === 'dir') {
        const { size: _, ...rest } = now;
        entries.push({
          ...rest,
          size: 0,
          tree: await folder(child, earlier?.type === 'dir' ? earlier.tree : undefined),
        });
        stats.folders++;
      } else if (now.type === 'symlink') {
        entries.push({ ...now, size: 0 });
      } else {
        const stored = await file(child, now, earlier);
        if (stored) {
          entries.push(stored);
          stats.files++;
          stats.bytes += stored.size;
        }
      }
    }
    return store(trees, encodeTree(entries));
  };

  let tree: string;
  try {
    tree = await folder([], parent?.tree);
  } catch (error) {
    // A stopped run keeps what it has: the next run adopts these packs and sends none of it again.
    if (options.signal?.aborted) {
      await data.flush();
    }
    throw error;
  }
  await data.flush();
  await trees.flush();
  await repository.writeIndex([...data.written, ...trees.written]);
  stats.storedBytes = data.storedBytes + trees.storedBytes;
  const written = await repository.writeSnapshot({
    time: (options.time ?? new Date()).toISOString(),
    tree,
    parent: parentKey,
    stats,
  });
  return { ...written, problems, unchanged };
}
