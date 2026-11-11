import { MediaCreatorItemSort, MediaItemKind, MediaSection, type MediaCreatorItemsDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { creatorsStore } from '$lib/frameleaf/creators-store.svelte';
import CreatorPage from './CreatorPage.svelte';
import { creatorFixture, itemFixture } from './creators.fixture';

const page = (change: Partial<MediaCreatorItemsDto> = {}): MediaCreatorItemsDto => ({
  items: [itemFixture()],
  page: 1,
  hasNextPage: false,
  ...change,
});
const props = (change: Record<string, unknown> = {}) => ({
  creator: creatorFixture(),
  section: null,
  kind: 'all' as const,
  unwatched: false,
  settings: false,
  onView: vi.fn(),
  onOpenItem: vi.fn(),
  ...change,
});
const lastQuery = () => sdkMock.getMediaCreatorItems.mock.calls.at(-1)?.[0];

beforeEach(() => {
  addMessages('dev', en);
  creatorsStore.reset();
  sdkMock.getMediaCreatorItems.mockResolvedValue(page());
  sdkMock.markMediaCreatorSeen.mockResolvedValue(creatorFixture());
});

describe('CreatorPage', () => {
  it('opens on the platform’s first section and records the visit', async () => {
    render(CreatorPage, props());
    await screen.findByRole('button', { name: 'Raising the frame' });
    expect(lastQuery()).toEqual({
      id: 'creator-1',
      section: MediaSection.Video,
      kind: undefined,
      unwatched: undefined,
      q: undefined,
      sort: MediaCreatorItemSort.Newest,
      page: 1,
    });
    expect(sdkMock.markMediaCreatorSeen).toHaveBeenCalledWith({ id: 'creator-1' });
    expect(screen.getByRole('navigation', { name: 'Mara Ellis sections' })).toHaveTextContent(
      'VideosShortsLivePlaylists',
    );
  });

  it('asks the Library for the section, kind and "Not watched yet" in the address', async () => {
    const { rerender } = render(CreatorPage, props({ section: 'shorts', kind: 'video', unwatched: true }));
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ section: MediaSection.Short, kind: MediaItemKind.Video, unwatched: true }),
    );
    expect(screen.getByRole('button', { name: 'Not watched yet' })).toHaveAttribute('aria-pressed', 'true');

    // An account's Videos is a cut of its posts.
    await rerender(props({ creator: creatorFixture({ provider: 'twitter' }), section: 'videos', kind: 'image' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ section: MediaSection.Post, kind: MediaItemKind.Video }));
  });

  it('hands a chosen tab or filter to the address, and sorts, searches and pages itself', async () => {
    sdkMock.getMediaCreatorItems.mockResolvedValue(page({ hasNextPage: true }));
    const onView = vi.fn();
    render(CreatorPage, props({ onView }));
    await screen.findByRole('button', { name: 'Raising the frame' });

    await fireEvent.click(screen.getByRole('button', { name: 'Shorts' }));
    expect(onView).toHaveBeenCalledWith({ section: 'shorts' });
    await fireEvent.click(screen.getByRole('button', { name: 'Pictures' }));
    expect(onView).toHaveBeenCalledWith({ kind: 'image' });
    await fireEvent.click(screen.getByRole('button', { name: 'Not watched yet' }));
    expect(onView).toHaveBeenCalledWith({ unwatched: true });

    await fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), {
      target: { value: MediaCreatorItemSort.Longest },
    });
    await waitFor(() => expect(lastQuery()).toMatchObject({ sort: MediaCreatorItemSort.Longest, page: 1 }));

    await fireEvent.input(screen.getByRole('searchbox', { name: 'Search Mara Ellis' }), {
      target: { value: ' larch ' },
    });
    await waitFor(() => expect(lastQuery()).toMatchObject({ q: 'larch', page: 1 }));

    sdkMock.getMediaCreatorItems.mockResolvedValue(page({ items: [itemFixture({ assetId: 'asset-2' })], page: 2 }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ q: 'larch', page: 2 }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Raising the frame' })).toHaveLength(2));
  });

  it('shows what a site wrote as text, never as markup', async () => {
    const text = '<img src="x" onerror="window.evil()">Quarter-sawn larch';
    sdkMock.getMediaCreatorItems.mockResolvedValue(
      page({
        items: [
          itemFixture({
            kind: MediaItemKind.Image,
            section: MediaSection.Post,
            title: '',
            description: text,
            tags: ['<b>larch</b>'],
            duration: null,
          }),
        ],
      }),
    );
    const creator = creatorFixture({ provider: 'twitter', name: '<i>North</i> Timber', about: '<script>x</script>' });
    const { container } = render(CreatorPage, props({ creator }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByText('#<b>larch</b>')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('<i>North</i> Timber');
    expect(
      container.querySelector(
        ':scope [onerror], :scope script, :scope .cr-post-text img, :scope h1 i, :scope .cr-tags b',
      ),
    ).toBeNull();
  });
});
