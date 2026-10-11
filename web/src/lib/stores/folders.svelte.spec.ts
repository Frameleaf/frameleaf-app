import { getAssetsByOriginalPath, getFolderSummary, type FolderSummaryResponseDto } from '@frameleaf/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { foldersStore } from '$lib/stores/folders.svelte';

vi.mock('$lib/managers/event-manager.svelte', () => ({
  eventManager: {
    on: vi.fn(),
  },
}));

vi.mock('@frameleaf/sdk', () => ({
  getAssetsByOriginalPath: vi.fn(),
  getFolderSummary: vi.fn(),
}));

const row = (path: string, count: number, size: number): FolderSummaryResponseDto => ({
  path,
  count,
  size,
  coverAssetIds: [`${path}-cover`],
  startDate: '2026-08-02T00:00:00.000Z',
  endDate: '2026-08-09T00:00:00.000Z',
});

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

    resolveRows!([row('/photos/2026', 2, 10)]);

    const [firstTree, secondTree] = await Promise.all([first, second]);

    expect(firstTree).not.toBeNull();
    expect(secondTree).toBe(firstTree);
    expect(getFolderSummary).toHaveBeenCalledTimes(1);
    expect(firstTree.byPath.get('/photos')?.count).toBe(2);
    // a folder with only subfolders takes its cover and dates from below
    expect(firstTree.byPath.get('/photos')).toMatchObject({
      coverAssetIds: ['/photos/2026-cover'],
      startDate: '2026-08-02T00:00:00.000Z',
      endDate: '2026-08-09T00:00:00.000Z',
    });
  });

  it('keeps the tree until a refresh asks for a new one', async () => {
    vi.mocked(getFolderSummary).mockResolvedValueOnce([row('/a', 1, 1)]);
    vi.mocked(getFolderSummary).mockResolvedValueOnce([row('/a', 3, 1)]);

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
    resolveRows!([row('/private', 1, 1)]);
    resolveAssets!([]);
    await Promise.all([tree, files]);

    expect(foldersStore.folders).toBeNull();
    vi.mocked(getAssetsByOriginalPath).mockResolvedValue([]);
    await foldersStore.fetchAssetsByPath('/a');
    expect(getAssetsByOriginalPath).toHaveBeenCalledTimes(2);
  });
});
