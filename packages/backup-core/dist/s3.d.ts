import type { Store } from './store.js';
export interface S3Credentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
}
export interface S3Options {
    endpoint: string;
    region: string;
    bucket: string;
    prefix?: string;
    credentials: (renew: boolean) => Promise<S3Credentials>;
    uploadLimit?: () => number | null;
    retryDelaysMs?: number[];
    partSize?: number;
    idleTimeoutMs?: number;
}
export declare class S3Error extends Error {
    readonly status: number | null;
    readonly code: string | null;
    name: string;
    constructor(message: string, status: number | null, code: string | null);
}
export declare function signS3Request(request: {
    method: string;
    host: string;
    canonicalUri: string;
    query: string;
    headers: Record<string, string>;
    body?: Uint8Array;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    now: Date;
}): Record<string, string>;
export declare function s3Store(options: S3Options): Store;
