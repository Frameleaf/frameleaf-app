import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { DEFAULT_CHUNKER, checkChunker, gearTable } from './chunker.js';
import { FORMAT, UnsealError, VERSION, deriveKeys, openBlob, seal, sealBlob, unseal, } from './keys.js';
const PACK_MAGIC = Buffer.from('FLRP0001');
const PACK_FOOTER = 4 + PACK_MAGIC.length;
const ENTRY = 40;
export const PACK_TARGET = 64 * 1024 * 1024;
export class MissingBlobError extends Error {
    id;
    name = 'MissingBlobError';
    constructor(id) {
        super(`A piece of this backup is missing from storage: ${id}`);
        this.id = id;
    }
}
const encodeEntries = (entries) => {
    const out = Buffer.alloc(entries.length * ENTRY);
    for (const [index, entry] of entries.entries()) {
        entry.id.copy(out, index * ENTRY);
        out.writeUInt32BE(entry.offset, index * ENTRY + 32);
        out.writeUInt32BE(entry.length, index * ENTRY + 36);
    }
    return out;
};
function* decodeEntries(data) {
    if (data.length % ENTRY !== 0) {
        throw new UnsealError();
    }
    for (let at = 0; at < data.length; at += ENTRY) {
        yield {
            id: data.toString('hex', at, at + 32),
            offset: data.readUInt32BE(at + 32),
            length: data.readUInt32BE(at + 36),
        };
    }
}
const wrapInfo = (repoId) => Buffer.from(`${FORMAT}/${VERSION} ${repoId}`);
const SNAPSHOT_KEY = /^s\/(\d{12})-[0-9a-f]{16,64}$/;
export class Repository {
    store;
    config;
    keys;
    gear;
    index = new Map();
    damagedIndexes = [];
    constructor(store, config, keys, gear) {
        this.store = store;
        this.config = config;
        this.keys = keys;
        this.gear = gear;
    }
    static async init(store, options) {
        if ((await store.list('config')).length > 0) {
            throw new Error('This storage already holds a repository');
        }
        const chunker = options.chunker ?? DEFAULT_CHUNKER;
        checkChunker(chunker);
        const master = randomBytes(32);
        const repoId = randomUUID();
        const config = {
            format: FORMAT,
            version: VERSION,
            repoId,
            chunker,
            keyVersion: options.keyVersion ?? '1',
            wrappedKey: seal(options.rootKey, wrapInfo(repoId), master).toString('base64'),
        };
        await store.put('config', Buffer.from(JSON.stringify(config)));
        const keys = deriveKeys(master, repoId);
        return new Repository(store, config, keys, gearTable(keys.cut));
    }
    static async readConfig(store) {
        const config = JSON.parse((await store.get('config')).toString());
        if (config.format !== FORMAT || config.version !== VERSION) {
            throw new Error(`Not a ${FORMAT} version ${VERSION} repository`);
        }
        checkChunker(config.chunker);
        return config;
    }
    static async open(store, options) {
        const config = await Repository.readConfig(store);
        const master = unseal(options.rootKey, wrapInfo(config.repoId), Buffer.from(config.wrappedKey, 'base64'));
        const keys = deriveKeys(master, config.repoId);
        return new Repository(store, config, keys, gearTable(keys.cut));
    }
    async loadIndex() {
        this.index.clear();
        const packs = new Set((await this.store.list('p/')).map((object) => object.key));
        const indexed = new Set();
        this.damagedIndexes.length = 0;
        for (const object of await this.store.list('i/')) {
            const sealed = await this.store.get(object.key);
            let data;
            try {
                data = zstdDecompressSync(unseal(this.keys.meta, Buffer.from(object.key), sealed));
            }
            catch (error) {
                const unpack = String(error.code ?? '').startsWith('ZSTD_');
                if (!(error instanceof UnsealError) && !unpack) {
                    throw error;
                }
                this.damagedIndexes.push(object.key);
                continue;
            }
            for (let at = 0; at < data.length;) {
                const pack = `p/${data.toString('hex', at, at + 16)}`;
                const count = data.readUInt32BE(at + 16);
                const entries = data.subarray(at + 20, at + 20 + count * ENTRY);
                at += 20 + count * ENTRY;
                if (!packs.has(pack)) {
                    continue;
                }
                indexed.add(pack);
                for (const entry of decodeEntries(entries)) {
                    this.index.set(entry.id, { pack, offset: entry.offset, length: entry.length });
                }
            }
        }
        for (const pack of packs) {
            if (indexed.has(pack)) {
                continue;
            }
            const adopted = await this.readTrailer(pack).catch((error) => {
                if (error instanceof UnsealError) {
                    return [];
                }
                throw error;
            });
            for (const entry of adopted) {
                this.index.set(entry.id, { pack, offset: entry.offset, length: entry.length });
            }
        }
    }
    async readTrailer(pack) {
        const footer = await this.store.get(pack, { suffix: PACK_FOOTER });
        if (footer.length !== PACK_FOOTER || !footer.subarray(4).equals(PACK_MAGIC)) {
            throw new UnsealError();
        }
        const length = footer.readUInt32BE(0);
        const tail = await this.store.get(pack, { suffix: PACK_FOOTER + length });
        return [...decodeEntries(unseal(this.keys.meta, Buffer.from(pack), tail.subarray(0, length)))];
    }
    async readBlob(id) {
        const location = this.index.get(id);
        if (!location) {
            throw new MissingBlobError(id);
        }
        const blob = await this.store.get(location.pack, {
            start: location.offset,
            end: location.offset + location.length,
        });
        return openBlob(this.keys, Buffer.from(id, 'hex'), blob);
    }
    async writeIndex(packs) {
        if (packs.length === 0) {
            return;
        }
        const parts = [];
        for (const { pack, entries } of packs) {
            const head = Buffer.alloc(20);
            Buffer.from(pack.slice(2), 'hex').copy(head);
            head.writeUInt32BE(entries.length, 16);
            parts.push(head, encodeEntries(entries));
        }
        const key = `i/${randomBytes(16).toString('hex')}`;
        await this.store.put(key, seal(this.keys.meta, Buffer.from(key), zstdCompressSync(Buffer.concat(parts))));
    }
    async rewriteIndex() {
        const old = await this.store.list('i/');
        const packs = new Map();
        for (const [id, location] of this.index) {
            const entries = packs.get(location.pack) ?? [];
            entries.push({ id: Buffer.from(id, 'hex'), offset: location.offset, length: location.length });
            packs.set(location.pack, entries);
        }
        await this.writeIndex([...packs].map(([pack, entries]) => ({ pack, entries })));
        for (const object of old) {
            await this.store.delete(object.key);
        }
    }
    async listSnapshots() {
        return (await this.store.list('s/'))
            .flatMap(({ key }) => {
            const match = SNAPSHOT_KEY.exec(key);
            return match ? [{ key, seq: Number(match[1]) }] : [];
        })
            .sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key));
    }
    async readSnapshot(key) {
        const snapshot = JSON.parse(unseal(this.keys.meta, Buffer.from(key), await this.store.get(key)).toString());
        if (snapshot.repoId !== this.config.repoId || snapshot.seq !== Number(SNAPSHOT_KEY.exec(key)?.[1])) {
            throw new UnsealError();
        }
        return snapshot;
    }
    async writeSnapshot(body, sequence) {
        const seq = sequence ?? ((await this.listSnapshots()).at(-1)?.seq ?? 0) + 1;
        if (!Number.isInteger(seq) || seq < 1 || seq > 999_999_999_999) {
            throw new RangeError('A snapshot number must be a whole number from 1 to 999999999999');
        }
        const key = `s/${String(seq).padStart(12, '0')}-${randomBytes(8).toString('hex')}`;
        const snapshot = { v: 1, repoId: this.config.repoId, seq, ...body };
        const sealed = seal(this.keys.meta, Buffer.from(key), Buffer.from(JSON.stringify(snapshot)));
        const { versionId } = await this.store.put(key, sealed);
        return { key, snapshot, versionId, ciphertextSha256: createHash('sha256').update(sealed).digest('hex') };
    }
}
export class PackWriter {
    repository;
    target;
    written = [];
    storedBytes = 0;
    parts = [];
    entries = [];
    pending = new Set();
    size = 0;
    constructor(repository, target = PACK_TARGET) {
        this.repository = repository;
        this.target = target;
    }
    has(id) {
        return this.repository.index.has(id) || this.pending.has(id);
    }
    async add(id, plain) {
        const hex = id.toString('hex');
        if (this.has(hex)) {
            return false;
        }
        await this.addSealed(id, sealBlob(this.repository.keys, id, plain));
        return true;
    }
    async addSealed(id, blob) {
        this.entries.push({ id, offset: this.size, length: blob.length });
        this.parts.push(blob);
        this.pending.add(id.toString('hex'));
        this.size += blob.length;
        if (this.size >= this.target) {
            await this.flush();
        }
    }
    async flush() {
        if (this.entries.length === 0) {
            return;
        }
        const pack = `p/${randomBytes(16).toString('hex')}`;
        const trailer = seal(this.repository.keys.meta, Buffer.from(pack), encodeEntries(this.entries));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(trailer.length);
        const body = Buffer.concat([...this.parts, trailer, length, PACK_MAGIC]);
        await this.repository.store.put(pack, body);
        for (const entry of this.entries) {
            this.repository.index.set(entry.id.toString('hex'), { pack, offset: entry.offset, length: entry.length });
        }
        this.written.push({ pack, entries: this.entries });
        this.storedBytes += body.length;
        this.parts = [];
        this.entries = [];
        this.pending.clear();
        this.size = 0;
    }
}
