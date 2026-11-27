import type { ServerConfigDto, SharedLinkPageResponseDto } from '@frameleaf/sdk';
import {
  getAllAlbums,
  getSharedLinkById,
  getSharedLinkPage,
  removeSharedLink,
  searchAssets,
  SharedLinkType,
} from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { replaceState } from '$app/navigation';
import { sharedLinkFactory } from '$lib/../test-data/factories/shared-link-factory';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { copyToClipboard, getAssetMediaUrl } from '$lib/utils';
import { handleError } from '$lib/utils/handle-error';
import en from '../../../../../i18n/en.json';
import SharedLinkList from './SharedLinkList.svelte';

vi.mock('$lib/utils');
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  getSharedLinkPage: vi.fn(),
  getSharedLinkById: vi.fn(),
  getAllAlbums: vi.fn(),
  removeSharedLink: vi.fn(),
  searchAssets: vi.fn(),
}));
const pageState = vi.hoisted(() => ({ url: new URL('http://localhost/shared-links') }));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return pageState.url;
    },
    state: {},
  },
}));
vi.mock('$app/navigation', () => ({
  replaceState: vi.fn(async (url: URL) => {
    pageState.url = new URL(url);
  }),
}));
vi.mock(import('$lib/managers/server-config-manager.svelte'), () => ({
  serverConfigManager: {
    value: { externalDomain: 'http://localhost:2283' } as ServerConfigDto,
    ready: vi.fn(),
    init: vi.fn(),
    loadServerConfig: vi.fn(),
  },
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

type Link = ReturnType<typeof sharedLinkFactory.build>;
const pageOf = (links: Link[], more: Partial<SharedLinkPageResponseDto> = {}): SharedLinkPageResponseDto => ({
  links,
  nextCursor: null,
  albumCount: links.filter(({ type }) => type === SharedLinkType.Album).length,
  individualCount: links.filter(({ type }) => type === SharedLinkType.Individual).length,
  ...more,
});
/** What the server lists, as one page holding everything. */
const serverLinks = {
  mockResolvedValue: (links: Link[]) => vi.mocked(getSharedLinkPage).mockResolvedValue(pageOf(links)),
  mockRejectedValue: (error: unknown) => vi.mocked(getSharedLinkPage).mockRejectedValue(error),
};

beforeEach(() => {
  vi.clearAllMocks();
  pageState.url = new URL('http://localhost/shared-links');
  addMessages('dev', en);
});

describe('SharedLinkList', () => {
  it('lists real shared links from the server and never shows the raw password value', async () => {
    const link = sharedLinkFactory.build({
      type: SharedLinkType.Individual,
      assets: [{ id: 'a1', originalFileName: 'beach.jpg' } as never],
      assetCount: 1,
      coverAssetIds: ['a1'],
      password: 'super-secret',
      description: 'Family photos',
    });
    serverLinks.mockResolvedValue([link]);

    render(SharedLinkList);

    expect(await screen.findByText('beach.jpg')).toBeInTheDocument();
    expect(screen.queryByText('super-secret')).toBeNull();
    expect(screen.getByText(en.password)).toBeInTheDocument();
  });

  it('deletes a link through the real endpoint after confirmation', async () => {
    const link = sharedLinkFactory.build({
      type: SharedLinkType.Album,
      album: { id: 'album-1', albumName: 'Rockies' } as never,
      assets: [],
      password: null,
    });
    serverLinks.mockResolvedValue([link]);
    vi.mocked(removeSharedLink).mockResolvedValue(undefined as never);

    render(SharedLinkList);
    await screen.findByText('Rockies');

    await fireEvent.click(screen.getByRole('button', { name: en.delete }));
    // AL-22: the prototype's delete dialog says who loses access and what is kept.
    const dialog = await screen.findByRole('dialog', { name: en.delete_shared_link });
    expect(dialog).toHaveTextContent(
      'Anyone using the link for Rockies loses access immediately. Your photos and the album itself are not affected.',
    );
    // As every Frameleaf confirmation: Cancel takes focus first, so Enter on open never deletes, the
    // destructive action is the filled danger button, and both sit in the dialog's footer.
    expect(within(dialog).getByRole('button', { name: en.cancel })).toHaveFocus();
    expect(screen.getByRole('button', { name: en.delete_link })).toHaveClass('fl-danger');
    expect(screen.getByRole('button', { name: en.delete_link }).closest('footer')).not.toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: en.delete_link }));

    await waitFor(() => expect(removeSharedLink).toHaveBeenCalledWith({ id: link.id }));
    await waitFor(() => expect(screen.queryByText('Rockies')).toBeNull());
  });

  it('shows the empty state distinct from the no-results state', async () => {
    serverLinks.mockResolvedValue([]);
    render(SharedLinkList);
    expect(await screen.findByText(en.frameleaf_sharing.empty_links_title)).toBeInTheDocument();
  });

  it('opens the edit form for ?edit= (the old edit address) and drops the parameter', async () => {
    const link = sharedLinkFactory.build({ type: SharedLinkType.Individual, assets: [] });
    serverLinks.mockResolvedValue([link]);
    pageState.url = new URL(`http://localhost/shared-links?edit=${link.id}`);

    render(SharedLinkList);

    expect(
      await screen.findByRole('heading', { name: en.frameleaf_sharing.edit_shared_link_title }),
    ).toBeInTheDocument();
    expect(pageState.url.searchParams.has('edit')).toBe(false);
    expect(getSharedLinkById).not.toHaveBeenCalled();
  });

  it('asks for a link missing from the list by id, and says so when it does not exist', async () => {
    const warning = vi.spyOn(toastManager, 'warning').mockImplementation(() => undefined as never);
    serverLinks.mockResolvedValue([]);
    vi.mocked(getSharedLinkById).mockRejectedValue(new Error('not found'));
    pageState.url = new URL('http://localhost/shared-links?edit=missing-id');

    render(SharedLinkList);

    await waitFor(() => expect(getSharedLinkById).toHaveBeenCalledWith({ id: 'missing-id' }));
    await waitFor(() => expect(warning).toHaveBeenCalledWith(en.frameleaf_sharing.link_not_found));
    expect(screen.queryByRole('heading', { name: en.frameleaf_sharing.edit_shared_link_title })).toBeNull();
  });

  it('opens with the prototype intro copy (AL-19)', async () => {
    serverLinks.mockResolvedValue([]);
    render(SharedLinkList);
    expect(await screen.findByText(en.frameleaf_sharing.links_intro)).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys, Home and End, keeping one tab stop (AL-20)', async () => {
    serverLinks.mockResolvedValue([
      sharedLinkFactory.build({
        type: SharedLinkType.Album,
        album: { id: 'a', albumName: 'Rockies' } as never,
        assets: [],
      }),
      sharedLinkFactory.build({
        type: SharedLinkType.Individual,
        assets: [{ id: 'x', originalFileName: 'beach.jpg' } as never],
        assetCount: 1,
        coverAssetIds: ['x'],
      }),
    ]);
    render(SharedLinkList);
    await screen.findByText('Rockies');

    const [all, albums, individual] = screen.getAllByRole('tab');
    expect(all).toHaveAttribute('aria-selected', 'true');
    expect([all, albums, individual].map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);

    all.focus();
    await fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(albums).toHaveAttribute('aria-selected', 'true');
    expect(albums).toHaveFocus();
    expect([all, albums, individual].map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(screen.queryByText('beach.jpg')).toBeNull();

    await fireEvent.keyDown(albums, { key: 'End' });
    expect(individual).toHaveAttribute('aria-selected', 'true');
    expect(individual).toHaveFocus();
    expect(screen.getByText('beach.jpg')).toBeInTheDocument();

    await fireEvent.keyDown(individual, { key: 'ArrowRight' });
    expect(all).toHaveAttribute('aria-selected', 'true');
    await fireEvent.keyDown(all, { key: 'ArrowLeft' });
    expect(individual).toHaveAttribute('aria-selected', 'true');
    await fireEvent.keyDown(individual, { key: 'Home' });
    expect(all).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'sl-tab-all');
  });

  it('marks each link with its expiry, password, download, upload and metadata badges (AL-21)', async () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    serverLinks.mockResolvedValue([
      sharedLinkFactory.build({
        type: SharedLinkType.Album,
        album: { id: 'open', albumName: 'Open link' } as never,
        assets: [],
        password: 'x',
        allowDownload: true,
        allowUpload: true,
        showMetadata: true,
        expiresAt: soon,
        description: '',
      }),
      sharedLinkFactory.build({
        type: SharedLinkType.Album,
        album: { id: 'old', albumName: 'Old link' } as never,
        assets: [],
        password: null,
        allowDownload: false,
        allowUpload: false,
        showMetadata: false,
        expiresAt: past,
      }),
    ]);
    render(SharedLinkList);
    await screen.findByText('Open link');

    const [open, old] = screen.getAllByRole('list', { name: en.frameleaf_sharing.link_details });
    expect([...open.querySelectorAll('li')].map((item) => item.textContent?.trim())).toEqual([
      en.password,
      en.frameleaf_sharing.badge_downloads,
      en.frameleaf_sharing.badge_uploads,
      en.frameleaf_sharing.badge_metadata,
      'Expires in 3 days',
    ]);
    expect(open.querySelector('[data-tone="info"]')).toHaveTextContent('Expires in 3 days');
    expect(old.querySelector('[data-tone="danger"]')).toHaveTextContent(en.expired);
    expect(screen.getByText(en.frameleaf_sharing.no_description)).toBeInTheDocument();
    // An album link opens the album itself; the public page opens from its own action.
    expect(screen.getByRole('link', { name: 'Open album Open link' })).toHaveAttribute('href', '/albums/open');
    expect(screen.getByRole('button', { name: 'Open public page for Open link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link for Open link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'QR code for Open link' })).toBeInTheDocument();
  });

  it('offers the image link only on a link that has one (FL-788)', async () => {
    const photo = sharedLinkFactory.build({
      type: SharedLinkType.Individual,
      description: 'Lake morning',
      expiresAt: null,
      directUrl: '/api/shared-links/direct/lake-morning.jpg',
    });
    const album = sharedLinkFactory.build({ type: SharedLinkType.Individual, description: 'Two photos' });
    serverLinks.mockResolvedValue([photo, album]);
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    render(SharedLinkList);
    await screen.findByText('Lake morning');

    // each card's button is named for its own link, like Copy link beside it
    const buttons = screen.getAllByRole('button', { name: /^Copy image link for / });
    expect(buttons).toHaveLength(1);
    await fireEvent.click(buttons[0]);

    expect(copyToClipboard).toHaveBeenCalledWith('http://localhost:2283/api/shared-links/direct/lake-morning.jpg');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/^Image link for .+ copied\.$/));
  });

  describe('card covers (AL-21)', () => {
    const items = (...ids: string[]) => ids.map((id) => ({ id, originalFileName: `${id}.jpg` }) as never);
    /** A selection as the server lists it: its first four items, the same four for its cover, and its real count. */
    const selectionOf = (ids: string[], overrides: Parameters<typeof sharedLinkFactory.build>[0] = {}) =>
      sharedLinkFactory.build({
        type: SharedLinkType.Individual,
        assets: items(...ids.slice(0, 4)),
        assetCount: ids.length,
        coverAssetIds: ids.slice(0, 4),
        ...overrides,
      });
    const cardOf = (title: string) => screen.getByRole('heading', { name: title }).closest('li') as HTMLElement;
    const pictures = (card: HTMLElement) => [...card.querySelectorAll('img')].map((image) => image.getAttribute('src'));

    beforeEach(() => {
      vi.mocked(getAssetMediaUrl).mockImplementation(({ id }) => `/thumbnail/${id}`);
    });

    it('fills every cover and count from the one list of links, with no read per link', async () => {
      const album = sharedLinkFactory.build({
        type: SharedLinkType.Album,
        album: { id: 'album-1', albumName: 'Rockies', albumThumbnailAssetId: 'cover', assetCount: 15 } as never,
        assets: [],
        assetCount: 15,
        coverAssetIds: ['cover', 'n1', 'n2', 'n3'],
      });
      serverLinks.mockResolvedValue([album, selectionOf(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])]);

      render(SharedLinkList);

      const albumCard = await waitFor(() => cardOf('Rockies'));
      expect(pictures(albumCard)).toEqual(['/thumbnail/cover', '/thumbnail/n1', '/thumbnail/n2', '/thumbnail/n3']);
      expect(within(albumCard).getByText('+11')).toBeInTheDocument();
      // A selection is titled by how many items it shares, not by the few the list carries.
      const selectionCard = cardOf('6 items');
      expect(pictures(selectionCard)).toEqual(['/thumbnail/a1', '/thumbnail/a2', '/thumbnail/a3', '/thumbnail/a4']);
      expect(within(selectionCard).getByText('+2')).toBeInTheDocument();

      expect(getSharedLinkPage).toHaveBeenCalledTimes(1);
      expect(getSharedLinkById).not.toHaveBeenCalled();
      expect(searchAssets).not.toHaveBeenCalled();
    });

    it('fills the cover with the one photo of a single-photo share', async () => {
      serverLinks.mockResolvedValue([selectionOf(['beach'])]);

      render(SharedLinkList);

      const card = await waitFor(() => cardOf('beach.jpg'));
      expect(pictures(card)).toEqual(['/thumbnail/beach']);
      expect(card.querySelector('.fl-collage')).toHaveAttribute('data-count', '1');
      expect(within(card).queryByText(/^\+\d/)).toBeNull();
    });

    it('names a one-photo share after the photo it shows, not after an item that is not counted', async () => {
      // Two items came back, but only one is shared with viewers (the other is in the trash, say).
      serverLinks.mockResolvedValue([
        selectionOf(['beach'], { assets: items('old', 'beach'), assetCount: 1, coverAssetIds: ['beach'] }),
      ]);

      render(SharedLinkList);

      const card = await waitFor(() => cardOf('beach.jpg'));
      expect(pictures(card)).toEqual(['/thumbnail/beach']);
    });

    it('keeps the "Expired" flag on an expired link, over its cover', async () => {
      serverLinks.mockResolvedValue([
        selectionOf(['beach'], { expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }),
      ]);

      render(SharedLinkList);

      const card = await waitFor(() => cardOf('beach.jpg'));
      expect(card).toHaveAttribute('data-expired');
      const cover = within(card).getByRole('link');
      expect(within(cover).getByText(en.expired)).toBeInTheDocument();
      expect(pictures(card)).toEqual(['/thumbnail/beach']);
    });

    it('shows an empty cover, and no count badge, for a link with nothing to show', async () => {
      serverLinks.mockResolvedValue([selectionOf([])]);

      render(SharedLinkList);

      const card = await waitFor(() => cardOf('0 items'));
      expect(pictures(card)).toEqual([]);
      expect(card.querySelector('.fl-collage')).toHaveAttribute('data-count', '0');
      expect(within(card).queryByText(/^\+\d/)).toBeNull();
    });
  });

  it('opens the public page in a new tab from the card (AL-21)', async () => {
    const open = vi.spyOn(globalThis, 'open').mockImplementation(() => null);
    const link = sharedLinkFactory.build({
      type: SharedLinkType.Album,
      album: { id: 'album-1', albumName: 'Rockies' } as never,
      assets: [],
      slug: 'rockies',
    });
    serverLinks.mockResolvedValue([link]);
    render(SharedLinkList);
    await screen.findByText('Rockies');

    await fireEvent.click(screen.getByRole('button', { name: 'Open public page for Rockies' }));
    expect(open).toHaveBeenCalledWith(expect.stringContaining('/s/rockies'), '_blank', 'noopener,noreferrer');
  });

  describe("a link's own id", () => {
    const withAddress = sharedLinkFactory.build({
      id: 'aaaa1111-0000-4000-8000-000000000001',
      type: SharedLinkType.Album,
      album: { id: 'album-1', albumName: 'Rockies' } as never,
      assets: [],
      description: 'For the family',
      slug: 'rockies-2026',
    });
    const withoutAddress = sharedLinkFactory.build({
      id: 'bbbb2222-0000-4000-8000-000000000002',
      type: SharedLinkType.Album,
      album: { id: 'album-2', albumName: 'Kyoto' } as never,
      assets: [],
      description: 'For the neighbours',
      slug: null,
    });
    const cardOf = (title: string) => screen.getByRole('heading', { name: title }).closest('li') as HTMLElement;

    it('is never shown: a card says when the link was made, and its custom address when it has one', async () => {
      serverLinks.mockResolvedValue([withAddress, withoutAddress]);
      render(SharedLinkList);
      await screen.findByText('Rockies');

      expect(cardOf('Rockies').querySelector('.sl-meta')).toHaveTextContent(/^Created .+ · \/s\/rockies-2026$/);
      const plain = cardOf('Kyoto').querySelector('.sl-meta');
      expect(plain).toHaveTextContent(/^Created [^·]+$/);
      expect(document.body).not.toHaveTextContent(withAddress.id);
      expect(document.body).not.toHaveTextContent(withoutAddress.id);
    });

    it('is not searched either, so a card never matches on something it does not show', async () => {
      serverLinks.mockResolvedValue([withAddress, withoutAddress]);
      render(SharedLinkList);
      await screen.findByText('Rockies');
      const search = screen.getByRole('searchbox', { name: en.frameleaf_sharing.search_shared_links });

      await fireEvent.input(search, { target: { value: 'bbbb2222' } });
      expect(screen.queryByText('Kyoto')).toBeNull();
      expect(screen.getByText(en.frameleaf_sharing.empty_matches_title)).toBeInTheDocument();

      // What a card does show still finds it: the title, the description and the custom address.
      await fireEvent.input(search, { target: { value: 'neighbours' } });
      expect(screen.getByText('Kyoto')).toBeInTheDocument();
      expect(screen.queryByText('Rockies')).toBeNull();
      await fireEvent.input(search, { target: { value: 'rockies-2026' } });
      expect(screen.getByText('Rockies')).toBeInTheDocument();
      expect(screen.queryByText('Kyoto')).toBeNull();
    });
  });

  it('says so when the links cannot be loaded, instead of failing silently', async () => {
    serverLinks.mockRejectedValue(new Error('offline'));
    render(SharedLinkList);
    await waitFor(() =>
      expect(handleError).toHaveBeenCalledWith(expect.any(Error), en.frameleaf_sharing.links_load_failed),
    );
    expect(await screen.findByText(en.frameleaf_sharing.empty_links_title)).toBeInTheDocument();
  });

  it('says so when the albums for a new link cannot be loaded', async () => {
    serverLinks.mockResolvedValue([]);
    vi.mocked(getAllAlbums).mockRejectedValue(new Error('offline'));
    render(SharedLinkList);
    await screen.findByText(en.frameleaf_sharing.empty_links_title);

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_sharing.new_link }));

    await waitFor(() =>
      expect(handleError).toHaveBeenCalledWith(expect.any(Error), en.frameleaf_sharing.albums_load_failed),
    );
  });
});

it('reports a rejected edit address update and keeps the share editor closed', async () => {
  const link = sharedLinkFactory.build();
  serverLinks.mockResolvedValue([link]);
  const failure = new Error('Navigation aborted');
  vi.mocked(replaceState).mockRejectedValueOnce(failure);
  pageState.url = new URL(`http://localhost/shared-links?edit=${link.id}`);
  render(SharedLinkList);
  await waitFor(() => expect(handleError).toHaveBeenCalledWith(failure, en.frameleaf_sharing.links_load_failed));
  expect(pageState.url.searchParams.get('edit')).toBe(link.id);
  expect(screen.queryByRole('heading', { name: en.frameleaf_sharing.edit_shared_link_title })).toBeNull();
});

describe('paging (FL-1795)', () => {
  let seen: (() => void) | undefined;
  beforeEach(() => {
    seen = undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      vi.fn(function (callback: IntersectionObserverCallback) {
        seen = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn(), takeRecords: vi.fn() };
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const selection = (id: string, name: string) =>
    sharedLinkFactory.build({
      id,
      type: SharedLinkType.Individual,
      assets: [{ id: `asset-${id}`, originalFileName: name } as never],
      assetCount: 1,
      coverAssetIds: [`asset-${id}`],
    });

  it('reads one page, counts every link in the tabs, and reads the next page when the end comes into view', async () => {
    vi.mocked(getSharedLinkPage)
      .mockResolvedValueOnce(
        pageOf([selection('one', 'first.jpg')], { nextCursor: 'next', individualCount: 2, albumCount: 5 }),
      )
      .mockResolvedValueOnce(pageOf([selection('two', 'second.jpg')], { individualCount: 2, albumCount: 5 }));

    render(SharedLinkList);

    await screen.findByText('first.jpg');
    expect(getSharedLinkPage).toHaveBeenCalledExactlyOnceWith({ take: 60 });
    expect(screen.queryByText('second.jpg')).not.toBeInTheDocument();
    // the tabs count the links of every page, not only the ones read
    expect(screen.getByRole('tab', { name: /^All/ })).toHaveTextContent('7');
    expect(screen.getByRole('tab', { name: /^Albums/ })).toHaveTextContent('5');

    await waitFor(() => expect(seen).toBeDefined());
    seen!();

    await screen.findByText('second.jpg');
    expect(getSharedLinkPage).toHaveBeenLastCalledWith({ take: 60, cursor: 'next' });
    expect(screen.getByText('first.jpg')).toBeInTheDocument();
    // nothing more to read: the end marker is gone
    await waitFor(() => expect(document.querySelector('.sl-end')).not.toBeInTheDocument());
  });

  it('counts down a deleted link that was never read into the list (FL-1795 review)', async () => {
    vi.mocked(getSharedLinkPage).mockResolvedValueOnce(
      pageOf([selection('one', 'first.jpg')], { nextCursor: 'next', albumCount: 3 }),
    );
    render(SharedLinkList);
    await screen.findByText('first.jpg');
    expect(screen.getByRole('tab', { name: /^Albums/ })).toHaveTextContent('3');

    eventManager.emit('SharedLinkDelete', sharedLinkFactory.build({ id: 'unread', type: SharedLinkType.Album }));

    await waitFor(() => expect(screen.getByRole('tab', { name: /^Albums/ })).toHaveTextContent('2'));
  });

  it('keeps the loading cards, not "no matches", while a tab has shown nothing of the pages read so far', async () => {
    vi.mocked(getSharedLinkPage).mockResolvedValueOnce(
      pageOf([selection('one', 'first.jpg')], { nextCursor: 'next', albumCount: 1 }),
    );

    render(SharedLinkList);
    await screen.findByText('first.jpg');
    await fireEvent.click(screen.getByRole('tab', { name: /^Albums/ }));

    expect(screen.getByRole('list', { name: 'Loading' })).toBeInTheDocument();
    expect(document.querySelector('.sl-end')).toBeInTheDocument();
  });
});
