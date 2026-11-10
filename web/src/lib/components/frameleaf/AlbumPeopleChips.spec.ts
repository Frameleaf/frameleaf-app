import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
import AlbumPeopleChips from './AlbumPeopleChips.svelte';

const albumId = '11111111-1111-4111-8111-111111111111';
const jamie = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Jamie',
  count: 4,
  updatedAt: '2026-11-01T00:00:00Z',
};
const emma = { id: '33333333-3333-4333-8333-333333333333', name: 'Emma', count: 2, updatedAt: '2026-11-01T00:00:00Z' };

/** FL-809 (prototype `App.jsx` `.album-people`): the people in an album, as chips that narrow it. */
describe('AlbumPeopleChips', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('narrows the album to items showing everyone chosen, and clears back to all of it', async () => {
    sdkMock.getAlbumPeople.mockResolvedValue([jamie, emma]);
    const session = new LibrarySessionStore({ storage: null });
    render(AlbumPeopleChips, { albumId, session });

    expect(await screen.findByRole('region', { name: 'People in this album' })).toBeInTheDocument();
    expect(sdkMock.getAlbumPeople).toHaveBeenCalledWith({ id: albumId }, expect.anything());
    const jamieChip = screen.getByRole('button', { name: 'Jamie · 4' });
    const emmaChip = screen.getByRole('button', { name: 'Emma · 2' });
    expect(screen.queryByRole('button', { name: 'Clear people' })).not.toBeInTheDocument();

    await fireEvent.click(jamieChip);
    await fireEvent.click(emmaChip);
    expect(session.query.filter.personIds).toEqual({ all: [jamie.id, emma.id] });
    expect(jamieChip).toHaveAttribute('aria-pressed', 'true');
    expect(emmaChip).toHaveAttribute('aria-pressed', 'true');

    await fireEvent.click(jamieChip);
    expect(session.query.filter.personIds).toEqual({ all: [emma.id] });

    await fireEvent.click(screen.getByRole('button', { name: 'Clear people' }));
    expect(session.query.filter.personIds).toBeUndefined();
    expect(emmaChip).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps Clear people while a choice still narrows the album, even when nobody is listed', async () => {
    sdkMock.getAlbumPeople.mockRejectedValue(new Error('Forbidden'));
    const session = new LibrarySessionStore({ storage: null });
    session.setQuery({ ...session.query, filter: { ...session.query.filter, personIds: { all: [jamie.id] } } });
    render(AlbumPeopleChips, { albumId, session });

    await fireEvent.click(await screen.findByRole('button', { name: 'Clear people' }));
    expect(session.query.filter.personIds).toBeUndefined();
    expect(screen.queryByRole('region', { name: 'People in this album' })).not.toBeInTheDocument();
  });

  it('shows no row when nobody in the album is named', async () => {
    sdkMock.getAlbumPeople.mockResolvedValue([]);
    render(AlbumPeopleChips, { albumId, session: new LibrarySessionStore({ storage: null }) });

    await waitFor(() => expect(sdkMock.getAlbumPeople).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'People in this album' })).not.toBeInTheDocument();
  });

  it('shows no row when the people cannot be read', async () => {
    sdkMock.getAlbumPeople.mockRejectedValue(new Error('Forbidden'));
    render(AlbumPeopleChips, { albumId, session: new LibrarySessionStore({ storage: null }) });

    await waitFor(() => expect(sdkMock.getAlbumPeople).toHaveBeenCalled());
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
