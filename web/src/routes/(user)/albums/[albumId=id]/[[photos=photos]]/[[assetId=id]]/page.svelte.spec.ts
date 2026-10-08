import { AlbumKind, AlbumUserRole, getAlbumInfo, type AlbumResponseDto } from '@frameleaf/sdk';
import { render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { libraryTransientKey } from '$lib/frameleaf/library-session';
import { librarySession } from '$lib/frameleaf/library-session.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { getAlbumAssetsActions } from '$lib/services/album.service';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AlbumPage from './+page.svelte';

vi.mock('$app/navigation', () => ({
  afterNavigate: vi.fn(),
  beforeNavigate: vi.fn(),
  goto: vi.fn(),
  invalidate: vi.fn(),
  onNavigate: vi.fn(),
}));
vi.mock('$app/state', () => ({ navigating: { complete: Promise.resolve() } }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  getAlbumInfo: vi.fn(),
  getAllTags: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { id: 'owner' } },
}));
vi.mock('$lib/managers/asset-viewer-manager.svelte', () => ({ assetViewerManager: { isViewing: false } }));
vi.mock('$lib/managers/activity-manager.svelte', () => ({
  activityManager: { init: vi.fn().mockResolvedValue(undefined), reset: vi.fn(), commentCount: 0 },
}));
vi.mock('$lib/services/album.service', () => ({
  getAlbumAssetsActions: vi.fn(() => ({})),
  handleDeleteAlbum: vi.fn(),
  leftLocally: () => false,
}));
vi.mock('$lib/services/app.service', () => ({ getGlobalActions: () => ({}) }));
vi.mock('$lib/utils', () => ({ handlePromiseError: (promise: Promise<unknown>) => promise }));
vi.mock('$lib/utils/navigation', () => ({ isAlbumsRoute: () => true, navigate: vi.fn() }));
vi.mock('$lib/components/layouts/UserPageLayout.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/ActivityPanel.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/AlbumHeader.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/LibraryView.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/ResultsAssetViewer.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/ResultsView.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/SpaceMediaComments.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/timeline/TimelineAssetViewer.svelte', () => ({ default: () => {} }));

const data = (value: AlbumResponseDto) => ({ album: value, tree: { collections: [], albums: [], spaces: [] } });

it('restores a collection selection after remounting its flat results view (FL-40)', async () => {
  const collection = albumFactory.build({
    id: 'collection-reload',
    kind: AlbumKind.Collection,
    albumName: 'Collection',
  });
  const first = render(AlbumPage, { data: data(collection) as never });
  await waitFor(() => expect(librarySession.state.scope.id).toBe(collection.id));
  librarySession.select('photo-1');
  await waitFor(() =>
    expect(
      JSON.parse(sessionStorage.getItem(libraryTransientKey('owner', `collection:${collection.id}`)) ?? '{}'),
    ).toMatchObject({ context: `collection:${collection.id}`, selection: ['photo-1'] }),
  );

  first.unmount();
  librarySession.restore(undefined, 'owner', 'another-collection');
  render(AlbumPage, { data: data(collection) as never });
  await waitFor(() => expect(librarySession.selection).toEqual(['photo-1']));
});

it('restores collection selection after the same page visits an ordinary album (FL-40)', async () => {
  const collection = albumFactory.build({
    id: 'collection-return',
    kind: AlbumKind.Collection,
    albumName: 'Collection',
  });
  const ordinary = albumFactory.build({ id: 'ordinary-album', kind: AlbumKind.Album, albumName: 'Album' });
  const view = render(AlbumPage, { data: data(collection) as never });
  await waitFor(() => expect(librarySession.state.scope.id).toBe(collection.id));
  librarySession.select('collection-photo');
  await waitFor(() =>
    expect(
      JSON.parse(sessionStorage.getItem(libraryTransientKey('owner', `collection:${collection.id}`)) ?? '{}').selection,
    ).toEqual(['collection-photo']),
  );

  await view.rerender({ data: data(ordinary) as never });
  await waitFor(() => expect(librarySession.state.scope.id).toBe(ordinary.id));
  // The mocked LibraryView does not run its restore/persist effects. Do their real store writes so
  // ordinary album B replaces the global tab snapshot before returning to collection A.
  const ordinaryContext = JSON.stringify({ route: '/albums/[albumId]', options: { albumId: ordinary.id } });
  librarySession.restore(undefined, 'owner', ordinaryContext);
  librarySession.setScope({ kind: 'album', id: ordinary.id });
  librarySession.select('ordinary-photo');
  expect(librarySession.persist('owner')).toBe(true);
  expect(JSON.parse(sessionStorage.getItem(libraryTransientKey('owner')) ?? '{}').selection).toEqual([
    'ordinary-photo',
  ]);
  await view.rerender({ data: data(collection) as never });
  await waitFor(() => expect(librarySession.selection).toEqual(['collection-photo']));
});

it('keeps a newer role change when an earlier album refresh finishes late (FL-40)', async () => {
  let resolve!: (value: AlbumResponseDto) => void;
  const pending = new Promise<AlbumResponseDto>((done) => (resolve = done));
  vi.mocked(getAlbumInfo).mockReturnValueOnce(pending);
  const first = albumFactory.build({
    id: 'first',
    albumName: 'first',
    assetCount: 1,
    shared: true,
    albumUsers: [
      { user: userAdminFactory.build({ id: 'another-owner' }), role: AlbumUserRole.Owner },
      { user: userAdminFactory.build({ id: 'owner' }), role: AlbumUserRole.Editor },
    ],
  });
  render(AlbumPage, { data: data(first) as never });
  await waitFor(() => expect(librarySession.state.scope.id).toBe('first'));
  eventManager.emit('AlbumAddAssets', { albumIds: ['first'], assetIds: ['added'] });
  await waitFor(() => expect(getAlbumInfo).toHaveBeenCalledWith({ id: 'first' }));

  eventManager.emit('AlbumUserUpdate', { albumId: 'first', userId: 'owner', role: AlbumUserRole.Viewer });
  await tick();
  const currentAlbum = () => vi.mocked(getAlbumAssetsActions).mock.calls.at(-1)![1];
  expect(currentAlbum().albumUsers.find(({ user }) => user.id === 'owner')?.role).toBe(AlbumUserRole.Viewer);
  librarySession.select('first-photo');
  resolve({ ...first, assetCount: 2 });
  await pending;
  await tick();
  expect(currentAlbum().albumUsers.find(({ user }) => user.id === 'owner')?.role).toBe(AlbumUserRole.Viewer);
  expect(librarySession.selection).toEqual(['first-photo']);

  let resolveEarlier!: (value: AlbumResponseDto) => void;
  const earlier = new Promise<AlbumResponseDto>((done) => (resolveEarlier = done));
  let resolveLatest!: (value: AlbumResponseDto) => void;
  const latest = new Promise<AlbumResponseDto>((done) => (resolveLatest = done));
  vi.mocked(getAlbumInfo).mockReturnValueOnce(earlier).mockReturnValueOnce(latest);
  eventManager.emit('AlbumAddAssets', { albumIds: ['first'], assetIds: ['another'] });
  eventManager.emit('AlbumAddAssets', { albumIds: ['first'], assetIds: ['another'] });
  resolveEarlier({ ...currentAlbum(), assetCount: 2 });
  await earlier;
  await tick();
  resolveLatest({ ...currentAlbum(), assetCount: 3 });
  await waitFor(() => expect(currentAlbum().assetCount).toBe(3));
});
