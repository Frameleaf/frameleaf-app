import { createHash, createPublicKey, verify } from 'node:crypto';
import { type Ed25519PublicJwk, type FrameleafKeySigner, ed25519Thumbprint } from './dpop.js';

/**
 * One link in the signed history of backups that Frameleaf Cloud keeps: which stored object is the
 * backup, its exact version and the hash of its bytes, and the link before it. The machine that made the
 * backup signs it, so the history can be withheld by the cloud but never forged, reordered or rolled back.
 * Checking the shape of a descriptor is the caller's job; this file only fixes the bytes that are signed.
 */
export interface SnapshotDescriptor {
  version: 2;
  instanceId: string;
  vaultId: string;
  snapshotId: string;
  /** Starts at 1 and goes up by one. */
  sequence: number;
  /** The digest of the record before this one; null for the first. */
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
  /** Ed25519 over the signing input, unpadded base64url. */
  signature: string;
  /** SHA-256 of the signing input, hex. The next record names it as `previousDigest`. */
  digest: string;
  signerJwk: Ed25519PublicJwk & { kid: string };
}

/** The exact bytes that are signed. The field order is the published contract; never reorder it. */
export const snapshotSigningInput = (d: SnapshotDescriptor): Buffer =>
  Buffer.from(
    'frameleaf-backup-snapshot-v2\n' +
      JSON.stringify({
        version: d.version,
        instanceId: d.instanceId,
        vaultId: d.vaultId,
        snapshotId: d.snapshotId,
        sequence: d.sequence,
        previousDigest: d.previousDigest,
        createdAt: d.createdAt,
        manifest: {
          format: d.manifest.format,
          formatVersion: d.manifest.formatVersion,
          keyVersion: d.manifest.keyVersion,
          objectKey: d.manifest.objectKey,
          versionId: d.manifest.versionId,
          ciphertextSha256: d.manifest.ciphertextSha256,
        },
        signerKid: d.signerKid,
      }),
  );

export const snapshotDigest = (descriptor: SnapshotDescriptor): string =>
  createHash('sha256').update(snapshotSigningInput(descriptor)).digest('hex');

/** Signs a descriptor with the key it names. */
export const signSnapshotDescriptor = (
  descriptor: SnapshotDescriptor,
  signer: FrameleafKeySigner,
): SnapshotSignature => {
  if (!signer.signBytes || descriptor.signerKid !== signer.kid) {
    throw new Error('Backup requires the current instance signing identity');
  }
  const bytes = snapshotSigningInput(descriptor);
  return {
    signature: signer.signBytes(bytes).toString('base64url'),
    digest: createHash('sha256').update(bytes).digest('hex'),
    signerJwk: { ...signer.publicJwk, kid: signer.kid },
  };
};

/** Whether a record was signed by `pinned`, a key the caller already trusts, and says so truthfully about itself. */
export const snapshotSignatureHolds = (
  record: SnapshotSignature & { descriptor: SnapshotDescriptor },
  pinned: (Ed25519PublicJwk & { kid: string }) | undefined,
): boolean => {
  if (
    !pinned ||
    pinned.kid !== record.descriptor.signerKid ||
    pinned.x !== record.signerJwk.x ||
    ed25519Thumbprint(pinned) !== pinned.kid ||
    record.signerJwk.kid !== pinned.kid
  ) {
    return false;
  }
  const bytes = snapshotSigningInput(record.descriptor);
  return (
    createHash('sha256').update(bytes).digest('hex') === record.digest &&
    verify(null, bytes, createPublicKey({ key: pinned, format: 'jwk' }), Buffer.from(record.signature, 'base64url'))
  );
};
