import { AlbumKind } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
import { albumFactory } from '@test-data/factories/album-factory';
import en from '../../../../../i18n/en.json';
import SharedSpaceAddMatching from './SharedSpaceAddMatching.svelte';

vi.mock('$lib/utils');
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { id: 'ada', name: 'Ada', email: 'ada@example.com' }, params: {} },
}));

const space = albumFactory.build({ id: 'space-1', albumName: 'Family Space', kind: AlbumKind.Space });
const album = albumFactory.build({ id: 'album-1', albumName: 'Reunion', kind: AlbumKind.Album });
const collection = albumFactory.build({ id: 'collection-1', albumName: 'Trips', kind: AlbumKind.Collection });

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

const controllerStub = () => {
  const controller = {
    count: vi.fn().mockResolvedValue(7),
    runMatching: vi.fn().mockResolvedValue(void 0),
    cancel: vi.fn(),
    retry: vi.fn(),
    dismiss: vi.fn(),
  };
  return controller as unknown as BulkController & typeof controller;
};

describe('SharedSpaceAddMatching', () => {
  it('offers plain albums as a source, never the space itself or a collection', () => {
    render(SharedSpaceAddMatching, { space, albums: [album, collection, space], controller: controllerStub() });

    const options = [...screen.getByRole('combobox').querySelectorAll('option')].map((option) => option.textContent);
    expect(options).toEqual([en.frameleaf_spaces_add_matching_source_library, 'Reunion']);
  });

  it('shows the count for the chosen source before anything runs', async () => {
    const controller = controllerStub();
    render(SharedSpaceAddMatching, { space, albums: [album], controller });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_add_matching_preview }));

    await waitFor(() => expect(controller.count).toHaveBeenCalled());
    expect(controller.count.mock.calls[0][0].scope).toEqual({ kind: 'library' });
    expect(controller.runMatching).not.toHaveBeenCalled();
    expect(await screen.findByText('7 items will be added.')).toBeInTheDocument();
  });

  it('runs add-to-album against the frozen source scope, with the space as the destination', async () => {
    const controller = controllerStub();
    render(SharedSpaceAddMatching, { space, albums: [album], controller });

    await userEvent.selectOptions(screen.getByRole('combobox'), 'album-1');
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_add_matching_preview }));
    await waitFor(() => expect(controller.count).toHaveBeenCalled());

    await fireEvent.click(screen.getByRole('button', { name: /Add 7 items/ }));

    await waitFor(() => expect(controller.runMatching).toHaveBeenCalled());
    const [action, scope, options] = controller.runMatching.mock.calls[0];
    expect(action).toBe('add-to-album');
    // The scope is where the items come from. The space is the destination, never the scope:
    // a shared space is not expressible as a search.
    expect(scope.scope).toEqual({ kind: 'album', id: 'album-1' });
    expect(options).toEqual({ payload: { albumId: 'space-1' }, submittedTotal: 7 });
  });

  it('cannot be started before a count has been checked', () => {
    render(SharedSpaceAddMatching, { space, albums: [album], controller: controllerStub() });

    expect(screen.getByRole('button', { name: /Add/ })).toBeDisabled();
  });

  it('clears a stale count when the source changes', async () => {
    const controller = controllerStub();
    render(SharedSpaceAddMatching, { space, albums: [album], controller });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_add_matching_preview }));
    expect(await screen.findByText('7 items will be added.')).toBeInTheDocument();

    await fireEvent.change(screen.getByRole('combobox'), { target: { value: 'album-1' } });

    await waitFor(() => expect(screen.queryByText('7 items will be added.')).toBeNull());
  });
});
