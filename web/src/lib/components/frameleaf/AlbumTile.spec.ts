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

  it('shows no mark on your own albums', () => {
    const album = albumFactory.build({ albumThumbnailAssetId: null });
    render(AlbumTile, { album, currentUserId: 'me' });
    expect(screen.queryByTestId('album-origin-mark')).toBeNull();
  });
});
