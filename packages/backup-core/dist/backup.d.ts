import { type Repository, type Snapshot } from './repository.js';
import { type Source } from './tree.js';
export interface BackupProblem {
    path: string[];
    message: string;
}
export interface BackupResult {
    key: string;
    snapshot: Snapshot;
    ciphertextSha256: string;
    problems: BackupProblem[];
    unchanged: number;
}
export interface BackupOptions {
    time?: Date;
    packTarget?: number;
    signal?: AbortSignal;
    onProgress?: (progress: {
        files: number;
        bytes: number;
        storedBytes: number;
    }) => void;
}
export declare function backup(repository: Repository, source: Source, options?: BackupOptions): Promise<BackupResult>;
