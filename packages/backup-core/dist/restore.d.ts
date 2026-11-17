import type { Repository, Snapshot } from './repository.js';
import { type Entry } from './tree.js';
export declare function find(repository: Repository, snapshot: Snapshot, path: string[]): Promise<Entry | null>;
export declare function listFolder(repository: Repository, snapshot: Snapshot, path: string[]): Promise<Entry[]>;
export declare function readFile(repository: Repository, entry: Entry): AsyncGenerator<Buffer>;
export interface RestoreResult {
    files: number;
    bytes: number;
    movedAside: {
        from: string;
        to: string;
    }[];
}
export interface RestoreOptions {
    aside?: (path: string) => string;
}
export declare function restore(repository: Repository, snapshot: Snapshot, path: string[], target: string, options?: RestoreOptions): Promise<RestoreResult>;
