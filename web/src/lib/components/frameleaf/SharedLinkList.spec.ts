import type { ServerConfigDto } from '@immich/sdk';
import { getAllSharedLinks, removeSharedLink, SharedLinkType } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sharedLinkFactory } from '$lib/../test-data/factories/shared-link-factory';
import en from '../../../../../i18n/en.json';
import SharedLinkList from './SharedLinkList.svelte';

vi.mock('$lib/utils');
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAllSharedLinks: vi.fn(),
  getAllAlbums: vi.fn(),
  removeSharedLink: vi.fn(),
}));
vi.mock(import('$lib/managers/server-config-manager.svelte'), () => ({
  serverConfigManager: {
    value: { externalDomain: 'http://localhost:2283' } as ServerConfigDto,
    init: vi.fn(),
    loadServerConfig: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
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
    vi.mocked(removeSharedLink).mockImplementation(() => Promise.resolve());

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
});
