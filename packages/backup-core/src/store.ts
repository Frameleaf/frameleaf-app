import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface StoredObject {
  key: string;
  size: number;
  modified: Date;
}

/** `end` is exclusive. `suffix` reads that many bytes from the end. */
export type ByteRange = { start: number; end: number } | { suffix: number };

/**
 * Where a repository keeps its objects. Objects are written once and never changed.
 * ponytail: `put` takes the whole object in memory (packs are about 64 MiB). The S3 store sends packs as
 * multipart parts; widen this to a stream when that lands.
 */
export interface Store {
  /** Storage that keeps versions says which one this write made; a signed record of a backup names it. */
  put(key: string, body: Buffer): Promise<{ versionId: string | null }>;
  get(key: string, range?: ByteRange): Promise<Buffer>;
  list(prefix: string): Promise<StoredObject[]>;
  delete(key: string): Promise<void>;
}

const slice = (body: Buffer, range?: ByteRange) =>
  !range
    ? body
    : 'suffix' in range
      ? body.subarray(Math.max(0, body.length - range.suffix))
      : body.subarray(range.start, range.end);

export function memoryStore(): Store & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const written = new Map<string, Date>();
  return {
    objects,
    async put(key, body) {
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

/** A folder on disk: for tests, and for backing up to a local drive. */
export function dirStore(root: string): Store {
  const path = (key: string) => {
    if (!/^[\w-]+(\/[\w-]+)*$/.test(key)) {
      throw new Error(`Not a repository object name: ${key}`);
    }
    return join(root, ...key.split('/'));
  };
  return {
    async put(key, body) {
      const target = path(key);
      await mkdir(dirname(target), { recursive: true });
      // Written beside the target and renamed, so a crash never leaves half an object under its real name.
      const temporary = `${target}.${randomBytes(6).toString('hex')}.part`;
      await writeFile(temporary, body);
      await rename(temporary, target);
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
      } finally {
        await file.close();
      }
    },
    async list(prefix) {
      const names = await readdir(root, { recursive: true }).catch(() => [] as string[]);
      const found: StoredObject[] = [];
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
