import { memoryEagleImportStore, type EagleImportRecord } from '$lib/frameleaf/eagle/eagle-import-record';

const record = (key: string, ownerId: string): EagleImportRecord => ({
  key,
  ownerId,
  libraryName: `${key} library`,
  target: { mode: 'top' },
  albums: { folder: 'album-1' },
  tagIds: { Sky: 'tag-1' },
  total: 2,
  status: 'running',
  startedAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
});

/** FL-1771: a sign-in clears the Eagle import records another account left in this browser. */
describe('Eagle import records of other accounts', () => {
  it("removes other accounts' records and outcomes, keeping this account's resumable", async () => {
    const store = memoryEagleImportStore();
    await store.save(record('mine', 'user-1'));
    await store.save(record('theirs', 'user-2'));
    await store.saveOutcome('mine', 'item-1', { assetId: 'asset-1', duplicate: false });
    await store.saveOutcome('theirs', 'item-2', { assetId: 'asset-2', duplicate: false });

    await store.removeOtherAccounts('user-1');

    expect(await store.get('theirs')).toBeUndefined();
    expect(await store.unfinished('user-2')).toEqual([]);
    const mine = await store.get('mine');
    expect(mine?.record.ownerId).toBe('user-1');
    expect(mine?.outcomes).toEqual({ 'item-1': { assetId: 'asset-1', duplicate: false } });
    expect(await store.unfinished('user-1')).toHaveLength(1);
  });
});
