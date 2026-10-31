export type WrapKind = 'pin' | 'passphrase' | 'recovery';
export type KeyWrap = {
    kind: WrapKind;
    salt: string;
    nonce: string;
    ciphertext: string;
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
    format: 'frameleaf-locked-key/1';
    userId: string;
    label: string;
    publicKey: string;
    mode: 'pin' | 'advanced';
    encrypting: boolean;
    wraps: KeyWrap[];
    createdAt: string;
    updatedAt: string;
}
export declare function wrapKey(file: Omit<LockedKeyFile, 'wraps'> & {
    wraps?: KeyWrap[];
}, privateKey: Buffer, kind: WrapKind, secret: string): Promise<LockedKeyFile>;
export declare function unwrapKey(file: LockedKeyFile, kind: WrapKind, secret: string): Promise<Buffer>;
export declare function removeWrap(file: LockedKeyFile, kind: WrapKind): LockedKeyFile;
export {};
