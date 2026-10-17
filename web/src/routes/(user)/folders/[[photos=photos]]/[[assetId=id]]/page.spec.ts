import { getAssetsByOriginalPath, getFolderSummary, getPartners } from '@frameleaf/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { foldersStore, foldersView } from '$lib/stores/folders.svelte';
import { load } from './+page';

vi.mock('@frameleaf/sdk', () => ({
  getAssetsByOriginalPath: vi.fn(),
  getFolderSummary: vi.fn(),
  getPartners: vi.fn(),
  PartnerDirection: { SharedWith: 'shared-with' },
}));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));
vi.mock('$lib/utils/i18n', () => ({ getFormatter: async () => (key: string) => key }));
vi.mock('$lib/managers/event-manager.svelte', () => ({ eventManager: { on: vi.fn() } }));

const run = (path?: string, assetId?: string) =>
  load({
    url: new URL(`http://localhost/folders${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`),
    params: assetId ? { photos: 'photos', assetId } : {},
  } as never);

const row = (path: string, count: number, size: number) => ({
  path,
  count,
  size,
  coverAssetIds: [`${path}-cover`],
  startDate: '2026-08-02T00:00:00.000Z',
  endDate: '2026-08-09T00:00:00.000Z',
});

/**
 * Columns are offered from 900px. The store asked the test window (the `matchMedia` stub in
 * `test-data/setup.ts`) about that width when it loaded; its answer is as wide as the test says.
 */
const columnsQueries = vi
  .mocked(matchMedia)
  .mock.results.map((result) => result.value as { media: string; matches: boolean })
  .filter((query) => query.media.includes('min-width: 900px'));
const windowIs = (wide: boolean) => {
  for (const query of columnsQueries) {
    query.matches = wide;
  }
};

/** FL-46: the Folders page opens the right folder and never shows stale counts on arrival. */
describe('folders page load', () => {
  beforeEach(() => {
    foldersStore.clearCache();
    foldersView.set({ view: 'grid', fileNames: false });
    windowIs(false);
    vi.clearAllMocks();
    vi.mocked(getFolderSummary).mockResolvedValue([
      row('/data/library/2026', 2, 10),
      row('/data/library/2025/a/b', 1, 5),
    ]);
    vi.mocked(getAssetsByOriginalPath).mockResolvedValue([]);
    vi.mocked(getPartners).mockResolvedValue([]);
  });

  it('opens the top of the browser on arrival, reloading the tree', async () => {
    const data = await run();
    expect(data.path).toBe('/data/library');
    await run();
    expect(getFolderSummary).toHaveBeenCalledTimes(2);
    // an empty (pass-through) folder has no files to fetch
    expect(getAssetsByOriginalPath).not.toHaveBeenCalled();
    expect(data).toMatchObject({ assets: [], assetsFailed: false, assetsDeferred: false });
  });

  it("opens a deep link to a folder and fetches only that folder's files, once", async () => {
    await run();
    const data = await run('/data/library/2026');
    expect(data.path).toBe('/data/library/2026');
    await run('/data/library/2026');
    expect(getAssetsByOriginalPath).toHaveBeenCalledTimes(1);
    expect(getAssetsByOriginalPath).toHaveBeenCalledWith({ path: '/data/library/2026' });
    expect(getFolderSummary).toHaveBeenCalledTimes(1);
  });

  it('opens the nearest remaining folder for one that was emptied or renamed', async () => {
    const data = await run('/data/library/2025/a/b/gone');
    expect(data.path).toBe('/data/library/2025/a/b');
  });

  it('opens the top for an address above it', async () => {
    const data = await run('/');
    expect(data.path).toBe('/data/library');
  });

  it('names the people who share a library with this account, and opens without them', async () => {
    vi.mocked(getPartners).mockResolvedValue([{ id: 'partner-1', name: 'Sam', email: 'sam@example.com' } as never]);
    expect((await run()).partners).toEqual([{ id: 'partner-1', name: 'Sam' }]);

    vi.mocked(getPartners).mockRejectedValue(new Error('offline'));
    const data = await run();
    expect(data.partners).toEqual([]);
    expect(data.assetsFailed).toBe(false);
  });

  it("keeps the page when the folder's files cannot load", async () => {
    vi.mocked(getAssetsByOriginalPath).mockRejectedValue(new Error('offline'));
    const data = await run('/data/library/2026');
    expect(data).toMatchObject({ path: '/data/library/2026', assets: [], assetsFailed: true, assetsDeferred: false });
    expect(data.tree.byPath.get('/data/library/2026')).toMatchObject({ count: 2 });
  });

  it('leaves the files for later in columns, which show a folder from the tree alone', async () => {
    expect(columnsQueries).not.toHaveLength(0);
    windowIs(true);
    foldersView.set({ view: 'columns', fileNames: false });
    const data = await run('/data/library/2026');
    expect(getAssetsByOriginalPath).not.toHaveBeenCalled();
    expect(data).toMatchObject({ assets: [], assetsFailed: false, assetsDeferred: true });
    // a folder with nothing of its own has nothing to leave for later
    expect(await run('/data/library')).toMatchObject({ assetsDeferred: false });
  });

  it('fetches the files in columns when the address opens one of them in the viewer', async () => {
    windowIs(true);
    foldersView.set({ view: 'columns', fileNames: false });
    const data = await run('/data/library/2026', 'asset-1');
    expect(getAssetsByOriginalPath).toHaveBeenCalledWith({ path: '/data/library/2026' });
    expect(data.assetsDeferred).toBe(false);
  });

  it('fetches the files where columns do not fit, whatever was chosen on a wider window', async () => {
    windowIs(false);
    foldersView.set({ view: 'columns', fileNames: false });
    const data = await run('/data/library/2026');
    expect(getAssetsByOriginalPath).toHaveBeenCalledTimes(1);
    expect(data.assetsDeferred).toBe(false);
  });
});
