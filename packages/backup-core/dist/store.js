import { link, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
export class ObjectExistsError extends Error {
    key;
    name = 'ObjectExistsError';
    constructor(key) {
        super(`This object is already stored: ${key}`);
        this.key = key;
    }
}
const slice = (body, range) => !range
    ? body
    : 'suffix' in range
        ? body.subarray(Math.max(0, body.length - range.suffix))
        : body.subarray(range.start, range.end);
export function memoryStore() {
    const objects = new Map();
    const written = new Map();
    return {
        objects,
        async put(key, body) {
            if (objects.has(key)) {
                throw new ObjectExistsError(key);
            }
            objects.set(key, Buffer.from(body));
            written.set(key, new Date());
            return { versionId: null };
        },
        async get(key, range) {
            const body = objects.get(key);
            if (!body) {
                throw new Error(`No such object: ${key}`);
            }
            return Buffer.from(slice(body, range));
        },
        async list(prefix) {
            return [...objects]
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, body]) => ({ key, size: body.length, modified: written.get(key) ?? new Date(0) }));
        },
        async delete(key) {
            objects.delete(key);
        },
    };
}
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
export function dirStore(root) {
    const path = (key) => {
        if (!/^[\w-]+(\/[\w-]+)*$/.test(key)) {
            throw new Error(`Not a repository object name: ${key}`);
        }
        return join(root, ...key.split('/'));
    };
    return {
        async put(key, body) {
            const target = path(key);
            await mkdir(dirname(target), { recursive: true });
            const temporary = `${target}.${randomBytes(6).toString('hex')}.part`;
            try {
                const file = await open(temporary, 'wx', 0o600);
                try {
                    await file.writeFile(body);
                    await file.sync();
                }
                finally {
                    await file.close();
                }
                await link(temporary, target).catch(async (error) => {
                    if (error.code === 'EEXIST') {
                        throw new ObjectExistsError(key);
                    }
                    if (!NO_LINKS.has(error.code ?? '')) {
                        throw error;
                    }
                    const taken = await stat(target).catch((failure) => {
                        if (failure.code === 'ENOENT') {
                            return null;
                        }
                        throw failure;
                    });
                    if (taken) {
                        throw new ObjectExistsError(key);
                    }
                    await rename(temporary, target);
                });
            }
            finally {
                await rm(temporary, { force: true });
            }
            const folder = await open(dirname(target), 'r').catch(() => null);
            await folder?.sync().catch(() => undefined);
            await folder?.close();
            return { versionId: null };
        },
        async get(key, range) {
            const file = await open(path(key), 'r');
            try {
                const { size } = await file.stat();
                const start = !range ? 0 : 'suffix' in range ? Math.max(0, size - range.suffix) : range.start;
                const end = !range || 'suffix' in range ? size : Math.min(size, range.end);
                const buffer = Buffer.alloc(Math.max(0, end - start));
                await file.read(buffer, 0, buffer.length, start);
                return buffer;
            }
            finally {
                await file.close();
            }
        },
        async list(prefix) {
            const missing = (error) => {
                if (error.code === 'ENOENT') {
                    return null;
                }
                throw error;
            };
            if (!(await stat(root).catch(missing))) {
                return [];
            }
            const names = await readdir(root, { recursive: true });
            const found = [];
            for (const name of names) {
                const key = name.split(sep).join('/');
                if (!key.startsWith(prefix) || key.endsWith('.part')) {
                    continue;
                }
                const info = await stat(join(root, name));
                if (info.isFile()) {
                    found.push({ key, size: info.size, modified: info.mtime });
                }
            }
            return found;
        },
        async delete(key) {
            await rm(path(key), { force: true });
        },
    };
}
