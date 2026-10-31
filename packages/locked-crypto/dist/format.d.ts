export declare const LOCKED_MAGIC = "FLLK";
export declare const SEGMENT_SIZE = 65536;
export type LockedFileKind = 'original' | 'thumbnail' | 'preview' | 'fullsize' | 'encoded-video' | 'sidecar' | 'other';
export interface LockedFileInfo {
    assetId: string;
    kind: LockedFileKind;
    originalFileName: string;
    mime: string;
}
export interface Recipient {
    publicKey: Buffer;
}
export interface LockedHeader {
    version: 1;
    plaintextLength: number;
    keyIds: Buffer[];
    headerLength: number;
}
export declare class WrongSecretError extends Error {
    name: string;
}
export declare class LockedFileCorruptError extends Error {
    name: string;
}
export declare const publicKeyFromPrivate: (privateKey: Buffer) => Buffer;
export declare function generateKeyPair(): {
    publicKey: Buffer;
    privateKey: Buffer;
};
export declare function keyId(publicKey: Buffer): Buffer;
export declare function isLockedFile(path: string): Promise<boolean>;
export declare function readHeader(path: string): Promise<LockedHeader>;
export declare function encryptFile(src: string, dst: string, recipients: Recipient[], info: LockedFileInfo): Promise<{
    plaintextLength: number;
}>;
export declare function openDecrypt(path: string, privateKey: Buffer, range?: {
    start: number;
    end: number;
}): Promise<{
    stream: NodeJS.ReadableStream;
    plaintextLength: number;
    info: LockedFileInfo;
}>;
export declare function decryptFile(src: string, dst: string, privateKey: Buffer): Promise<LockedFileInfo>;
export declare function rewrapFile(src: string, dst: string, privateKey: Buffer, recipients: Recipient[]): Promise<void>;
export declare function verifyFile(path: string, privateKey: Buffer): Promise<void>;
