import { render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import '$lib/__mocks__/sdk.mock';
import { albumFactory } from '@test-data/factories/album-factory';
import AlbumTile from './AlbumTile.svelte';

/** FL-326 (prototype AlbumCard.jsx): an album partner sharing copied into your library names where it came from. */
describe('AlbumTile', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it("marks an album copied from a partner with the original owner's library", () => {
    const album = albumFactory.build({
      albumName: 'Hikes',
      albumThumbnailAssetId: null,
      origin: { rootOwnerId: 'jamie', rootOwnerName: 'Jamie' },
    });
    render(AlbumTile, { album, currentUserId: 'me' });

    const mark = screen.getByTestId('album-origin-mark');
    expect(mark.getAttribute('title')).toBe("From Jamie's library");
    expect(mark.getAttribute('aria-label')).toBe("From Jamie's library");
  });

  it('shows its name and cover but no count while its numbers are being worked out (FL-1297)', () => {
    const album = albumFactory.build({
      albumName: 'Hikes',
      albumThumbnailAssetId: null,
      assetCount: 0,
      statsPending: true,
      startDate: undefined,
      endDate: undefined,
    });
    render(AlbumTile, { album, currentUserId: 'me' });

    expect(screen.getByRole('article', { name: 'Hikes' })).toBeInTheDocument();
    expect(screen.queryByText('Empty')).toBeNull();
    expect(screen.queryByText(/items?$/)).toBeNull();
  });

  it('shows the count once it has arrived, even when it is zero', () => {
    const album = albumFactory.build({ albumThumbnailAssetId: null, assetCount: 0, startDate: undefined });
    render(AlbumTile, { album, currentUserId: 'me' });
    expect(screen.getByText(/Empty/)).toBeInTheDocument();
  });

  it('shows no mark on your own albums', () => {
    const album = albumFactory.build({ albumThumbnailAssetId: null });
    render(AlbumTile, { album, currentUserId: 'me' });
    expect(screen.queryByTestId('album-origin-mark')).toBeNull();
  });

  it('marks the Recovered Media album and says so under its name (FL-416)', () => {
    const album = albumFactory.build({ albumName: 'Recovered Media', albumThumbnailAssetId: null, recovered: true });
    render(AlbumTile, { album, currentUserId: 'me' });

    const mark = screen.getByTestId('album-recovered-mark');
    expect(mark.getAttribute('aria-label')).toBe('Recovered from your imported library’s folders');
    expect(screen.getByText(/· Recovered$/)).toBeInTheDocument();
  });

  it('shows no recovered mark on other albums', () => {
    const album = albumFactory.build({ albumThumbnailAssetId: null });
    render(AlbumTile, { album, currentUserId: 'me' });
    expect(screen.queryByTestId('album-recovered-mark')).toBeNull();
  });
});
