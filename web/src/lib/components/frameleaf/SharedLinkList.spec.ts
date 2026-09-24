import type { ServerConfigDto } from '@immich/sdk';
import { getAllAlbums, getAllSharedLinks, getSharedLinkById, removeSharedLink, SharedLinkType } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sharedLinkFactory } from '$lib/../test-data/factories/shared-link-factory';
import { handleError } from '$lib/utils/handle-error';
import en from '../../../../../i18n/en.json';
import SharedLinkList from './SharedLinkList.svelte';

vi.mock('$lib/utils');
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAllSharedLinks: vi.fn(),
  getSharedLinkById: vi.fn(),
  getAllAlbums: vi.fn(),
  removeSharedLink: vi.fn(),
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
  replaceState: vi.fn((url: URL) => {
    pageState.url = new URL(url);
  }),
}));
vi.mock(import('$lib/managers/server-config-manager.svelte'), () => ({
  serverConfigManager: {
    value: { externalDomain: 'http://localhost:2283' } as ServerConfigDto,
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
      password: 'super-secret',
      description: 'Family photos',
    });
    vi.mocked(getAllSharedLinks).mockResolvedValue([link]);

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
    vi.mocked(getAllSharedLinks).mockResolvedValue([link]);
    vi.mocked(removeSharedLink).mockResolvedValue(undefined as never);

    render(SharedLinkList);
    await screen.findByText('Rockies');

    await fireEvent.click(screen.getByRole('button', { name: en.delete }));
    // AL-22: the prototype's delete dialog says who loses access and what is kept.
    const dialog = await screen.findByRole('dialog', { name: en.delete_shared_link });
    expect(dialog).toHaveTextContent(
      'Anyone using the link for Rockies loses access immediately. Your photos and the album itself are not affected.',
    );
    // "Delete link" takes focus first, and both buttons sit in the dialog's footer (SharedLinks.jsx:396-412).
    expect(screen.getByRole('button', { name: en.delete_link })).toHaveFocus();
    expect(screen.getByRole('button', { name: en.delete_link }).closest('footer')).not.toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: en.delete_link }));

    await waitFor(() => expect(removeSharedLink).toHaveBeenCalledWith({ id: link.id }));
    await waitFor(() => expect(screen.queryByText('Rockies')).toBeNull());
  });

  it('shows the empty state distinct from the no-results state', async () => {
    vi.mocked(getAllSharedLinks).mockResolvedValue([]);
    render(SharedLinkList);
    expect(await screen.findByText(en.frameleaf_sharing.empty_links_title)).toBeInTheDocument();
  });

  it('opens the edit form for ?edit= (the old edit address) and drops the parameter', async () => {
    const link = sharedLinkFactory.build({ type: SharedLinkType.Individual, assets: [] });
    vi.mocked(getAllSharedLinks).mockResolvedValue([link]);
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
    vi.mocked(getAllSharedLinks).mockResolvedValue([]);
    vi.mocked(getSharedLinkById).mockRejectedValue(new Error('not found'));
    pageState.url = new URL('http://localhost/shared-links?edit=missing-id');

    render(SharedLinkList);

    await waitFor(() => expect(getSharedLinkById).toHaveBeenCalledWith({ id: 'missing-id' }));
    await waitFor(() => expect(warning).toHaveBeenCalledWith(en.frameleaf_sharing.link_not_found));
    expect(screen.queryByRole('heading', { name: en.frameleaf_sharing.edit_shared_link_title })).toBeNull();
  });

  it('opens with the prototype intro copy (AL-19)', async () => {
    vi.mocked(getAllSharedLinks).mockResolvedValue([]);
    render(SharedLinkList);
    expect(await screen.findByText(en.frameleaf_sharing.links_intro)).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys, Home and End, keeping one tab stop (AL-20)', async () => {
    vi.mocked(getAllSharedLinks).mockResolvedValue([
      sharedLinkFactory.build({
        type: SharedLinkType.Album,
        album: { id: 'a', albumName: 'Rockies' } as never,
        assets: [],
      }),
      sharedLinkFactory.build({
        type: SharedLinkType.Individual,
        assets: [{ id: 'x', originalFileName: 'beach.jpg' } as never],
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
    vi.mocked(getAllSharedLinks).mockResolvedValue([
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
      'Downloads',
      'Uploads',
      'Metadata',
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

  it('opens the public page in a new tab from the card (AL-21)', async () => {
    const open = vi.spyOn(globalThis, 'open').mockImplementation(() => null);
    const link = sharedLinkFactory.build({
      type: SharedLinkType.Album,
      album: { id: 'album-1', albumName: 'Rockies' } as never,
      assets: [],
      slug: 'rockies',
    });
    vi.mocked(getAllSharedLinks).mockResolvedValue([link]);
    render(SharedLinkList);
    await screen.findByText('Rockies');

    await fireEvent.click(screen.getByRole('button', { name: 'Open public page for Rockies' }));
    expect(open).toHaveBeenCalledWith(expect.stringContaining('/s/rockies'), '_blank', 'noopener,noreferrer');
  });

  it('says so when the links cannot be loaded, instead of failing silently', async () => {
    vi.mocked(getAllSharedLinks).mockRejectedValue(new Error('offline'));
    render(SharedLinkList);
    await waitFor(() =>
      expect(handleError).toHaveBeenCalledWith(expect.any(Error), en.frameleaf_sharing.links_load_failed),
    );
    expect(await screen.findByText(en.frameleaf_sharing.empty_links_title)).toBeInTheDocument();
  });

  it('says so when the albums for a new link cannot be loaded', async () => {
    vi.mocked(getAllSharedLinks).mockResolvedValue([]);
    vi.mocked(getAllAlbums).mockRejectedValue(new Error('offline'));
    render(SharedLinkList);
    await screen.findByText(en.frameleaf_sharing.empty_links_title);

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_sharing.new_link }));

    await waitFor(() =>
      expect(handleError).toHaveBeenCalledWith(expect.any(Error), en.frameleaf_sharing.albums_load_failed),
    );
  });
});
