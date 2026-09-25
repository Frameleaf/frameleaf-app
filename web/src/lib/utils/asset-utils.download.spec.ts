import { downloadArchive as requestArchive, downloadAsset as requestAsset, getDownloadInfo } from '@immich/sdk';
import { downloadManager, EmptyDownloadError } from '$lib/managers/download-manager.svelte';
import { downloadArchive, downloadAssetFile } from './asset-utils';

/**
 * FL-45 D-1…D-3: every download — a single file, one archive or a split archive — goes through the
 * download panel's manager, with the SDK calls receiving the row's abort signal.
 */

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getDownloadInfo: vi.fn(),
  downloadArchive: vi.fn(),
  downloadAsset: vi.fn(),
}));

vi.mock('./handle-error', () => ({ handleError: vi.fn() }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const rows = () => [...downloadManager.assets.entries()];

beforeEach(() => {
  vi.clearAllMocks();
  downloadManager.clearAll();
});

describe('downloadArchive', () => {
  it('shows one row at once, then fetches the single archive with an abort signal', async () => {
    vi.mocked(getDownloadInfo).mockResolvedValue({ totalSize: 20, archives: [{ size: 20, assetIds: ['a', 'b'] }] });
    vi.mocked(requestArchive).mockResolvedValue(new Blob(['zip']));

    const started = downloadArchive('trip', { assetIds: ['a', 'b'] });
    expect(rows()).toHaveLength(1);
    expect(rows()[0][1].status).toBe('preparing');
    await started;
    await flush();

    const [, row] = rows()[0];
    expect(row).toMatchObject({ status: 'ready', count: 2, total: 20 });
    expect(row.name).toMatch(/^trip-\d{8}_\d{6}\.zip$/);
    expect(requestArchive).toHaveBeenCalledWith(
      { downloadArchiveDto: { assetIds: ['a', 'b'], archiveName: row.archiveName, edited: true } },
      expect.objectContaining({ signal: expect.any(AbortSignal), fetch: expect.any(Function) }),
    );
  });

  it('adds one row per archive when the plan is split by the archive size limit', async () => {
    vi.mocked(getDownloadInfo).mockResolvedValue({
      totalSize: 30,
      archives: [
        { size: 10, assetIds: ['a'] },
        { size: 20, assetIds: ['b', 'c'] },
      ],
    });
    vi.mocked(requestArchive).mockReturnValue(new Promise(() => {}));

    await downloadArchive('trip', { albumId: 'album-1' });
    await flush();

    const names = rows().map(([, row]) => row.name);
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^trip\+1-/);
    expect(names[1]).toMatch(/^trip\+2-/);
    expect(requestArchive).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed plan as an error row instead of a toast, and plans again on retry', async () => {
    vi.mocked(getDownloadInfo).mockRejectedValueOnce(new Error('offline'));
    await downloadArchive('trip', { assetIds: ['a'] });
    await flush();

    const [key, row] = rows()[0];
    expect(row.status).toBe('error');

    vi.mocked(getDownloadInfo).mockResolvedValue({ totalSize: 1, archives: [{ size: 1, assetIds: ['a'] }] });
    vi.mocked(requestArchive).mockResolvedValue(new Blob(['zip']));
    downloadManager.retry(key);
    await flush();

    expect(downloadManager.assets.get(key)?.status).toBe('ready');
  });

  it('retries only the archive, not the plan, once the plan is known', async () => {
    vi.mocked(getDownloadInfo).mockResolvedValue({
      totalSize: 2,
      archives: [
        { size: 1, assetIds: ['a'] },
        { size: 1, assetIds: ['b'] },
      ],
    });
    vi.mocked(requestArchive)
      .mockRejectedValueOnce(new Error('dropped'))
      .mockResolvedValue(new Blob(['zip']));

    await downloadArchive('trip', { assetIds: ['a', 'b'] });
    await flush();
    const failed = rows().find(([, row]) => row.status === 'error');
    expect(failed).toBeDefined();

    downloadManager.retry(failed![0]);
    await flush();

    expect(getDownloadInfo).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(2);
    expect(rows().every(([, row]) => row.status === 'ready')).toBe(true);
  });

  it('shows "nothing to download" when the plan has no archive', async () => {
    vi.mocked(getDownloadInfo).mockResolvedValue({ totalSize: 0, archives: [] });

    await downloadArchive('trip', { assetIds: [] });
    await flush();

    expect(rows()[0][1].error).toBeInstanceOf(EmptyDownloadError);
  });
});

describe('downloadAssetFile', () => {
  it('fetches one original through the panel under its file name', async () => {
    vi.mocked(requestAsset).mockResolvedValue(new Blob(['jpg']));

    downloadAssetFile({ id: 'asset-1', filename: 'IMG_1.jpg', edited: false, size: 3 });
    await flush();

    expect(requestAsset).toHaveBeenCalledWith(
      { id: 'asset-1', edited: false },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(rows()[0][1]).toMatchObject({ name: 'IMG_1.jpg', count: 1, status: 'ready' });
  });
});
