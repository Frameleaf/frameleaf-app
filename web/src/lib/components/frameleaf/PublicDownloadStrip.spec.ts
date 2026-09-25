import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { downloadManager, StreamedDownload } from '$lib/managers/download-manager.svelte';
import * as utils from '$lib/utils';
import en from '../../../../../i18n/en.json';
import PublicDownloadStrip from './PublicDownloadStrip.svelte';

/**
 * The public share page's archive strip (FL-45, `PublicViewer.jsx:402-426`): "Preparing archive ·
 * n of m" with Cancel, then "Archive ready · n files · size" with Save archive.
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const never = () => new Promise<Blob>(() => {});

beforeEach(() => {
  addMessages('dev', en);
  downloadManager.clearAll();
});

describe('PublicDownloadStrip', () => {
  it('renders nothing without a share download, and ignores the Downloads panel rows', () => {
    downloadManager.start({ name: 'mine.zip' }, never);

    const { container } = render(PublicDownloadStrip);

    expect(container.querySelector('.pv-job')).toBeNull();
  });

  it('shows "Preparing archive · n of m" and cancels the request', async () => {
    let signal!: AbortSignal;
    let context!: Parameters<Parameters<typeof downloadManager.start>[1]>[0];
    downloadManager.start({ name: 'a.zip', assetIds: ['1', '2', '3', '4'], total: 400, group: 'share' }, (ctx) => {
      context = ctx;
      signal = ctx.signal;
      return never();
    });
    context.onProgress({ received: 200 });

    render(PublicDownloadStrip);

    expect(screen.getByText('Preparing archive · 2 of 4')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.cancel }));
    expect(signal.aborted).toBe(true);
    expect(downloadManager.assets.size).toBe(0);
  });

  it('offers Save archive once ready and saves the file', async () => {
    const downloadBlob = vi.spyOn(utils, 'downloadBlob').mockImplementation(() => {});
    downloadManager.start({ name: 'a.zip', assetIds: ['1', '2'], total: 2048, group: 'share' }, () =>
      Promise.resolve(new Blob(['zip'])),
    );
    await flush();

    render(PublicDownloadStrip);

    expect(screen.getByText('Archive ready · 2 files · 2 KiB')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_public_save_archive }));
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'a.zip');
    expect(downloadManager.assets.size).toBe(0);
  });

  it('offers Save archive for a ready part while a later part is still being prepared', async () => {
    downloadManager.start({ name: 'a+1.zip', assetIds: ['1'], group: 'share' }, () => Promise.resolve(new Blob(['1'])));
    downloadManager.start({ name: 'a+2.zip', assetIds: ['2'], group: 'share' }, never);
    await flush();

    render(PublicDownloadStrip);

    expect(screen.getByRole('button', { name: en.frameleaf_public_save_archive })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.cancel })).toBeInTheDocument();
    // "Archive ready" leads, without the preparing bar under it.
    expect(screen.getByText(/^Archive ready · 1 file/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it("keeps a failed part's Retry while another part is ready", async () => {
    downloadManager.start({ name: 'a+1.zip', assetIds: ['1'], group: 'share' }, () => Promise.resolve(new Blob(['1'])));
    downloadManager.start({ name: 'a+2.zip', assetIds: ['2'], group: 'share' }, () => Promise.reject(new Error('x')));
    await flush();

    render(PublicDownloadStrip);

    expect(screen.getByRole('button', { name: en.frameleaf_public_save_archive })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.retry })).toBeInTheDocument();
  });

  it('streams a large archive on Save archive', async () => {
    const start = vi.fn();
    downloadManager.start({ name: 'big.zip', assetIds: ['1'], group: 'share' }, () =>
      Promise.resolve(new StreamedDownload(start)),
    );
    await flush();

    render(PublicDownloadStrip);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_public_save_archive }));

    expect(start).toHaveBeenCalledWith('big.zip');
  });

  it('keeps a failure with Retry and Dismiss', async () => {
    downloadManager.start({ name: 'a.zip', group: 'share' }, () => Promise.reject(new Error('offline')));
    await flush();

    render(PublicDownloadStrip);

    expect(screen.getByText(en.frameleaf_transfer_download_error_failed)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.dismiss }));
    expect(downloadManager.assets.size).toBe(0);
  });
});
