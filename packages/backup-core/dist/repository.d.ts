import { type ChunkerParams } from './chunker.js';
import { FORMAT, type RepositoryKeys } from './keys.js';
import type { Store } from './store.js';
export declare const PACK_TARGET: number;
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
    keyVersion: string;
    wrappedKey: string;
}
export interface Snapshot {
    v: 1;
    repoId: string;
    seq: number;
    time: string;
    tree: string;
    parent: string | null;
    stats: {
        files: number;
        folders: number;
        bytes: number;
        storedBytes: number;
    };
}
export declare class MissingBlobError extends Error {
    readonly id: string;
    name: string;
    constructor(id: string);
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
export declare function checkSnapshotId(id: string | undefined): void;
export declare class Repository {
    readonly store: Store;
    readonly config: RepositoryConfig;
    readonly keys: RepositoryKeys;
    readonly gear: Uint32Array;
    readonly index: Map<string, Location>;
    readonly damagedIndexes: string[];
    private constructor();
    static init(store: Store, options: {
        rootKey: Buffer;
        keyVersion?: string;
        chunker?: ChunkerParams;
    }): Promise<Repository>;
    static readConfig(store: Store): Promise<RepositoryConfig>;
    static open(store: Store, options: {
        rootKey: Buffer;
    }): Promise<Repository>;
    loadIndex(): Promise<void>;
    readTrailer(pack: string): Promise<{
        id: string;
        offset: number;
        length: number;
    }[]>;
    readBlob(id: string): Promise<Buffer>;
    writeIndex(packs: WrittenPack[]): Promise<void>;
    rewriteIndex(): Promise<void>;
    listSnapshots(): Promise<{
        key: string;
        seq: number;
    }[]>;
    readSnapshot(key: string): Promise<Snapshot>;
    writeSnapshot(body: Pick<Snapshot, 'time' | 'tree' | 'parent' | 'stats'>, sequence?: number, signal?: AbortSignal, id?: string): Promise<{
        key: string;
        snapshot: Snapshot;
        versionId: string | null;
        ciphertextSha256: string;
    }>;
}
export declare class PackWriter {
    private repository;
    private target;
    readonly written: WrittenPack[];
    storedBytes: number;
    private parts;
    private entries;
    private pending;
    private size;
    constructor(repository: Repository, target?: number);
    has(id: string): boolean;
    add(id: Buffer, plain: Buffer): Promise<boolean>;
    addSealed(id: Buffer, blob: Buffer): Promise<void>;
    flush(): Promise<void>;
}
export {};
