import { randomBytes } from 'node:crypto';
import { BUDDY_UUID } from 'src/utils/buddy-backup-crypto.js';

/**
 * The recovery keyring (FL-525, FL-1676): this server's independent backup roots by version, kept in the
 * recovery key file beside the bucket key. The backup engine's repository key is wrapped by the root its
 * `config` names, so a rotated keyring keeps every earlier root to open what was stored under it.
 */
export type ClientBackupKeys = { vaultId: string; current: number; keys: Record<string, string> };
/** Each root is random and independent of the bucket key, which the claim and the recovery code carry. */
export const parseClientBackupKeys = (input: unknown, legacyRoot: Buffer, vaultId: string): ClientBackupKeys | null => {
  if (input === undefined) return null;
  const ring = input as ClientBackupKeys;
  if (
    !ring ||
    ring.vaultId !== vaultId ||
    !BUDDY_UUID.test(vaultId) ||
    !Number.isSafeInteger(ring.current) ||
    ring.current < 1 ||
    !ring.keys ||
    typeof ring.keys !== 'object' ||
    Array.isArray(ring.keys)
  )
    throw new Error('Invalid client backup keyring');
  const values = Object.entries(ring.keys);
  if (
    values.length === 0 ||
    values.length > 128 ||
    !ring.keys[ring.current] ||
    values.some(
      ([version, value]) =>
        !/^[1-9]\d{0,8}$/.test(version) ||
        typeof value !== 'string' ||
        !/^[\d+/A-Za-z]{43}=$/.test(value) ||
        Buffer.from(value, 'base64').toString('base64') !== value ||
        Buffer.from(value, 'base64').equals(legacyRoot),
    ) ||
    new Set(values.map(([, value]) => value)).size !== values.length
  )
    throw new Error('Client backup roots must be independent of the bucket key and of each other');
  return ring;
};

export const addClientBackupKeys = <T extends { key: string; instanceId: string }>(
  file: T,
): T & { client: ClientBackupKeys } => ({
  ...file,
  client: { vaultId: file.instanceId, current: 1, keys: { 1: randomBytes(32).toString('base64') } },
});

/** Retain every old root for historical reads; only the new independently random root is used for writes. */
export const rotateClientBackupKeys = (ring: ClientBackupKeys, legacyRoot: Buffer): ClientBackupKeys => {
  parseClientBackupKeys(ring, legacyRoot, ring.vaultId);
  const current = Math.max(...Object.keys(ring.keys).map(Number)) + 1;
  const next = { ...ring, current, keys: { ...ring.keys, [current]: randomBytes(32).toString('base64') } };
  return parseClientBackupKeys(next, legacyRoot, ring.vaultId)!;
};
