import {
  type Entry,
  MissingBlobError,
  Repository,
  type Snapshot,
  type Store,
  UnsealError,
  find,
  readFile,
} from '@frameleaf/backup-core';
import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import type { CloudBackupManifest } from 'src/utils/cloud-backup.js';
import {
  CATALOG_PATH,
  CLOUD_BACKUP_CATALOG_MAX_BYTES,
  readCatalog,
  treePathOf,
} from 'src/utils/cloud-backup-catalog.js';

/**
 * Cloud backup's repository in the backup engine (FL-1676): one per server, under `r/v1/<vault id>/` in its
 * bucket. Everything in it is encrypted by the engine with a key made when the repository starts; that key
 * is wrapped by one of this server's backup roots (the recovery keyring), named in the repository's `config`.
 */

/** This server's backup roots: every version it ever used, base64, and which one is current. */
export type VaultKeyring = { current: number; keys: Record<string, string> };

/** Where a vault's objects sit in a bucket. The same for Frameleaf-managed storage and your own bucket. */
export const vaultPrefix = (vaultId: string) => `r/v1/${vaultId}/`;

/** A snapshot's full object name, which is how a backup is named everywhere outside the engine. */
export const snapshotObjectKey = (vaultId: string, key: string) => `${vaultPrefix(vaultId)}${key}`;

const SNAPSHOT_OBJECT =
  /^r\/v1\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\/(s\/(\d{12})-[\da-f]{16,64})$/;

/** The parts of a snapshot's full object name, or null for any other name. */
export const parseSnapshotObjectKey = (
  objectKey: string,
): { vaultId: string; key: string; sequence: number } | null => {
  const match = SNAPSHOT_OBJECT.exec(objectKey);
  return match ? { vaultId: match[1], key: match[2], sequence: Number(match[3]) } : null;
};

/** Why a file could not be read from a backup: it is not in it, or what is stored of it cannot be opened. */
export class VaultFileError extends Error {
  constructor(
    readonly reason: 'missing' | 'damaged',
    readonly key: string,
    options?: ErrorOptions,
  ) {
    super(
      reason === 'missing'
        ? `The backup does not hold ${key}.`
        : `The backup copy of ${key} is damaged or incomplete in storage.`,
      options,
    );
    this.name = 'VaultFileError';
  }
}

const rootOf = (keyring: VaultKeyring, version: string) => {
  const root = keyring.keys[version];
  if (!root) {
    throw new Error('The recovery keyring does not hold the key this backup was made with.');
  }
  const key = Buffer.from(root, 'base64');
  if (key.length !== 32) {
    throw new Error('The recovery keyring holds a key of the wrong length.');
  }
  return key;
};

/** Whether a repository has been started in this storage. */
export const vaultExists = async (store: Store) => (await store.list('config')).some(({ key }) => key === 'config');

/**
 * Opens this server's repository. With `create`, one is started when the storage holds none; otherwise a
 * missing repository is an error, because a restore or a check must never start an empty one.
 */
export async function openVault(
  store: Store,
  keyring: VaultKeyring,
  options: { create?: boolean } = {},
): Promise<Repository> {
  if (!(await vaultExists(store))) {
    if (!options.create) {
      throw new Error('No backup is stored here yet.');
    }
    const keyVersion = String(keyring.current);
    const rootKey = rootOf(keyring, keyVersion);
    try {
      return await Repository.init(store, { rootKey, keyVersion });
    } finally {
      rootKey.fill(0);
    }
  }
  const config = await Repository.readConfig(store);
  const rootKey = rootOf(keyring, config.keyVersion);
  try {
    return await Repository.open(store, { rootKey });
  } catch (error) {
    if (error instanceof UnsealError) {
      throw new Error('This recovery key does not open the backup stored here.', { cause: error });
    }
    throw error;
  } finally {
    rootKey.fill(0);
  }
}

/** The key version whose root wraps the repository key, as a signed record of a backup names it. */
export const vaultKeyVersion = (repository: Repository) => {
  const version = Number(repository.config.keyVersion);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('The backup stored here names no key version.');
  }
  return version;
};

/**
 * A snapshot by its engine key (`s/…`), after checking that the stored object is byte for byte the one
 * this server signed for: `ciphertextSha256` comes from the signed history. Without one (a history that
 * was never exported) the engine's own seal is the only check.
 */
export async function readVaultSnapshot(
  repository: Repository,
  key: string,
  trusted?: { ciphertextSha256: string },
): Promise<Snapshot> {
  if (trusted) {
    const stored = await repository.store.get(key);
    if (createHash('sha256').update(stored).digest('hex') !== trusted.ciphertextSha256) {
      throw new Error('The stored backup is not the one this server recorded. It was not used.');
    }
  }
  try {
    return await repository.readSnapshot(key);
  } catch (error) {
    if (error instanceof UnsealError) {
      throw new Error('This backup cannot be opened with this recovery key.', { cause: error });
    }
    throw error;
  }
}

const fileEntry = async (repository: Repository, snapshot: Snapshot, key: string): Promise<Entry> => {
  const entry = await find(repository, snapshot, treePathOf(key)).catch((error: unknown) => {
    if (error instanceof MissingBlobError || error instanceof UnsealError) {
      throw new VaultFileError('damaged', key, { cause: error });
    }
    throw error;
  });
  if (entry?.type !== 'file') {
    throw new VaultFileError('missing', key);
  }
  return entry;
};

/** A file's content from a snapshot, by its catalog key. The repository's index must be loaded. */
export async function* readVaultFile(
  repository: Repository,
  snapshot: Snapshot,
  key: string,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const entry = await fileEntry(repository, snapshot, key);
  try {
    for await (const chunk of readFile(repository, entry)) {
      signal?.throwIfAborted();
      yield chunk;
    }
  } catch (error) {
    if (error instanceof MissingBlobError || error instanceof UnsealError) {
      throw new VaultFileError('damaged', key, { cause: error });
    }
    throw error;
  }
}

/**
 * Writes one file from a snapshot to `destination`, which must not exist, and answers what was written.
 * The caller compares that with the catalog before the file is moved anywhere it could be mistaken for
 * the original. A file that could not be written whole is removed.
 */
export async function restoreVaultFile(
  repository: Repository,
  snapshot: Snapshot,
  key: string,
  destination: string,
  signal?: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  const file = await open(destination, 'wx', 0o600);
  try {
    for await (const chunk of readVaultFile(repository, snapshot, key, signal)) {
      // writeFile goes on until every byte is written; a bare write may stop short on a full disk
      await file.writeFile(chunk);
      hash.update(chunk);
      size += chunk.length;
    }
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(destination, { force: true });
    throw error;
  }
  await file.close();
  return { size, sha256: hash.digest('hex') };
}

/** The catalog of a snapshot: what it holds and for which items. */
export async function readVaultCatalog(repository: Repository, snapshot: Snapshot): Promise<CloudBackupManifest> {
  const key = CATALOG_PATH.join('/');
  const entry = await fileEntry(repository, snapshot, key);
  if (entry.size > CLOUD_BACKUP_CATALOG_MAX_BYTES) {
    throw new Error('This backup’s catalog is too large to read.');
  }
  const parts: Buffer[] = [];
  for await (const chunk of readVaultFile(repository, snapshot, key)) {
    parts.push(chunk);
  }
  return readCatalog(Buffer.concat(parts));
}
