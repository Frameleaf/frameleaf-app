import { chmod, chown, lstat, mkdir, open, rename, rm, symlink, utimes } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileChunks, readTree, safeName } from './tree.js';
const stamp = (milliseconds) => String((milliseconds + 0.5) / 1000);
export async function find(repository, snapshot, path) {
    let tree = snapshot.tree;
    let found = {
        name: '',
        type: 'dir',
        mode: 0o755,
        uid: 0,
        gid: 0,
        mtime: Date.parse(snapshot.time),
        size: 0,
        tree,
    };
    for (const name of path) {
        if (found.type !== 'dir' || !found.tree) {
            return null;
        }
        const next = (await readTree(repository, tree)).find((entry) => entry.name === name);
        if (!next) {
            return null;
        }
        found = next;
        tree = next.tree ?? '';
    }
    return found;
}
export async function listFolder(repository, snapshot, path) {
    const folder = await find(repository, snapshot, path);
    if (folder?.type !== 'dir' || !folder.tree) {
        throw new Error('No such folder in this backup');
    }
    return readTree(repository, folder.tree);
}
export async function* readFile(repository, entry) {
    for (const id of await fileChunks(repository, entry)) {
        yield await repository.readBlob(id);
    }
}
export async function restore(repository, snapshot, path, target, options = {}) {
    const started = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const aside = options.aside ?? ((existing) => `${existing}.before-restore-${started}`);
    const result = { files: 0, bytes: 0, movedAside: [] };
    let written = 0;
    const start = await find(repository, snapshot, path);
    if (!start) {
        throw new Error('No such file or folder in this backup');
    }
    const clear = async (place) => {
        if (await lstat(place).catch(() => null)) {
            const wanted = aside(place);
            let to = wanted;
            for (let attempt = 2; await lstat(to).catch(() => null); attempt++) {
                to = `${wanted}-${attempt}`;
            }
            await rename(place, to);
            result.movedAside.push({ from: place, to });
        }
    };
    const own = (place, entry) => chown(place, entry.uid, entry.gid).catch(() => undefined);
    const put = async (entry, place) => {
        if (entry.type === 'dir') {
            const existing = await lstat(place).catch(() => null);
            if (existing && !existing.isDirectory()) {
                await clear(place);
            }
            const made = !existing?.isDirectory();
            if (made) {
                await mkdir(place, { mode: 0o700 });
                await chmod(place, 0o700);
            }
            for (const child of entry.tree ? await readTree(repository, entry.tree) : []) {
                if (!safeName(child.name)) {
                    throw new Error('This backup holds a name that cannot be restored safely');
                }
                await put(child, join(place, child.name));
            }
            await own(place, entry);
            if (made) {
                await chmod(place, entry.mode);
            }
            await utimes(place, stamp(entry.mtime), stamp(entry.mtime)).catch(() => undefined);
            return;
        }
        if (entry.type === 'symlink') {
            await clear(place);
            await symlink(entry.target ?? '', place);
            return;
        }
        const temporary = join(dirname(place), `.frameleaf-restoring-${started}-${++written}`);
        const file = await open(temporary, 'wx', 0o600);
        try {
            try {
                for await (const chunk of readFile(repository, entry)) {
                    await file.writeFile(chunk);
                    result.bytes += chunk.length;
                }
            }
            finally {
                await file.close();
            }
            await own(temporary, entry);
            await chmod(temporary, entry.mode);
            await utimes(temporary, stamp(entry.mtime), stamp(entry.mtime));
            await clear(place);
            await rename(temporary, place);
        }
        catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
        result.files++;
    };
    if (path.length > 0 && !safeName(start.name)) {
        throw new Error('This backup holds a name that cannot be restored safely');
    }
    const missing = [];
    for (let at = resolve(target); !(await lstat(at).catch(() => null)); at = dirname(at)) {
        missing.unshift(at);
    }
    for (const folder of missing) {
        await mkdir(folder);
        await chmod(folder, ((await lstat(folder)).mode & 0o7777) | 0o700);
    }
    await put(start, path.length > 0 ? join(target, start.name) : target);
    return result;
}
