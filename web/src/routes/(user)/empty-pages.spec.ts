import { render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ArchivePage from './archive/[[photos=photos]]/[[assetId=id]]/+page.svelte';
import BestPhotosPage from './best-photos/[[photos=photos]]/[[assetId=id]]/+page.svelte';
import FavoritesPage from './favorites/[[photos=photos]]/[[assetId=id]]/+page.svelte';
import LockedPage from './locked/[[photos=photos]]/[[assetId=id]]/+page.svelte';

/**
 * FL-1412 (M13): what Favorites and Best Photos give the library view to show when they have nothing:
 * the one empty-page pattern, with the prototype's words and no action. That the view then drops its
 * toolbar and Thumbnail size bar is LibraryView's own rule (LibraryView.spec.ts).
 */
vi.mock(
  '$lib/components/layouts/UserPageLayout.svelte',
  async () => import('@test-data/mocks/UserPageLayout.mock.svelte'),
);
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/locked') } }));
vi.mock('$lib/components/frameleaf/settings/security/locked-encryption/LockedKeyCheck.svelte', () => ({
  default: () => {},
}));
vi.mock(
  '$lib/components/frameleaf/LibraryView.svelte',
  async () => import('@test-data/components/AlbumLibraryFixture.svelte'),
);

describe('empty library pages', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => sdkMock.getBestPhotos.mockResolvedValue({ items: [] } as never));

  const expectEmptyPage = (heading: string, body: string) => {
    const empty = within(screen.getByTestId('library-empty-slot')).getByTestId('frameleaf-empty-state');
    expect(within(empty).getByRole('heading', { level: 2, name: heading })).toBeInTheDocument();
    expect(empty.querySelector('p')).toHaveTextContent(body);
    expect(empty.firstElementChild).toHaveClass('icon', 'framed');
    expect(empty.querySelector('button, a')).toBeNull();
  };

  it('Favorites says what will be here and how it gets here, and offers nothing', () => {
    render(FavoritesPage, { data: { meta: { title: 'Favorites' } } as never });
    expectEmptyPage('No favorites yet', 'Mark a photo with the heart and it appears here.');
  });

  it('Best Photos says what will be here and how it gets here, and offers nothing', () => {
    render(BestPhotosPage, { data: { meta: { title: 'Best Photos' } } as never });
    expectEmptyPage(
      'No best photos yet',
      'Your strongest photos appear here once your library has been looked through.',
    );
  });

  // FL-1457 (N6, N7): Archive and Locked on the pattern, with the words the owner approved.
  it('Archive says nothing is archived and where archived items go', () => {
    render(ArchivePage, { data: { meta: { title: 'Archive' } } as never });
    expectEmptyPage('Nothing archived', 'Photos and videos you archive leave your library and wait here.');
  });

  it('Locked, unlocked and empty, says nothing is locked yet and that the PIN guards it', () => {
    render(LockedPage, { data: { meta: { title: 'Locked' }, unlocked: true } as never });
    expectEmptyPage('Nothing locked yet', 'Photos you lock show here, and only after you enter your PIN.');
  });
});
