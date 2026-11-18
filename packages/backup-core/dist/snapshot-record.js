import { createHash, createPublicKey, verify } from 'node:crypto';
import { ed25519Thumbprint } from './dpop.js';
export const snapshotSigningInput = (d) => Buffer.from('frameleaf-backup-snapshot-v2\n' +
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
    }));
export const snapshotDigest = (descriptor) => createHash('sha256').update(snapshotSigningInput(descriptor)).digest('hex');
export const signSnapshotDescriptor = (descriptor, signer) => {
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
export const snapshotSignatureHolds = (record, pinned) => {
    if (!pinned ||
        pinned.kid !== record.descriptor.signerKid ||
        pinned.x !== record.signerJwk.x ||
        ed25519Thumbprint(pinned) !== pinned.kid ||
        record.signerJwk.kid !== pinned.kid) {
        return false;
    }
    const bytes = snapshotSigningInput(record.descriptor);
    return (createHash('sha256').update(bytes).digest('hex') === record.digest &&
        verify(null, bytes, createPublicKey({ key: pinned, format: 'jwk' }), Buffer.from(record.signature, 'base64url')));
};
