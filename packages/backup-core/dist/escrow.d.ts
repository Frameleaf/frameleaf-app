export declare const ESCROW_SCRYPT: Readonly<{
    readonly N: 131072;
    readonly r: 8;
    readonly p: 1;
}>;
export declare const ESCROW_MIN_PASSPHRASE = 12;
export declare const ESCROW_BLOB_VERSION = 1;
export interface KeyEscrowBlob {
    version: number;
    kdf: {
        name: 'scrypt';
        N: 131_072;
        r: 8;
        p: 1;
        salt: string;
    };
    cipher: 'aes-256-gcm';
    nonce: string;
    ciphertext: string;
}
export declare const scryptDerive: (passphrase: string, salt: Buffer, options: {
    N: number;
    r: number;
    p: number;
    keyLength: number;
}) => Promise<Buffer>;
export declare const escrowPassphraseProblem: (passphrase: string) => string | null;
export declare const wrapBucketKey: (key: Buffer, passphrase: string, options?: {
    salt?: Buffer;
    nonce?: Buffer;
}) => Promise<KeyEscrowBlob>;
export declare const unwrapBucketKey: (blob: KeyEscrowBlob, passphrase: string) => Promise<Buffer>;
