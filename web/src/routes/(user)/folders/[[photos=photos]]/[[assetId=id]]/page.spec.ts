import { getAssetsByOriginalPath, getFolderSummary } from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { foldersStore } from '$lib/stores/folders.svelte';
import { load } from './+page';

vi.mock('@immich/sdk', () => ({ getAssetsByOriginalPath: vi.fn(), getFolderSummary: vi.fn() }));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));
vi.mock('$lib/utils/i18n', () => ({ getFormatter: async () => (key: string) => key }));
vi.mock('$lib/managers/event-manager.svelte', () => ({ eventManager: { on: vi.fn() } }));

const run = (path?: string) =>
  load({
    url: new URL(`http://localhost/folders${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`),
  } as never);

/** FL-46: the Folders page opens the right folder and never shows stale counts on arrival. */
describe('folders page load', () => {
  beforeEach(() => {
    foldersStore.clearCache();
    vi.clearAllMocks();
    vi.mocked(getFolderSummary).mockResolvedValue([
      { path: '/data/library/2026', count: 2, size: 10 },
      { path: '/data/library/2025/a/b', count: 1, size: 5 },
    ]);
    vi.mocked(getAssetsByOriginalPath).mockResolvedValue([]);
  });

  it('opens the first useful folder on arrival, reloading the tree', async () => {
    const data = await run();
    expect(data.path).toBe('/data/library');
    await run();
    expect(getFolderSummary).toHaveBeenCalledTimes(2);
    // an empty (pass-through) folder has no files to fetch
    expect(getAssetsByOriginalPath).not.toHaveBeenCalled();
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
});
