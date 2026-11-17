export interface StoredObject {
    key: string;
    size: number;
    modified: Date;
}
export type ByteRange = {
    start: number;
    end: number;
} | {
    suffix: number;
};
export interface Store {
    put(key: string, body: Buffer): Promise<{
        versionId: string | null;
    }>;
    get(key: string, range?: ByteRange): Promise<Buffer>;
    list(prefix: string): Promise<StoredObject[]>;
    delete(key: string): Promise<void>;
}
export declare function memoryStore(): Store & {
    objects: Map<string, Buffer>;
};
export declare function dirStore(root: string): Store;
