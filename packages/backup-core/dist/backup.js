import { chunkStream } from './chunker.js';
import { blobId } from './keys.js';
import { PackWriter } from './repository.js';
import { encodeTree, fileChunks, readTree } from './tree.js';
const INLINE_CHUNKS = 1024;
const LIST_CHUNKS = 32_768;
class SourceError extends Error {
}
async function* guarded(stream) {
    try {
        for await (const part of stream) {
            yield part;
        }
    }
    catch (error) {
        throw new SourceError(error instanceof Error ? error.message : String(error));
    }
}
const same = (before, now) => before.type === 'file' &&
    (before.key !== undefined && now.key !== undefined
        ? before.key === now.key
        : before.size === now.size && before.mtime === now.mtime);
export async function backup(repository, source, options = {}) {
    await repository.loadIndex();
    const data = new PackWriter(repository, options.packTarget);
    const trees = new PackWriter(repository, options.packTarget);
    const problems = [];
    const stats = { files: 0, folders: 0, bytes: 0, storedBytes: 0 };
    let unchanged = 0;
    const parentKey = (await repository.listSnapshots()).at(-1)?.key ?? null;
    const parent = parentKey ? await repository.readSnapshot(parentKey) : null;
    const store = async (writer, plain) => {
        const id = blobId(repository.keys, plain);
        await writer.add(id, plain);
        return id.toString('hex');
    };
    const report = (reading = 0) => options.onProgress?.({ files: stats.files, bytes: stats.bytes + reading, storedBytes: data.storedBytes });
    const readFile = async (path) => {
        const ids = [];
        let bytes = 0;
        for await (const chunk of chunkStream(guarded(source.read(path)), repository.config.chunker, repository.gear)) {
            options.signal?.throwIfAborted();
            ids.push(await store(data, chunk));
            bytes += chunk.length;
            report(bytes);
        }
        return { ids, bytes };
    };
    const file = async (path, now, before) => {
        const { size: _, ...rest } = now;
        if (before && same(before, now)) {
            const ids = await fileChunks(repository, before).catch(() => null);
            if (ids?.every((id) => repository.index.has(id))) {
                unchanged++;
                return {
                    ...rest,
                    size: before.size,
                    ...(before.lists ? { lists: before.lists } : { chunks: before.chunks ?? [] }),
                };
            }
        }
        let read;
        try {
            read = await readFile(path);
            if (read.bytes !== now.size) {
                read = await readFile(path);
                if (read.bytes !== now.size) {
                    problems.push({ path, message: 'This file changed while it was being backed up' });
                }
            }
        }
        catch (error) {
            if (!(error instanceof SourceError)) {
                throw error;
            }
            problems.push({ path, message: error.message });
            return null;
        }
        if (read.ids.length <= INLINE_CHUNKS) {
            return { ...rest, size: read.bytes, chunks: read.ids };
        }
        const lists = [];
        for (let at = 0; at < read.ids.length; at += LIST_CHUNKS) {
            lists.push(await store(trees, Buffer.from(read.ids.slice(at, at + LIST_CHUNKS).join(''), 'hex')));
        }
        return { ...rest, size: read.bytes, lists };
    };
    const folder = async (path, beforeTree) => {
        const before = new Map();
        if (beforeTree) {
            for (const entry of await readTree(repository, beforeTree).catch(() => [])) {
                before.set(entry.name, entry);
            }
        }
        const entries = [];
        let listed = [];
        try {
            listed = await source.list(path);
        }
        catch (error) {
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
            }
            else if (now.type === 'symlink') {
                entries.push({ ...now, size: 0 });
            }
            else {
                const stored = await file(child, now, earlier);
                if (stored) {
                    entries.push(stored);
                    stats.files++;
                    stats.bytes += stored.size;
                    report();
                }
            }
        }
        return store(trees, encodeTree(entries));
    };
    let tree;
    try {
        tree = await folder([], parent?.tree);
    }
    catch (error) {
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
