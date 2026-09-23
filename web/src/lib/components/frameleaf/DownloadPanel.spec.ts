import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { downloadManager } from '$lib/managers/download-manager.svelte';
import * as utils from '$lib/utils';
import en from '../../../../../i18n/en.json';
import DownloadPanel from './DownloadPanel.svelte';

/**
 * DownloadPanel (FL-45) renders directly off `downloadManager`, the same manager
 * `downloadArchive()` feeds when a download splits into multiple archives — the only
 * production path that keeps an entry around instead of downloading immediately.
 */

beforeEach(() => {
  addMessages('dev', en);
  downloadManager.clearAll();
});

describe('DownloadPanel', () => {
  it('renders nothing while no archive is prepared', () => {
    const { container } = render(DownloadPanel);
    expect(container.querySelector('.fl-panel')).toBeNull();
  });

  it('lists a prepared archive with its size', () => {
    downloadManager.add('my-trip (1/2)', 'https://example.test/download/archive', ['a1', 'a2'], 'my-trip', 2048);

    render(DownloadPanel);

    expect(screen.getByText('my-trip (1/2)')).toBeInTheDocument();
  });

  it('saves through downloadUrlPost and marks the archive downloaded', async () => {
    const downloadUrlPostSpy = vi.spyOn(utils, 'downloadUrlPost').mockImplementation(() => {});
    downloadManager.add('my-trip (1/2)', 'https://example.test/download/archive', ['a1', 'a2'], 'my-trip', 2048);

    render(DownloadPanel);
    await fireEvent.click(screen.getByRole('button', { name: en.download }));

    expect(downloadUrlPostSpy).toHaveBeenCalledWith('https://example.test/download/archive', ['a1', 'a2'], 'my-trip');
    expect(downloadManager.assets.get('my-trip (1/2)')?.downloaded).toBe(true);
  });

  it('removes one archive without clearing the others still waiting', async () => {
    downloadManager.add('first', 'https://example.test/1', ['a1'], 'first', 1024);
    downloadManager.add('second', 'https://example.test/2', ['a2'], 'second', 1024);

    render(DownloadPanel);
    await fireEvent.click(screen.getAllByRole('button', { name: en.frameleaf_transfer_remove_download })[0]);

    expect(downloadManager.assets.has('first')).toBe(false);
    expect(downloadManager.assets.has('second')).toBe(true);
  });
});
