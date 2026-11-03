export declare const KEY_FILE_FORMAT_1 = "frameleaf-locked-key/1";
export declare const KEY_FILE_FORMAT_2 = "frameleaf-locked-key/2";
export declare const KEY_FILE_FORMATS: readonly ["frameleaf-locked-key/1", "frameleaf-locked-key/2"];
export type LockedKeyFileFormat = (typeof KEY_FILE_FORMATS)[number];
export declare const isKeyFileFormat: (format: unknown) => format is LockedKeyFileFormat;
export declare const PEPPER_BYTES = 32;
export type WrapKind = 'pin' | 'passphrase' | 'recovery';
export type KeyWrap = {
    kind: WrapKind;
    salt: string;
    nonce: string;
    ciphertext: string;
    pepper?: {
        kdf: 'hkdf-sha256';
        id: string;
    };
} & KdfParams;
type KdfParams = {
    kdf: 'scrypt';
    N: number;
    r: number;
    p: number;
} | {
    kdf: 'hkdf-sha256';
};
export interface LockedKeyFile {
    format: LockedKeyFileFormat;
    userId: string;
    label: string;
    publicKey: string;
    mode: 'pin' | 'advanced';
    encrypting: boolean;
    wraps: KeyWrap[];
    createdAt: string;
    updatedAt: string;
}
export interface WrapOptions {
    pepper?: Buffer;
}
export declare class LockedKeyFileCorruptError extends Error {
    constructor(message: string);
}
export declare class LockedPepperError extends Error {
    readonly reason: 'missing' | 'mismatch';
    constructor(message: string, reason: 'missing' | 'mismatch');
}
export declare const pepperId: (pepper: Buffer) => string;
export declare function wrapKey(file: Omit<LockedKeyFile, 'wraps'> & {
    wraps?: KeyWrap[];
}, privateKey: Buffer, kind: WrapKind, secret: string, options?: WrapOptions): Promise<LockedKeyFile>;
export declare function unwrapKey(file: LockedKeyFile, kind: WrapKind, secret: string, options?: WrapOptions): Promise<Buffer>;
export declare const hasUnpepperedPinWrap: (file: Pick<LockedKeyFile, "wraps">) => boolean;
export declare function removeWrap(file: LockedKeyFile, kind: WrapKind): LockedKeyFile;
export {};
