import { type Repository } from './repository.js';
export interface RetentionPolicy {
    keepLast: number;
    keepDays: number;
    keepMonthly: number;
}
export declare const DEFAULT_RETENTION: RetentionPolicy;
export declare function retain(snapshots: {
    key: string;
    time: string;
}[], policy: RetentionPolicy, now: Date): Set<string>;
export interface VerifyReport {
    snapshots: number;
    blobs: number;
    damagedSnapshots: string[];
    missing: string[];
    packsRead: number;
    damagedPacks: string[];
    damagedIndexes: string[];
}
export interface VerifyOptions {
    readPack?: (pack: string, index: number) => boolean;
}
export declare function verify(repository: Repository, options?: VerifyOptions): Promise<VerifyReport>;
export interface PruneOptions {
    policy?: RetentionPolicy;
    now?: Date;
    minAgeDays?: number;
    repackBelow?: number;
    packTarget?: number;
}
export interface PruneReport {
    keptSnapshots: number;
    removedSnapshots: string[];
    deletedPacks: number;
    repackedPacks: number;
    freedBytes: number;
}
export declare function prune(repository: Repository, options?: PruneOptions): Promise<PruneReport>;
