import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';
import { addClientBackupKeys } from 'src/utils/cloud-backup-crypto.js';
import {
  appendBackupSnapshot,
  backupSnapshotSigningInput,
  selectBackupSnapshot,
  signBackupSnapshot,
  unwrapBackupRecoveryKit,
  verifyBackupSnapshot,
  wrapBackupRecoveryKit,
} from 'src/utils/cloud-backup-recovery.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

const vaultId = 'f0000000-0000-4000-8000-000000000001';
const pair = generateKeyPairSync('ed25519');
const jwk = pair.publicKey.export({ format: 'jwk' });
const publicJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: jwk.x! };
const signer: FrameleafKeySigner = {
  kid: ed25519Thumbprint(publicJwk),
  publicJwk,
  sign: () => '',
  signBytes: (value) => sign(null, value, pair.privateKey),
};
const record = (sequence: number, previousDigest: string | null) =>
  signBackupSnapshot(
    {
      version: 2,
      instanceId: vaultId,
      vaultId,
      snapshotId: `f0000000-0000-4000-8000-${String(sequence + 10).padStart(12, '0')}`,
      sequence,
      previousDigest,
      createdAt: '2026-10-11T00:00:00.000Z',
      manifest: {
        format: 'frameleaf-client-backup',
        formatVersion: 1,
        keyVersion: 1,
        objectKey: `m/v1/${vaultId}/1/20261011T0000${String(sequence).padStart(2, '0')}Z.json.gz`,
        versionId: `version-${sequence}`,
        ciphertextSha256: 'a'.repeat(64),
      },
      signerKid: signer.kid,
    },
    signer,
  );

describe('trusted recovery history', () => {
  it('matches an independently encoded canonical descriptor digest', () => {
    const descriptor = {
      ...record(1, null).descriptor,
      snapshotId: 'f0000000-0000-4000-8000-000000000002',
      signerKid: 'A'.repeat(43),
      manifest: { ...record(1, null).descriptor.manifest, versionId: 'provider-version+1' },
    };
    expect(createHash('sha256').update(backupSnapshotSigningInput(descriptor)).digest('hex')).toBe(
      '9960c0b4e4611a2d9c8ca23109f27a4a88503c617d881cc0b058680a27c16287',
    );
  });
  it('uses FC canonical signature bytes and preserves explicit historical selection', () => {
    const first = record(1, null);
    const second = record(2, first.digest);
    const history = appendBackupSnapshot(appendBackupSnapshot(null, first), second);
    expect(first.digest).toBe(createHash('sha256').update(backupSnapshotSigningInput(first.descriptor)).digest('hex'));
    expect(backupSnapshotSigningInput(first.descriptor).toString()).toMatch(
      /^frameleaf-backup-snapshot-v2\n\{"version":2,"instanceId":/,
    );
    expect(selectBackupSnapshot(history).record.digest).toBe(second.digest);
    expect(selectBackupSnapshot(history, first.descriptor.manifest.objectKey).historical).toBe(true);
    expect(() => selectBackupSnapshot({ ...history, snapshots: [first] })).toThrow('rollback');
    expect(() => selectBackupSnapshot({ ...history, anchor: { ...history.anchor, digest: 'f'.repeat(64) } })).toThrow(
      'substitution',
    );
    const poison = {
      ...second,
      descriptor: {
        ...second.descriptor,
        manifest: { ...second.descriptor.manifest, versionId: 'delete-marker-version' },
      },
    };
    expect(() => verifyBackupSnapshot(poison, history.pinnedKeys)).toThrow('Untrusted');
    expect(() => verifyBackupSnapshot(second, [])).toThrow('Untrusted');
    const third = record(3, second.digest);
    expect(selectBackupSnapshot({ ...history, snapshots: [...history.snapshots, third] }).newerUnanchoredHistory).toBe(
      true,
    );
    expect(() =>
      selectBackupSnapshot(
        { ...history, snapshots: [first, third], anchor: { ...history.anchor, sequence: 3, digest: third.digest } },
        first.descriptor.manifest.objectKey,
      ),
    ).toThrow('gap');
  });
  it(
    'wraps both key histories locally and rejects passphrase/context tampering and own-key escrow',
    { timeout: 30_000 },
    async () => {
      const file = JSON.stringify(
        addClientBackupKeys({
          format: 'frameleaf-backup-key',
          key: Buffer.alloc(32, 7).toString('base64'),
          instanceId: vaultId,
          mode: 'server',
        }),
      );
      const blob = await wrapBackupRecoveryKit(file, 'correct horse battery staple', 'server');
      expect(blob.ciphertext).not.toContain(Buffer.alloc(32, 7).toString('base64'));
      expect(await unwrapBackupRecoveryKit(blob, 'correct horse battery staple')).toBe(file);
      await expect(unwrapBackupRecoveryKit(blob, 'incorrect horse battery staple')).rejects.toThrow();
      await expect(
        unwrapBackupRecoveryKit({ ...blob, keyVersion: 2 }, 'correct horse battery staple'),
      ).rejects.toThrow();
      await expect(wrapBackupRecoveryKit(file, 'correct horse battery staple', 'own-memory')).rejects.toThrow('never');
    },
  );
});
