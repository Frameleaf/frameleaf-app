import { type Ed25519PublicJwk, type FrameleafKeySigner } from './dpop.js';
export interface SnapshotDescriptor {
    version: 2;
    instanceId: string;
    vaultId: string;
    snapshotId: string;
    sequence: number;
    previousDigest: string | null;
    createdAt: string;
    manifest: {
        format: string;
        formatVersion: number;
        keyVersion: number;
        objectKey: string;
        versionId: string;
        ciphertextSha256: string;
    };
    signerKid: string;
}
export interface SnapshotSignature {
    signature: string;
    digest: string;
    signerJwk: Ed25519PublicJwk & {
        kid: string;
    };
}
export declare const snapshotSigningInput: (d: SnapshotDescriptor) => Buffer;
export declare const snapshotDigest: (descriptor: SnapshotDescriptor) => string;
export declare const signSnapshotDescriptor: (descriptor: SnapshotDescriptor, signer: FrameleafKeySigner) => SnapshotSignature;
export declare const snapshotSignatureHolds: (record: SnapshotSignature & {
    descriptor: SnapshotDescriptor;
}, pinned: (Ed25519PublicJwk & {
    kid: string;
}) | undefined) => boolean;
