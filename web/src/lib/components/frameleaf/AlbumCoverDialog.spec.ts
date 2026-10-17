import type { AlbumResponseDto, SearchResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { albumFactory } from '@test-data/factories/album-factory';
import { assetFactory } from '@test-data/factories/asset-factory';
import AlbumCoverDialog from './AlbumCoverDialog.svelte';

const assets = [
  assetFactory.build({ id: 'a1', originalFileName: 'beach.jpg' }),
  assetFactory.build({ id: 'a2', originalFileName: 'sunset.jpg' }),
];

const searchResult = (items = assets) =>
  ({
    assets: { items, count: items.length, total: items.length, facets: [], nextPage: null },
  }) as never as SearchResponseDto;

const renderDialog = (overrides: Partial<AlbumResponseDto> = {}) => {
  const album = albumFactory.build({ id: 'album-1', albumThumbnailAssetId: 'a2', ...overrides });
  const onUpdated = vi.fn();
  render(AlbumCoverDialog, { album, albumIds: [album.id], open: true, onUpdated });
  return { album, onUpdated };
};

const newest = () => screen.getByRole('checkbox', { name: 'Always use the newest item' });
const use = () => screen.getByRole('button', { name: 'Use as cover' });

/**
 * FL-83 (AL-13): the cover dialog's "Always use the newest item", as `CoverDialog` in
 * `design/frameleaf/template/src/CollectionHeader.jsx` (`choice === null` is the newest item).
 */
describe('AlbumCoverDialog', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.searchAssets.mockResolvedValue(searchResult());
  });

  it('starts from the picked cover with "Always use the newest item" off', async () => {
    renderDialog();

    expect(await screen.findByRole('radio', { name: 'sunset.jpg' })).toHaveAttribute('aria-checked', 'true');
    expect(newest()).not.toBeChecked();
  });

  it('starts with "Always use the newest item" on when the cover follows the newest item', async () => {
    renderDialog({ coverFollowsNewest: true });

    expect(await screen.findByRole('radio', { name: 'sunset.jpg' })).toHaveAttribute('aria-checked', 'false');
    expect(newest()).toBeChecked();
  });

  it('saves "Always use the newest item" and reports it', async () => {
    const updated = { ...albumFactory.build({ id: 'album-1' }), coverFollowsNewest: true };
    sdkMock.updateAlbumInfo.mockResolvedValue(updated);
    const { onUpdated } = renderDialog();
    await screen.findByRole('radio', { name: 'sunset.jpg' });

    await fireEvent.click(newest());
    expect(newest()).toBeChecked();
    expect(screen.getByRole('radio', { name: 'sunset.jpg' })).toHaveAttribute('aria-checked', 'false');
    await fireEvent.click(use());

    await waitFor(() =>
      expect(sdkMock.updateAlbumInfo).toHaveBeenCalledWith({
        id: 'album-1',
        updateAlbumDto: { coverFollowsNewest: true },
      }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated));
  });

  it('picking an item turns "Always use the newest item" off and saves that item', async () => {
    sdkMock.updateAlbumInfo.mockResolvedValue(albumFactory.build({ id: 'album-1', albumThumbnailAssetId: 'a1' }));
    renderDialog({ coverFollowsNewest: true });

    await fireEvent.click(await screen.findByRole('radio', { name: 'beach.jpg' }));
    expect(newest()).not.toBeChecked();
    await fireEvent.click(use());

    await waitFor(() =>
      expect(sdkMock.updateAlbumInfo).toHaveBeenCalledWith({
        id: 'album-1',
        updateAlbumDto: { albumThumbnailAssetId: 'a1' },
      }),
    );
  });

  it('turning it off again selects the first item', async () => {
    renderDialog({ coverFollowsNewest: true });
    await screen.findByRole('radio', { name: 'beach.jpg' });

    await fireEvent.click(newest());

    expect(newest()).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'beach.jpg' })).toHaveAttribute('aria-checked', 'true');
    expect(use()).toBeEnabled();
  });

  it('can follow the newest item before an album has any items', async () => {
    sdkMock.searchAssets.mockResolvedValue(searchResult([]));
    renderDialog({ albumThumbnailAssetId: null });

    await screen.findByText('There are no items to choose a cover from yet.');
    expect(newest()).toBeChecked();
    expect(use()).toBeEnabled();
  });
});
