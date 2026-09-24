import type { ServerConfigDto } from '@immich/sdk';
import { getAllSharedLinks, getSharedLinkById, removeSharedLink, SharedLinkType } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sharedLinkFactory } from '$lib/../test-data/factories/shared-link-factory';
import en from '../../../../../i18n/en.json';
import SharedLinkList from './SharedLinkList.svelte';

vi.mock('$lib/utils');
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

    await fireEvent.click(screen.getByRole('button', { name: en.delete_link }));
    await fireEvent.click(screen.getByRole('button', { name: en.delete_shared_link }));

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
});
