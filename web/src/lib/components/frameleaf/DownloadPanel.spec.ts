import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { downloadManager, EmptyDownloadError } from '$lib/managers/download-manager.svelte';
import * as utils from '$lib/utils';
import en from '../../../../../i18n/en.json';
import DownloadPanel from './DownloadPanel.svelte';

/**
 * DownloadPanel (FL-45 D-1…D-5) renders off `downloadManager`, which `downloadArchive()` and
 * `downloadAssetFile()` feed for every download. The tasks here stand in for the real requests.
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const never = () => new Promise<Blob>(() => {});

beforeEach(() => {
  addMessages('dev', en);
  downloadManager.clearAll();
});

describe('DownloadPanel', () => {
  it('renders nothing while there is no download', () => {
    const { container } = render(DownloadPanel);
    expect(container.querySelector('.fl-panel')).toBeNull();
  });

  it('shows a preparing download with progress, Cancel and the prototype title (D-1, D-4)', () => {
    downloadManager.start({ name: 'Frameleaf-3-items.zip', assetIds: ['a', 'b', 'c'], total: 3 * 1024 * 1024 }, never);

    render(DownloadPanel);

    expect(screen.getByRole('region', { name: 'Downloads' })).toBeInTheDocument();
    expect(screen.getByText('Preparing 1 download')).toBeInTheDocument();
    expect(screen.getByText('Frameleaf-3-items.zip')).toBeInTheDocument();
    expect(screen.getByText(/^3 items · 3 MiB · 0%$/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Frameleaf-3-items.zip progress' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
    expect(screen.getByRole('button', { name: en.cancel })).toBeInTheDocument();
    expect(screen.queryByText('Prepared Archives')).toBeNull();
  });

  it('hides Close while a download is being prepared (D-5)', () => {
    downloadManager.start({ name: 'a.zip' }, never);

    render(DownloadPanel);

    expect(screen.queryByRole('button', { name: en.frameleaf_transfer_close_downloads })).toBeNull();
  });

  it('cancels a preparing download by aborting its request (D-1)', async () => {
    let signal!: AbortSignal;
    downloadManager.start({ name: 'a.zip' }, (context) => {
      signal = context.signal;
      return never();
    });

    render(DownloadPanel);
    await fireEvent.click(screen.getByRole('button', { name: en.cancel }));

    expect(signal.aborted).toBe(true);
    expect(screen.queryByText('a.zip')).toBeNull();
  });

  it('offers Save once ready and saves the file through the browser', async () => {
    const downloadBlob = vi.spyOn(utils, 'downloadBlob').mockImplementation(() => {});
    downloadManager.start({ name: 'photo.jpg', assetIds: ['a'], total: 2048 }, () => Promise.resolve(new Blob(['x'])));
    await flush();

    render(DownloadPanel);
    expect(screen.getByText('1 download ready')).toBeInTheDocument();
    expect(screen.getByText(/^1 item · 2 KiB · Ready$/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.save }));

    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'photo.jpg');
    expect(downloadManager.assets.size).toBe(0);
  });

  it('keeps a failed download as a row with Retry and Dismiss (D-2)', async () => {
    let attempts = 0;
    downloadManager.start({ name: 'a.zip' }, () => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error('offline')) : never();
    });
    await flush();

    render(DownloadPanel);
    expect(screen.getByText(en.frameleaf_transfer_download_error_failed)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.retry }));

    expect(attempts).toBe(2);
    expect(screen.getByText('Preparing 1 download')).toBeInTheDocument();
  });

  it('dismisses a failed download', async () => {
    downloadManager.start({ name: 'empty.zip' }, () => Promise.reject(new EmptyDownloadError()));
    await flush();

    render(DownloadPanel);
    expect(screen.getByText(en.frameleaf_transfer_download_error_empty)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.dismiss }));

    expect(downloadManager.assets.size).toBe(0);
  });

  it('leaves out the rows of a public share page, which its strip shows', () => {
    downloadManager.start({ name: 'shared.zip', group: 'share' }, never);

    const { container } = render(DownloadPanel);

    expect(container.querySelector('.fl-panel')).toBeNull();
  });

  it('asks before the tab closes while a prepared file is unsaved (B1)', async () => {
    const { unmount } = render(DownloadPanel);
    const idle = new Event('beforeunload', { cancelable: true });
    dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);

    downloadManager.start({ name: 'photo.jpg' }, () => Promise.resolve(new Blob(['x'])));
    await flush();
    const unsaved = new Event('beforeunload', { cancelable: true });
    dispatchEvent(unsaved);
    expect(unsaved.defaultPrevented).toBe(true);
    unmount();
  });

  it('closes when nothing is being prepared', async () => {
    downloadManager.start({ name: 'a.jpg' }, () => Promise.resolve(new Blob(['x'])));
    await flush();

    render(DownloadPanel);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_transfer_close_downloads }));

    expect(downloadManager.assets.size).toBe(0);
  });
});
