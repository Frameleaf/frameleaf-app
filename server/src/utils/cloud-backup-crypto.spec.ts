import { randomBytes } from 'node:crypto';

const vaultId = 'f0000000-0000-4000-8000-000000000001';
const root = randomBytes(32);

describe('independent recovery roots', () => {
  it('rejects a reused legacy root and preserves independent historical roots across rotation', async () => {
    const { addClientBackupKeys, parseClientBackupKeys, rotateClientBackupKeys } =
      await import('src/utils/cloud-backup-crypto.js');
    const original = { key: root.toString('base64'), instanceId: vaultId };
    const prepared = addClientBackupKeys(original);
    expect(prepared.client.keys[1]).not.toBe(original.key);
    const rotated = rotateClientBackupKeys(prepared.client, root);
    expect(rotated.current).toBe(2);
    expect(rotated.keys[1]).toBe(prepared.client.keys[1]);
    expect(rotated.keys[2]).not.toBe(rotated.keys[1]);
    expect(() => parseClientBackupKeys({ vaultId, current: 1, keys: { 1: original.key } }, root, vaultId)).toThrow(
      'independent',
    );
    // FL-1676: a rotated keyring still opens a repository started under its first root
    const { openVault } = await import('src/utils/cloud-backup-vault.js');
    const { memoryStore } = await import('@frameleaf/backup-core');
    const store = memoryStore();
    await openVault(store, prepared.client, { create: true });
    expect((await openVault(store, rotated)).config.keyVersion).toBe('1');
  });
});
