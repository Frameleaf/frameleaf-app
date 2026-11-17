import { type Source, type SourceEntry, type Store, backup, find, memoryStore } from '@frameleaf/backup-core';
import { CATALOG_PATH, treePathOf } from 'src/utils/cloud-backup-catalog.js';
import { type VaultKeyring, openVault, snapshotObjectKey } from 'src/utils/cloud-backup-vault.js';

/**
 * FL-1676: real Cloud Backup backups for service specs. The bucket is a versioned in-memory store (every write
 * gets a version id, as Frameleaf-managed storage does), and a backup is made by the backup engine itself from
 * a catalog and the bytes of the files it names, at their places in the tree.
 */
export const versionedMemoryStore = () => {
  const inner = memoryStore();
  let version = 0;
  const store = {
    ...inner,
    put: async (key: string, body: Buffer) => {
      await inner.put(key, body);
      return { versionId: `v${++version}` };
    },
  };
  return store as Store & { objects: Map<string, Buffer> };
};

export const testKeyring = (): VaultKeyring => ({ current: 1, keys: { 1: Buffer.alloc(32, 42).toString('base64') } });

/** A source made of tree keys and their bytes: every folder on the way is made up. */
const treeSource = (files: Record<string, Buffer>): Source => ({
  // eslint-disable-next-line @typescript-eslint/require-await
  list: async (path) => {
    const prefix = path.length === 0 ? '' : `${path.join('/')}/`;
    const names = new Map<string, SourceEntry>();
    for (const [key, body] of Object.entries(files)) {
      if (!key.startsWith(prefix)) continue;
      const [name, ...rest] = key.slice(prefix.length).split('/');
      names.set(name, {
        name,
        type: rest.length > 0 ? 'dir' : 'file',
        mode: rest.length > 0 ? 0o755 : 0o644,
        uid: 0,
        gid: 0,
        mtime: 0,
        size: rest.length > 0 ? 0 : body.length,
      });
    }
    return names.values().toArray();
  },
  // eslint-disable-next-line @typescript-eslint/require-await
  async *read(path) {
    yield files[path.join('/')];
  },
});

/**
 * Stores one backup and answers its full object name (what `cloud_backup_manifest.key` and the API call it),
 * with what a signed record of it names.
 */
export async function storeTestBackup(
  store: Store,
  options: {
    vaultId: string;
    sequence: number;
    catalog: object;
    /** Every file the catalog names, by its place in the tree (`files/…`, `database/…`). */
    files: Record<string, Buffer>;
    keyring?: VaultKeyring;
    time?: Date;
    /** The random part of the backup's name (16 to 64 hex), when a spec needs to know the name before. */
    snapshotId?: string;
  },
) {
  const repository = await openVault(store, options.keyring ?? testKeyring(), { create: true });
  for (const key of Object.keys(options.files)) treePathOf(key);
  const stored = await backup(
    repository,
    treeSource({ ...options.files, [CATALOG_PATH.join('/')]: Buffer.from(JSON.stringify(options.catalog)) }),
    // one blob per pack, so a spec can break the one pack that holds one file
    { sequence: options.sequence, time: options.time, packTarget: 1, snapshotId: options.snapshotId },
  );
  return {
    key: snapshotObjectKey(options.vaultId, stored.key),
    snapshotKey: stored.key,
    versionId: stored.versionId,
    ciphertextSha256: stored.ciphertextSha256,
  };
}

/** The stored pack that holds a file's first chunk: break it to make reading that one file fail. */
export async function packHolding(store: Store, snapshotKey: string, treeKey: string, keyring = testKeyring()) {
  const repository = await openVault(store, keyring);
  await repository.loadIndex();
  const entry = await find(repository, await repository.readSnapshot(snapshotKey), treePathOf(treeKey));
  const chunk = entry?.chunks?.[0];
  const location = chunk ? repository.index.get(chunk) : undefined;
  if (!location) throw new Error(`No stored chunk for ${treeKey}`);
  return location.pack;
}
