import type { Repository } from './repository.js';
export type EntryType = 'file' | 'dir' | 'symlink';
export interface SourceEntry {
    name: string;
    type: EntryType;
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
    size: number;
    target?: string;
    unreadable?: string;
    key?: string;
}
export interface Source {
    list(path: string[]): Promise<SourceEntry[]>;
    read(path: string[]): AsyncIterable<Uint8Array>;
}
export interface Entry extends Omit<SourceEntry, 'size'> {
    size: number;
    chunks?: string[];
    lists?: string[];
    tree?: string;
    files?: number;
}
export declare const safeName: (name: string) => boolean;
export declare const encodeTree: (entries: Entry[]) => Buffer<ArrayBuffer>;
export declare function readTree(repository: Repository, id: string): Promise<Entry[]>;
export declare function fileChunks(repository: Repository, entry: Entry): Promise<string[]>;
export declare function fsSource(root: string): Source;
export declare function mountSource(mounts: {
    path: string[];
    source: Source;
}[]): Source;
export declare function filterSource(source: Source, skip: (path: string[], entry: SourceEntry) => boolean): Source;
export declare function measureSource(source: Source, path?: string[]): Promise<{
    files: number;
    bytes: number;
}>;
