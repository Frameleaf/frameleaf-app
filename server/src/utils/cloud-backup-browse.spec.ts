import { browseBackup, fileVersions } from 'src/utils/cloud-backup-browse.js';
import { openVault } from 'src/utils/cloud-backup-vault.js';
import { storeTestBackup, testKeyring, versionedMemoryStore } from 'test/fixtures/cloud-backup-vault.js';

const VAULT = '0195a1b2-0000-7000-8000-0000000000aa';
const catalog = { format: 'frameleaf-backup-manifest', version: 4, assets: {} };

describe('Cloud Backup browse (FL-1677)', () => {
  const setup = async (...days: Array<Record<string, string>>) => {
    const store = versionedMemoryStore();
    const keys: string[] = [];
    for (const [at, files] of days.entries()) {
      const stored = await storeTestBackup(store, {
        vaultId: VAULT,
        sequence: at + 1,
        catalog,
        time: new Date(Date.UTC(2026, 10, at + 1)),
        files: Object.fromEntries(Object.entries(files).map(([key, body]) => [key, Buffer.from(body)])),
      });
      keys.push(stored.snapshotKey);
    }
    const repository = await openVault(store, testKeyring());
    await repository.loadIndex();
    const snapshots = await Promise.all(
      keys.map(async (key) => ({ key, snapshot: await repository.readSnapshot(key) })),
    );
    return { repository, snapshots };
  };

  it('lists one folder, folders first, names as they are on disk', async () => {
    const { repository, snapshots } = await setup({
      'files/data/library/Taylor/b.jpg': 'bb',
      'files/data/library/Taylor/a%5Cb.jpg': 'a',
      'files/data/library/Taylor/2026/c.jpg': 'ccc',
    });
    await expect(browseBackup(repository, snapshots[0].snapshot, '/data/library/Taylor')).resolves.toEqual([
      { name: '2026', type: 'folder', size: 0, modifiedAt: expect.any(String) },
      { name: String.raw`a\b.jpg`, type: 'file', size: 1, modifiedAt: expect.any(String) },
      { name: 'b.jpg', type: 'file', size: 2, modifiedAt: expect.any(String) },
    ]);
    await expect(browseBackup(repository, snapshots[0].snapshot, '/')).resolves.toEqual([
      expect.objectContaining({ name: 'data', type: 'folder' }),
    ]);
    await expect(browseBackup(repository, snapshots[0].snapshot, '/data/nowhere')).rejects.toThrow();
  });

  it('names each different copy of a file once, newest first, by the first backup that held it', async () => {
    const path = 'files/data/library/a.jpg';
    const { repository, snapshots } = await setup(
      { [path]: 'one' },
      { [path]: 'one' },
      { [path]: 'two!' },
      { 'files/data/library/other.jpg': 'x' },
      { [path]: 'two!' },
    );
    const versions = await fileVersions(repository, snapshots, '/data/library/a.jpg');
    expect(versions.map(({ snapshotKey, size }) => [snapshotKey, size])).toEqual([
      [snapshots[4].key, 4],
      [snapshots[2].key, 4],
      [snapshots[0].key, 3],
    ]);
    await expect(fileVersions(repository, snapshots, '/data/library/none.jpg')).resolves.toEqual([]);
  });
});
