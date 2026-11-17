import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { type ChunkerParams, DEFAULT_CHUNKER, checkChunker, gearTable } from './chunker.js';
import {
  FORMAT,
  type RepositoryKeys,
  UnsealError,
  VERSION,
  deriveKeys,
  openBlob,
  seal,
  sealBlob,
  unseal,
} from './keys.js';
import type { Store } from './store.js';

const PACK_MAGIC = Buffer.from('FLRP0001');
const PACK_FOOTER = 4 + PACK_MAGIC.length;
const ENTRY = 40;
/** Packs keep object counts low (Wasabi bills a 4 KB minimum per object) and hide chunk sizes from the provider. */
export const PACK_TARGET = 64 * 1024 * 1024;

export interface Location {
  pack: string;
  offset: number;
  length: number;
}

export interface RepositoryConfig {
  format: typeof FORMAT;
  version: number;
  repoId: string;
  chunker: ChunkerParams;
  /** The caller's label for the root key that wraps this repository's key. */
  keyVersion: string;
  wrappedKey: string;
}

export interface Snapshot {
  v: 1;
  repoId: string;
  /** Order of snapshots. The clock never decides it. */
  seq: number;
  time: string;
  tree: string;
  parent: string | null;
  stats: { files: number; folders: number; bytes: number; storedBytes: number };
}

export class MissingBlobError extends Error {
  override name = 'MissingBlobError';
  constructor(readonly id: string) {
    super(`A piece of this backup is missing from storage: ${id}`);
  }
}

interface PackEntry {
  id: Buffer;
  offset: number;
  length: number;
}
interface WrittenPack {
  pack: string;
  entries: PackEntry[];
}

const encodeEntries = (entries: PackEntry[]) => {
  const out = Buffer.alloc(entries.length * ENTRY);
  for (const [index, entry] of entries.entries()) {
    entry.id.copy(out, index * ENTRY);
    out.writeUInt32BE(entry.offset, index * ENTRY + 32);
    out.writeUInt32BE(entry.length, index * ENTRY + 36);
  }
  return out;
};

function* decodeEntries(data: Buffer) {
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

const wrapInfo = (repoId: string) => Buffer.from(`${FORMAT}/${VERSION} ${repoId}`);
// Frameleaf Cloud accepts 16 to 64 hex characters here; the engine writes 16.
const SNAPSHOT_KEY = /^s\/(\d{12})-[0-9a-f]{16,64}$/;

export class Repository {
  /**
   * Every blob the repository holds, by id.
   * ponytail: a Map in memory, roughly 200 MB per million blobs (about 2 TB of data). Move to a
   * node:sqlite cache on disk before servers of that size are common.
   */
  readonly index = new Map<string, Location>();
  /** Index objects the last `loadIndex` could not open. */
  readonly damagedIndexes: string[] = [];

  private constructor(
    readonly store: Store,
    readonly config: RepositoryConfig,
    readonly keys: RepositoryKeys,
    readonly gear: Uint32Array,
  ) {}

  /** Starts a new repository. The repository key is made here and wrapped with `rootKey`; it never leaves in the clear. */
  static async init(
    store: Store,
    options: { rootKey: Buffer; keyVersion?: string; chunker?: ChunkerParams },
  ): Promise<Repository> {
    if ((await store.list('config')).length > 0) {
      throw new Error('This storage already holds a repository');
    }
    const chunker = options.chunker ?? DEFAULT_CHUNKER;
    checkChunker(chunker);
    const master = randomBytes(32);
    const repoId = randomUUID();
    const config: RepositoryConfig = {
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

  /** The unencrypted description of a repository: enough to know which root key opens it. */
  static async readConfig(store: Store): Promise<RepositoryConfig> {
    const config = JSON.parse((await store.get('config')).toString()) as RepositoryConfig;
    if (config.format !== FORMAT || config.version !== VERSION) {
      throw new Error(`Not a ${FORMAT} version ${VERSION} repository`);
    }
    checkChunker(config.chunker);
    return config;
  }

  static async open(store: Store, options: { rootKey: Buffer }): Promise<Repository> {
    const config = await Repository.readConfig(store);
    const master = unseal(options.rootKey, wrapInfo(config.repoId), Buffer.from(config.wrappedKey, 'base64'));
    const keys = deriveKeys(master, config.repoId);
    return new Repository(store, config, keys, gearTable(keys.cut));
  }

  /**
   * Rebuilds the index from storage. Only blobs in packs that are really there count, and a pack no
   * index mentions is adopted from its own trailer, so a run that stopped before writing its index
   * loses nothing and re-sends nothing.
   */
  async loadIndex(): Promise<void> {
    this.index.clear();
    const packs = new Set((await this.store.list('p/')).map((object) => object.key));
    const indexed = new Set<string>();
    this.damagedIndexes.length = 0;
    for (const object of await this.store.list('i/')) {
      const sealed = await this.store.get(object.key);
      let data: Buffer;
      try {
        data = zstdDecompressSync(unseal(this.keys.meta, Buffer.from(object.key), sealed));
      } catch (error) {
        // The index is only a faster copy of what packs say about themselves. One whose bytes are wrong
        // (it fails its seal, or what the seal held does not unpack) is left out; the packs it listed are
        // read from their own trailers below. Any other failure is not about this index and is passed on.
        const unpack = String((error as NodeJS.ErrnoException).code ?? '').startsWith('ZSTD_');
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
      // A pack whose trailer can't be opened was never finished. A storage failure is not that, and is passed on.
      const adopted = await this.readTrailer(pack).catch((error: unknown) => {
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

  /** A pack's own list of what it holds. This, not the index, is the authority. */
  async readTrailer(pack: string) {
    const footer = await this.store.get(pack, { suffix: PACK_FOOTER });
    if (footer.length !== PACK_FOOTER || !footer.subarray(4).equals(PACK_MAGIC)) {
      throw new UnsealError();
    }
    const length = footer.readUInt32BE(0);
    const tail = await this.store.get(pack, { suffix: PACK_FOOTER + length });
    return [...decodeEntries(unseal(this.keys.meta, Buffer.from(pack), tail.subarray(0, length)))];
  }

  async readBlob(id: string): Promise<Buffer> {
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

  /** Records which packs hold which blobs. Written after its packs and before any snapshot that needs them. */
  async writeIndex(packs: WrittenPack[]): Promise<void> {
    if (packs.length === 0) {
      return;
    }
    const parts: Buffer[] = [];
    for (const { pack, entries } of packs) {
      const head = Buffer.alloc(20);
      Buffer.from(pack.slice(2), 'hex').copy(head);
      head.writeUInt32BE(entries.length, 16);
      parts.push(head, encodeEntries(entries));
    }
    const key = `i/${randomBytes(16).toString('hex')}`;
    await this.store.put(key, seal(this.keys.meta, Buffer.from(key), zstdCompressSync(Buffer.concat(parts))));
  }

  /** Replaces every index object with one that lists exactly what the index holds now. The new one is written first. */
  async rewriteIndex(): Promise<void> {
    const old = await this.store.list('i/');
    const packs = new Map<string, PackEntry[]>();
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

  /** Snapshots oldest first. */
  async listSnapshots(): Promise<{ key: string; seq: number }[]> {
    return (await this.store.list('s/'))
      .flatMap(({ key }) => {
        const match = SNAPSHOT_KEY.exec(key);
        return match ? [{ key, seq: Number(match[1]) }] : [];
      })
      .sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key));
  }

  async readSnapshot(key: string): Promise<Snapshot> {
    const snapshot = JSON.parse(
      unseal(this.keys.meta, Buffer.from(key), await this.store.get(key)).toString(),
    ) as Snapshot;
    if (snapshot.repoId !== this.config.repoId || snapshot.seq !== Number(SNAPSHOT_KEY.exec(key)?.[1])) {
      throw new UnsealError();
    }
    return snapshot;
  }

  /** The last step of a backup. Returns what a signed receipt needs: the object's name and the hash of what was stored. */
  async writeSnapshot(body: Pick<Snapshot, 'time' | 'tree' | 'parent' | 'stats'>, sequence?: number) {
    // Where a signed history is kept (Frameleaf Cloud), its next number is used, so the two never drift apart.
    const seq = sequence ?? ((await this.listSnapshots()).at(-1)?.seq ?? 0) + 1;
    if (!Number.isInteger(seq) || seq < 1 || seq > 999_999_999_999) {
      throw new RangeError('A snapshot number must be a whole number from 1 to 999999999999');
    }
    const key = `s/${String(seq).padStart(12, '0')}-${randomBytes(8).toString('hex')}`;
    const snapshot: Snapshot = { v: 1, repoId: this.config.repoId, seq, ...body };
    const sealed = seal(this.keys.meta, Buffer.from(key), Buffer.from(JSON.stringify(snapshot)));
    const { versionId } = await this.store.put(key, sealed);
    return { key, snapshot, versionId, ciphertextSha256: createHash('sha256').update(sealed).digest('hex') };
  }
}

/** Collects new blobs into packs. A blob the repository already holds is never stored twice. */
export class PackWriter {
  readonly written: WrittenPack[] = [];
  storedBytes = 0;
  private parts: Buffer[] = [];
  private entries: PackEntry[] = [];
  private pending = new Set<string>();
  private size = 0;

  constructor(
    private repository: Repository,
    private target = PACK_TARGET,
  ) {}

  has(id: string) {
    return this.repository.index.has(id) || this.pending.has(id);
  }

  /** Returns false when the blob was already there. */
  async add(id: Buffer, plain: Buffer): Promise<boolean> {
    const hex = id.toString('hex');
    if (this.has(hex)) {
      return false;
    }
    await this.addSealed(id, sealBlob(this.repository.keys, id, plain));
    return true;
  }

  /** A blob already in its stored form, as copied out of another pack. Stored even if the index knows it. */
  async addSealed(id: Buffer, blob: Buffer): Promise<void> {
    this.entries.push({ id, offset: this.size, length: blob.length });
    this.parts.push(blob);
    this.pending.add(id.toString('hex'));
    this.size += blob.length;
    if (this.size >= this.target) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
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
