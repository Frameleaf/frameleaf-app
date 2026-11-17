import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
export const safeName = (name) => name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
export const encodeTree = (entries) => Buffer.from(JSON.stringify({ v: 1, entries: entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }));
export async function readTree(repository, id) {
    return JSON.parse((await repository.readBlob(id)).toString()).entries;
}
export async function fileChunks(repository, entry) {
    if (!entry.lists) {
        return entry.chunks ?? [];
    }
    const ids = [];
    for (const list of entry.lists) {
        const data = await repository.readBlob(list);
        for (let at = 0; at < data.length; at += 32) {
            ids.push(data.toString('hex', at, at + 32));
        }
    }
    return ids;
}
export function fsSource(root) {
    return {
        async list(path) {
            const folder = join(root, ...path);
            const entries = [];
            for (const name of await readdir(folder)) {
                const info = await lstat(join(folder, name)).catch((error) => {
                    if (error.code === 'ENOENT') {
                        return null;
                    }
                    throw error;
                });
                if (!info) {
                    continue;
                }
                const type = info.isFile()
                    ? 'file'
                    : info.isDirectory()
                        ? 'dir'
                        : info.isSymbolicLink()
                            ? 'symlink'
                            : null;
                if (!type) {
                    continue;
                }
                entries.push({
                    name,
                    type,
                    mode: info.mode & 0o7777,
                    uid: info.uid,
                    gid: info.gid,
                    mtime: Math.floor(info.mtimeMs),
                    size: type === 'file' ? info.size : 0,
                    ...(type === 'symlink' ? { target: await readlink(join(folder, name)) } : {}),
                    ...(type === 'file'
                        ? { key: `${info.ino}:${info.size}:${Math.floor(info.mtimeMs)}:${Math.floor(info.ctimeMs)}` }
                        : {}),
                });
            }
            return entries;
        },
        read(path) {
            return createReadStream(join(root, ...path), { highWaterMark: 1024 * 1024 });
        },
    };
}
const virtualFolder = (name) => ({
    name,
    type: 'dir',
    mode: 0o755,
    uid: 0,
    gid: 0,
    mtime: 0,
    size: 0,
});
const startsWith = (path, start) => start.every((name, index) => path[index] === name);
export function mountSource(mounts) {
    for (const [index, mount] of mounts.entries()) {
        if (mount.path.length === 0 && mounts.length > 1) {
            throw new Error('A source at the top leaves no room for others');
        }
        if (mounts.some((other, at) => at !== index && startsWith(other.path, mount.path))) {
            throw new Error('One chosen folder is inside another');
        }
    }
    const owner = (path) => mounts.find((mount) => startsWith(path, mount.path));
    return {
        async list(path) {
            const mount = owner(path);
            if (mount) {
                return mount.source.list(path.slice(mount.path.length));
            }
            const names = new Set(mounts.filter((item) => startsWith(item.path, path)).map((item) => item.path[path.length]));
            return [...names].map((name) => virtualFolder(name));
        },
        read(path) {
            const mount = owner(path);
            if (!mount) {
                throw new Error('No such file');
            }
            return mount.source.read(path.slice(mount.path.length));
        },
    };
}
export function filterSource(source, skip) {
    return {
        list: async (path) => (await source.list(path)).filter((entry) => !skip([...path, entry.name], entry)),
        read: (path) => source.read(path),
    };
}
export async function measureSource(source, path = []) {
    const total = { files: 0, bytes: 0 };
    for (const entry of await source.list(path).catch(() => [])) {
        if (entry.type === 'dir') {
            const inside = await measureSource(source, [...path, entry.name]);
            total.files += inside.files;
            total.bytes += inside.bytes;
        }
        else if (entry.type === 'file') {
            total.files++;
            total.bytes += entry.size;
        }
    }
    return total;
}
