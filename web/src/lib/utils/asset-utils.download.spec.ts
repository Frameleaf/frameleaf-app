import { downloadArchive as requestArchive, downloadAsset as requestAsset, getDownloadInfo } from '@immich/sdk';
import { downloadManager, EmptyDownloadError, bufferLimit } from '$lib/managers/download-manager.svelte';
import * as utils from '$lib/utils';
import { downloadArchive, downloadAssetFile } from './asset-utils';

/**
 * FL-45 D-1…D-3 and the review's B1: every download goes through the download manager. Parts up to
 * the buffer limit are fetched one at a time with the row's abort signal; larger parts are not
 * fetched, and Save hands them to the browser as a streamed download.
 */

const auth = vi.hoisted(() => ({
  authenticated: false,
  isSharedLink: false,
  params: {} as { key?: string; slug?: string },
}));

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getDownloadInfo: vi.fn(),
  downloadArchive: vi.fn(),
  downloadAsset: vi.fn(),
}));

vi.mock('./handle-error', () => ({ handleError: vi.fn() }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const rows = () => [...downloadManager.assets.entries()];
const never = () => new Promise<Blob>(() => {});
const settle = (promise: Promise<unknown>) => promise.then(() => 'resolved').catch((error: unknown) => error);

const plan = (...sizes: number[]) => ({
  totalSize: sizes.reduce((sum, size) => sum + size, 0),
  archives: sizes.map((size, index) => ({ size, assetIds: [`asset-${index}`] })),
});

let downloadUrl: ReturnType<typeof vi.spyOn>;
let downloadUrlPost: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Spied rather than module-mocked: `$lib/utils` and `asset-utils` import each other.
  downloadUrl = vi.spyOn(utils, 'downloadUrl').mockImplementation(() => {});
  downloadUrlPost = vi.spyOn(utils, 'downloadUrlPost').mockImplementation(() => {});
  downloadManager.clearAll();
  Object.assign(auth, { authenticated: false, isSharedLink: false, params: {} });
});

describe('downloadArchive', () => {
  it('shows one row at once, fetches a small archive with an abort signal, and resolves when ready', async () => {
    vi.mocked(getDownloadInfo).mockResolvedValue(plan(20));
    vi.mocked(requestArchive).mockResolvedValue(new Blob(['zip']));

    const started = settle(downloadArchive('trip', { assetIds: ['asset-0'] }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0][1].status).toBe('preparing');

    expect(await started).toBe('resolved');
    const [, row] = rows()[0];
    expect(row).toMatchObject({ status: 'ready', count: 1, total: 20, buffered: true });
    expect(row.name).toMatch(/^trip-\d{8}_\d{6}\.zip$/);
    expect(requestArchive).toHaveBeenCalledWith(
      { downloadArchiveDto: { assetIds: ['asset-0'], archiveName: row.archiveName, edited: true } },
      expect.objectContaining({ signal: expect.any(AbortSignal), fetch: expect.any(Function) }),
    );
  });

  it('does not fetch an archive above the buffer limit; Save streams it through the browser', async () => {
    vi.mocked(getDownloadInfo).mockResolvedValue(plan(bufferLimit() + 1));

    expect(await settle(downloadArchive('big', { assetIds: ['asset-0'] }))).toBe('resolved');

    const [key, row] = rows()[0];
    expect(requestArchive).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: 'ready', buffered: false });
    expect(downloadManager.hasUnsavedFiles).toBe(false);

    downloadManager.save(key, vi.fn());
    expect(downloadUrlPost).toHaveBeenCalledWith(
      expect.stringMatching(/\/download\/archive$/),
      ['asset-0'],
      row.archiveName,
    );
    expect(rows()).toHaveLength(0);
  });

  it('adds one row per part and fetches buffered parts one at a time', async () => {
    vi.mocked(getDownloadInfo).mockResolvedValue(plan(10, 20, 30));
    const resolvers: Array<(blob: Blob) => void> = [];
    vi.mocked(requestArchive).mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const started = settle(downloadArchive('trip', { albumId: 'album-1' }));
    await flush();

    const names = rows().map(([, row]) => row.name);
    expect(names[0]).toMatch(/^trip\+1-/);
    expect(names[1]).toMatch(/^trip\+2-/);
    expect(names[2]).toMatch(/^trip\+3-/);
    expect(requestArchive).toHaveBeenCalledTimes(1);

    resolvers[0](new Blob(['1']));
    await flush();
    expect(requestArchive).toHaveBeenCalledTimes(2);

    resolvers[1](new Blob(['2']));
    await flush();
    expect(requestArchive).toHaveBeenCalledTimes(3);
    resolvers[2](new Blob(['3']));

    expect(await started).toBe('resolved');
  });

  it('starts no later part when cancelled while the plan loads (M2)', async () => {
    let answer!: (value: ReturnType<typeof plan>) => void;
    vi.mocked(getDownloadInfo).mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);

    const started = settle(downloadArchive('trip', { albumId: 'album-1' }));
    const [key] = rows()[0];
    downloadManager.cancel(key);
    answer(plan(10, 20));
    await flush();

    expect(rows()).toHaveLength(0);
    expect(requestArchive).not.toHaveBeenCalled();
    expect(((await started) as Error).name).toBe('AbortError');
  });

  it('rejects with the failure, keeps an error row and plans again on retry (M3, D-2)', async () => {
    vi.mocked(getDownloadInfo).mockRejectedValueOnce(new Error('offline'));
    expect(((await settle(downloadArchive('trip', { assetIds: ['a'] }))) as Error).message).toBe('offline');

    const [key, row] = rows()[0];
    expect(row.status).toBe('error');

    vi.mocked(getDownloadInfo).mockResolvedValue(plan(1));
    vi.mocked(requestArchive).mockResolvedValue(new Blob(['zip']));
    downloadManager.retry(key);
    await flush();

    expect(downloadManager.assets.get(key)?.status).toBe('ready');
  });

  it('retries a later part without planning again', async () => {
    vi.mocked(getDownloadInfo).mockResolvedValue(plan(1, 1));
    vi.mocked(requestArchive)
      .mockResolvedValueOnce(new Blob(['1']))
      .mockRejectedValueOnce(new Error('dropped'))
      .mockResolvedValue(new Blob(['2']));

    await settle(downloadArchive('trip', { assetIds: ['asset-0', 'asset-1'] }));
    await flush();
    const [laterKey, later] = rows()[1];
    expect(later.status).toBe('error');

    downloadManager.retry(laterKey);
    await flush();

    expect(getDownloadInfo).toHaveBeenCalledTimes(1);
    expect(requestArchive).toHaveBeenCalledTimes(3);
    expect(rows().every(([, row]) => row.status === 'ready')).toBe(true);
  });

  it('shows "nothing to download" when the plan has no archive', async () => {
    vi.mocked(getDownloadInfo).mockResolvedValue({ totalSize: 0, archives: [] });

    await settle(downloadArchive('trip', { assetIds: [] }));

    expect(rows()[0][1].error).toBeInstanceOf(EmptyDownloadError);
  });

  it('passes the share key and slug on a shared link and shows the rows in the share strip', async () => {
    Object.assign(auth, { isSharedLink: true, params: { key: 'share-key', slug: 'share-slug' } });
    vi.mocked(getDownloadInfo).mockResolvedValue(plan(bufferLimit() + 1, 5));
    vi.mocked(requestArchive).mockReturnValue(never());

    void settle(downloadArchive('trip', { assetIds: ['asset-0', 'asset-1'] }));
    await flush();

    expect(getDownloadInfo).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'share-key', slug: 'share-slug' }),
      expect.anything(),
    );
    expect(requestArchive).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'share-key', slug: 'share-slug' }),
      expect.anything(),
    );
    expect(rows().every(([, row]) => row.group === 'share')).toBe(true);
    expect(downloadManager.panelRows).toHaveLength(0);

    downloadManager.save(rows()[0][0], vi.fn());
    expect(downloadUrlPost).toHaveBeenCalledWith(
      expect.stringContaining('key=share-key'),
      ['asset-0'],
      expect.any(String),
    );
  });
});

describe('downloadAssetFile', () => {
  it('fetches a small original through the panel under its file name', async () => {
    vi.mocked(requestAsset).mockResolvedValue(new Blob(['jpg']));

    downloadAssetFile({ id: 'asset-1', filename: 'IMG_1.jpg', edited: false, size: 3 });
    await flush();

    expect(requestAsset).toHaveBeenCalledWith(
      { id: 'asset-1', edited: false },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(rows()[0][1]).toMatchObject({ name: 'IMG_1.jpg', count: 1, status: 'ready', buffered: true });
  });

  it('streams a large original on Save instead of fetching it', async () => {
    const key = downloadAssetFile({ id: 'asset-1', filename: 'movie.mov', edited: true, size: bufferLimit() + 1 });
    await flush();

    expect(requestAsset).not.toHaveBeenCalled();
    downloadManager.save(key, vi.fn());
    expect(downloadUrl).toHaveBeenCalledWith(expect.stringContaining('/assets/asset-1/original'), 'movie.mov');
  });
});
