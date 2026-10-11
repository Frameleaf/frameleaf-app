import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import z from 'zod';
import type { FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';
import { writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { parseClientBackupKeys } from 'src/utils/cloud-backup-crypto.js';
import { ESCROW_SCRYPT, escrowPassphraseProblem, scryptDerive } from 'src/utils/cloud-backup-escrow.js';
import { parseBackupKey } from 'src/utils/cloud-backup.js';
import { keyEscrowBlobSchema } from 'src/utils/frameleaf-cloud-backup.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

const digest = z.string().regex(/^[\da-f]{64}$/);
const publicKey = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().regex(/^[\w-]{43}$/),
  kid: z.string().regex(/^[\w-]{43}$/),
});
export const backupSnapshotDescriptorSchema = z
  .strictObject({
    version: z.literal(2),
    instanceId: z.uuid(),
    vaultId: z.uuid(),
    snapshotId: z.uuid(),
    sequence: z.int().positive().max(Number.MAX_SAFE_INTEGER),
    previousDigest: digest.nullable(),
    createdAt: z.iso.datetime(),
    manifest: z.strictObject({
      format: z.literal('frameleaf-client-backup'),
      formatVersion: z.literal(1),
      keyVersion: z.int().positive().max(999_999_999),
      objectKey: z
        .string()
        .max(160)
        .regex(/^m\/v1\/[\da-f-]{36}\/[1-9]\d{0,8}\/\d{8}T\d{6}Z\.json\.gz$/),
      versionId: z
        .string()
        .min(1)
        .max(1024)
        .regex(/^[\w.~+/=-]+$/)
        .refine((value) => value !== 'null'),
      ciphertextSha256: digest,
    }),
    signerKid: z.string().regex(/^[\w-]{43}$/),
  })
  .superRefine((value, context) => {
    if (
      (value.sequence === 1) !== (value.previousDigest === null) ||
      !value.manifest.objectKey.startsWith(`m/v1/${value.vaultId}/${value.manifest.keyVersion}/`)
    )
      context.addIssue({ code: 'custom', message: 'Invalid snapshot chain or vault reference' });
  });
export type BackupSnapshotDescriptor = z.infer<typeof backupSnapshotDescriptorSchema>;
export const backupSnapshotRecordSchema = z.strictObject({
  descriptor: backupSnapshotDescriptorSchema,
  signature: z.string().regex(/^[\w-]{86}$/),
  digest,
  signerJwk: publicKey,
  receivedAt: z.iso.datetime(),
});
export type BackupSnapshotRecord = z.infer<typeof backupSnapshotRecordSchema>;
export const backupRecoveryHistorySchema = z.strictObject({
  pinnedKeys: z.array(publicKey).min(1).max(128),
  snapshots: z.array(backupSnapshotRecordSchema).max(100_000),
  anchor: z.strictObject({ instanceId: z.uuid(), vaultId: z.uuid(), sequence: z.int().positive(), digest }),
});
export type BackupRecoveryHistory = z.infer<typeof backupRecoveryHistorySchema>;

/** FC recovery metadata v2 canonical bytes; keep this order identical to the published contract. */
export const backupSnapshotSigningInput = (input: BackupSnapshotDescriptor): Buffer => {
  const d = backupSnapshotDescriptorSchema.parse(input);
  const m = d.manifest;
  return Buffer.from(
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
          format: m.format,
          formatVersion: m.formatVersion,
          keyVersion: m.keyVersion,
          objectKey: m.objectKey,
          versionId: m.versionId,
          ciphertextSha256: m.ciphertextSha256,
        },
        signerKid: d.signerKid,
      }),
  );
};

export const signBackupSnapshot = (
  descriptor: BackupSnapshotDescriptor,
  signer: FrameleafKeySigner,
): BackupSnapshotRecord => {
  if (!signer.signBytes || descriptor.signerKid !== signer.kid)
    throw new Error('Backup requires the current instance signing identity');
  const bytes = backupSnapshotSigningInput(descriptor);
  return backupSnapshotRecordSchema.parse({
    descriptor,
    signature: signer.signBytes(bytes).toString('base64url'),
    digest: createHash('sha256').update(bytes).digest('hex'),
    signerJwk: { ...signer.publicJwk, kid: signer.kid },
    receivedAt: new Date().toISOString(),
  });
};

export const verifyBackupSnapshot = (
  input: unknown,
  pinnedKeys: BackupRecoveryHistory['pinnedKeys'],
): BackupSnapshotRecord => {
  const record = backupSnapshotRecordSchema.parse(input);
  const pinned = pinnedKeys.find((key) => key.kid === record.descriptor.signerKid && key.x === record.signerJwk.x);
  const bytes = backupSnapshotSigningInput(record.descriptor);
  if (
    !pinned ||
    ed25519Thumbprint(pinned) !== pinned.kid ||
    record.signerJwk.kid !== pinned.kid ||
    createHash('sha256').update(bytes).digest('hex') !== record.digest ||
    !verify(null, bytes, createPublicKey({ key: pinned, format: 'jwk' }), Buffer.from(record.signature, 'base64url'))
  )
    throw new Error('Untrusted backup snapshot');
  return record;
};

/** Remote current heads are hints. Require the exported anchor and every intervening signed predecessor. */
export const selectBackupSnapshot = (input: BackupRecoveryHistory, objectKey?: string) => {
  const history = backupRecoveryHistorySchema.parse(input);
  const records = history.snapshots
    .map((record) => verifyBackupSnapshot(record, history.pinnedKeys))
    .sort((a, b) => a.descriptor.sequence - b.descriptor.sequence);
  const { anchor } = history;
  if (
    new Set(records.map((record) => record.descriptor.sequence)).size !== records.length ||
    new Set(records.map((record) => record.descriptor.snapshotId)).size !== records.length ||
    new Set(records.map((record) => record.descriptor.manifest.objectKey)).size !== records.length ||
    records.some(
      (record) => record.descriptor.instanceId !== anchor.instanceId || record.descriptor.vaultId !== anchor.vaultId,
    )
  )
    throw new Error('Backup snapshot history duplication or substitution');
  const head = records.find((record) => record.descriptor.sequence === anchor.sequence);
  if (!head || head.digest !== anchor.digest)
    throw new Error('Backup rollback, substitution or missing anchored snapshot');
  const selected = objectKey ? records.find((record) => record.descriptor.manifest.objectKey === objectKey) : head;
  if (!selected || selected.descriptor.sequence > anchor.sequence) throw new Error('Backup snapshot is not anchored');
  let previous: BackupSnapshotRecord | undefined;
  for (const record of records) {
    if (record.descriptor.sequence < selected.descriptor.sequence || record.descriptor.sequence > anchor.sequence)
      continue;
    if (
      record.descriptor.instanceId !== anchor.instanceId ||
      record.descriptor.vaultId !== anchor.vaultId ||
      (previous &&
        (record.descriptor.sequence !== previous.descriptor.sequence + 1 ||
          record.descriptor.previousDigest !== previous.digest))
    )
      throw new Error('Backup snapshot history gap or substitution');
    previous = record;
  }
  return {
    record: selected,
    historical: selected.digest !== anchor.digest,
    newerUnanchoredHistory: records.some((record) => record.descriptor.sequence > anchor.sequence),
  };
};

export const readBackupHistory = async (path: string): Promise<BackupRecoveryHistory | null> => {
  try {
    const history = backupRecoveryHistorySchema.parse(JSON.parse(await readFile(path, 'utf8')));
    selectBackupSnapshot(history);
    return history;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

export const writeBackupHistory = async (path: string, history: BackupRecoveryHistory) => {
  selectBackupSnapshot(history);
  await writeBuddyFile(path, JSON.stringify(history, null, 2));
};

/** A second locally supplied kit may advance an anchor, never replace its established history. */
export const mergeBackupHistory = (
  local: BackupRecoveryHistory | null,
  imported?: BackupRecoveryHistory,
): BackupRecoveryHistory | null => {
  if (local) selectBackupSnapshot(local);
  if (imported) selectBackupSnapshot(imported);
  if (!local || !imported) return local ?? imported ?? null;
  const [older, newer] = local.anchor.sequence <= imported.anchor.sequence ? [local, imported] : [imported, local];
  const same = newer.snapshots.find((record) => record.descriptor.sequence === older.anchor.sequence);
  if (
    older.anchor.instanceId !== newer.anchor.instanceId ||
    older.anchor.vaultId !== newer.anchor.vaultId ||
    same?.digest !== older.anchor.digest
  )
    throw new Error('Imported recovery history conflicts with the local anchor');
  selectBackupSnapshot(newer, same.descriptor.manifest.objectKey);
  return newer;
};

export const backupRecoveryPackageSchema = keyEscrowBlobSchema.extend({
  version: z.literal(2),
  vaultId: z.uuid(),
  keyVersion: z.int().positive().max(999_999_999),
});
export type BackupRecoveryPackage = z.infer<typeof backupRecoveryPackageSchema>;

export const appendBackupSnapshot = (
  history: BackupRecoveryHistory | null,
  record: BackupSnapshotRecord,
): BackupRecoveryHistory => {
  const prior = history && selectBackupSnapshot(history).record;
  if (
    record.descriptor.sequence !== (prior?.descriptor.sequence ?? 0) + 1 ||
    record.descriptor.previousDigest !== (prior?.digest ?? null)
  )
    throw new Error('Backup snapshot does not extend trusted history');
  const pinnedKeys = [...(history?.pinnedKeys ?? [])];
  if (pinnedKeys.every((key) => key.kid !== record.signerJwk.kid)) pinnedKeys.push(record.signerJwk);
  const next = {
    pinnedKeys,
    snapshots: [...(history?.snapshots ?? []), record],
    anchor: {
      instanceId: record.descriptor.instanceId,
      vaultId: record.descriptor.vaultId,
      sequence: record.descriptor.sequence,
      digest: record.digest,
    },
  };
  selectBackupSnapshot(next);
  return next;
};

/** Escrow v2 wraps the complete recovery kit, including both histories, under a passphrase, locally. */
export const wrapBackupRecoveryKit = async (file: string, passphrase: string, mode: string) => {
  if (mode !== 'server') throw new Error('Own-key recovery kits must never be escrowed');
  const parsed = JSON.parse(file) as { instanceId: string; client?: unknown; recovery?: unknown };
  const keys = parseClientBackupKeys(parsed.client, parseBackupKey(file), parsed.instanceId);
  if (
    !keys ||
    escrowPassphraseProblem(passphrase) ||
    Buffer.byteLength(passphrase) > 1024 ||
    Buffer.byteLength(file) > 4080
  )
    throw new Error('Invalid recovery kit or passphrase; kits larger than 4080 bytes require a local export');
  if (parsed.recovery) {
    const history = backupRecoveryHistorySchema.parse(parsed.recovery);
    selectBackupSnapshot(history);
    if (history.anchor.vaultId !== keys.vaultId || history.anchor.instanceId !== parsed.instanceId)
      throw new Error('Recovery history belongs to another vault');
  }
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await scryptDerive(passphrase, salt, { ...ESCROW_SCRYPT, keyLength: 32 });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`frameleaf-backup-recovery/2/${keys.vaultId}/${keys.current}`));
    return backupRecoveryPackageSchema.parse({
      version: 2 as const,
      vaultId: keys.vaultId,
      keyVersion: keys.current,
      kdf: { name: 'scrypt' as const, ...ESCROW_SCRYPT, salt: salt.toString('base64') },
      cipher: 'aes-256-gcm' as const,
      nonce: nonce.toString('base64'),
      ciphertext: Buffer.concat([cipher.update(file, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64'),
    });
  } finally {
    key.fill(0);
  }
};
export const unwrapBackupRecoveryKit = async (input: unknown, passphrase: string) => {
  const blob = backupRecoveryPackageSchema.parse(input);
  if (typeof passphrase !== 'string' || Buffer.byteLength(passphrase) > 1024)
    throw new Error('Invalid recovery package');
  const key = await scryptDerive(passphrase, Buffer.from(blob.kdf.salt, 'base64'), { ...ESCROW_SCRYPT, keyLength: 32 });
  try {
    const bytes = Buffer.from(blob.ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.nonce, 'base64'));
    decipher.setAAD(Buffer.from(`frameleaf-backup-recovery/2/${blob.vaultId}/${blob.keyVersion}`));
    decipher.setAuthTag(bytes.subarray(-16));
    const plain = Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
    try {
      const file = plain.toString('utf8');
      const parsed = JSON.parse(file) as { instanceId: string; client?: unknown; recovery?: unknown };
      const keys = parseClientBackupKeys(parsed.client, parseBackupKey(file), parsed.instanceId);
      if (!keys || keys.vaultId !== blob.vaultId || keys.current !== blob.keyVersion)
        throw new Error('Recovery package context mismatch');
      if (parsed.recovery) {
        const history = backupRecoveryHistorySchema.parse(parsed.recovery);
        selectBackupSnapshot(history);
        if (history.anchor.vaultId !== keys.vaultId || history.anchor.instanceId !== parsed.instanceId)
          throw new Error('Recovery history belongs to another vault');
      }
      return file;
    } finally {
      plain.fill(0);
    }
  } finally {
    key.fill(0);
  }
};
