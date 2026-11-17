export declare const FORMAT = "frameleaf-repository";
export declare const VERSION = 1;
export declare class UnsealError extends Error {
    name: string;
    constructor();
}
export interface RepositoryKeys {
    id: Buffer;
    blob: Buffer;
    cut: Buffer;
    meta: Buffer;
}
export declare const derive: (key: Buffer, salt: Buffer, info: string, length?: number) => Buffer<ArrayBuffer>;
export declare function deriveKeys(master: Buffer, repoId: string): RepositoryKeys;
export declare const blobId: (keys: RepositoryKeys, plain: Uint8Array) => NonSharedBuffer;
export declare function seal(key: Buffer, aad: Buffer, plain: Uint8Array): Buffer;
export declare function unseal(key: Buffer, aad: Buffer, sealed: Buffer): Buffer;
export declare function sealBlob(keys: RepositoryKeys, id: Buffer, plain: Buffer): Buffer;
export declare function openBlob(keys: RepositoryKeys, id: Buffer, blob: Buffer): Buffer;
