import { getAssetsByOriginalPath, getFolderSummary, type FolderSummaryResponseDto } from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { foldersStore } from '$lib/stores/folders.svelte';

vi.mock('$lib/managers/event-manager.svelte', () => ({
  eventManager: {
    on: vi.fn(),
  },
}));

vi.mock('@immich/sdk', () => ({
  getAssetsByOriginalPath: vi.fn(),
  getFolderSummary: vi.fn(),
}));

describe('foldersStore', () => {
  beforeEach(() => {
    foldersStore.clearCache();
    vi.clearAllMocks();
  });

  it('returns the same non-null tree for concurrent fetchTree calls, from one request', async () => {
    let resolveRows: (value: FolderSummaryResponseDto[]) => void;

    vi.mocked(getFolderSummary).mockReturnValue(
      new Promise<FolderSummaryResponseDto[]>((resolve) => {
        resolveRows = resolve;
      }),
    );

    const first = foldersStore.fetchTree();
    const second = foldersStore.fetchTree();

    resolveRows!([{ path: '/photos/2026', count: 2, size: 10 }]);

    const [firstTree, secondTree] = await Promise.all([first, second]);

    expect(firstTree).not.toBeNull();
    expect(secondTree).toBe(firstTree);
    expect(getFolderSummary).toHaveBeenCalledTimes(1);
    expect(firstTree.byPath.get('/photos')?.count).toBe(2);
  });

  it('keeps the tree until a refresh asks for a new one', async () => {
    vi.mocked(getFolderSummary).mockResolvedValueOnce([{ path: '/a', count: 1, size: 1 }]);
    vi.mocked(getFolderSummary).mockResolvedValueOnce([{ path: '/a', count: 3, size: 1 }]);

    const cached = await foldersStore.fetchTree();
    expect(await foldersStore.fetchTree()).toBe(cached);
    const refreshed = await foldersStore.fetchTree({ refresh: true });

    expect(refreshed.byPath.get('/a')?.count).toBe(3);
    expect(getFolderSummary).toHaveBeenCalledTimes(2);
  });

  it("caches a folder's files until the cache is busted", async () => {
    vi.mocked(getAssetsByOriginalPath).mockResolvedValue([]);

    await foldersStore.fetchAssetsByPath('/a');
    await foldersStore.fetchAssetsByPath('/a');
    expect(getAssetsByOriginalPath).toHaveBeenCalledTimes(1);

    foldersStore.bustAssetCache();
    await foldersStore.fetchAssetsByPath('/a');
    expect(getAssetsByOriginalPath).toHaveBeenCalledTimes(2);
  });

  it("never stores the previous account's tree or files when they arrive after logout", async () => {
    let resolveRows: (value: FolderSummaryResponseDto[]) => void;
    let resolveAssets: (value: []) => void;
    vi.mocked(getFolderSummary).mockReturnValue(
      new Promise<FolderSummaryResponseDto[]>((resolve) => {
        resolveRows = resolve;
      }),
    );
    vi.mocked(getAssetsByOriginalPath).mockReturnValue(
      new Promise<[]>((resolve) => {
        resolveAssets = resolve;
      }),
    );

    const tree = foldersStore.fetchTree();
    const files = foldersStore.fetchAssetsByPath('/a');
    foldersStore.clearCache();
    resolveRows!([{ path: '/private', count: 1, size: 1 }]);
    resolveAssets!([]);
    await Promise.all([tree, files]);

    expect(foldersStore.folders).toBeNull();
    vi.mocked(getAssetsByOriginalPath).mockResolvedValue([]);
    await foldersStore.fetchAssetsByPath('/a');
    expect(getAssetsByOriginalPath).toHaveBeenCalledTimes(2);
  });
});
