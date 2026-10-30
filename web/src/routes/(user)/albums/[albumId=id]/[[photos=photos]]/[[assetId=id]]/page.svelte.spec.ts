import { AlbumKind, AlbumUserRole, getAlbumInfo, LibraryScope, type AlbumResponseDto } from '@frameleaf/sdk';
import { render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import { invalidate, onNavigate } from '$app/navigation';
import { libraryTransientKey } from '$lib/frameleaf/library-session';
import { librarySession } from '$lib/frameleaf/library-session.svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { getAlbumAssetsActions, handleDeleteAlbum } from '$lib/services/album.service';
import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { albumLibraryFixture } from '@test-data/components/album-library-fixture';
import { deferredPromise } from '@test-data/deferred';
import { albumFactory } from '@test-data/factories/album-factory';
import { assetFactory } from '@test-data/factories/asset-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AlbumPage from './+page.svelte';

const owners = vi.hoisted(() => ({
  current: true,
  header: undefined as { onRefresh: () => Promise<void>; onSlideshow: () => Promise<void> } | undefined,
}));

vi.mock('$app/navigation', () => ({
  afterNavigate: vi.fn(),
  beforeNavigate: vi.fn(),
  goto: vi.fn(),
  invalidate: vi.fn(),
  onNavigate: vi.fn(),
}));
vi.mock('$app/state', () => ({
  navigating: { complete: Promise.resolve() },
  page: { url: new URL('http://localhost/albums/album'), params: {}, route: { id: null }, data: {} },
}));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  getAlbumInfo: vi.fn(),
  getAllTags: vi.fn().mockResolvedValue([]),
  // A collection's photos page by cursor through the album subtree filter.
  searchAssets: vi.fn().mockResolvedValue({ assets: { items: [], nextCursor: null } }),
  getAlbumItems: vi.fn().mockResolvedValue({ bookmarkCount: 0 }),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { id: 'owner' }, captureSession: () => () => owners.current },
}));
vi.mock('$lib/managers/asset-viewer-manager.svelte', () => ({
  assetViewerManager: { isViewing: false, setAssetId: vi.fn().mockResolvedValue(undefined) },
}));
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
vi.mock('$lib/utils/navigation', () => ({
  isAlbumsRoute: (route?: string | null) => !!route?.startsWith('/(user)/albums/[albumId=id]'),
  navigate: vi.fn(),
}));
vi.mock(
  '$lib/components/layouts/UserPageLayout.svelte',
  async () => import('@test-data/mocks/UserPageLayout.mock.svelte'),
);
vi.mock('$lib/components/frameleaf/ActivityPanel.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/AlbumHeader.svelte', () => ({
  default: (_anchor: unknown, props: NonNullable<typeof owners.header>) => {
    owners.header = props;
  },
}));
vi.mock(
  '$lib/components/frameleaf/LibraryView.svelte',
  async () => import('@test-data/components/AlbumLibraryFixture.svelte'),
);
vi.mock('$lib/components/frameleaf/ResultsAssetViewer.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/ResultsView.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/SpaceMediaComments.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/timeline/TimelineAssetViewer.svelte', () => ({ default: () => {} }));

beforeEach(() => {
  owners.current = true;
  owners.header = undefined;
  albumLibraryFixture.manager = { refresh: vi.fn().mockResolvedValue(undefined), getRandomAsset: vi.fn() };
  slideshowStore.slideshowNavigation.set(SlideshowNavigation.Shuffle);
  slideshowStore.slideshowState.set(SlideshowState.None);
});

const emptyTree = () => ({ collections: [], albums: [], spaces: [] });
const data = (value: AlbumResponseDto, libraryTree = emptyTree()) => ({ album: value, tree: emptyTree(), libraryTree });

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

it.each(['replacement', 'session', 'close'] as const)(
  'does not invalidate or refresh after %s during album readback',
  async (change) => {
    const pending = deferredPromise<AlbumResponseDto>();
    const original = albumFactory.build({ id: 'old-album', kind: AlbumKind.Album });
    vi.mocked(getAlbumInfo).mockReturnValueOnce(pending.promise);
    vi.mocked(invalidate).mockClear();
    const manager = albumLibraryFixture.manager as { refresh: ReturnType<typeof vi.fn> };
    const view = render(AlbumPage, { data: data(original) as never });
    const done = owners.header!.onRefresh();
    if (change === 'replacement') {
      await view.rerender({ data: data(albumFactory.build({ id: 'new-album', kind: AlbumKind.Album })) as never });
    } else if (change === 'session') {
      owners.current = false;
    } else {
      view.unmount();
    }
    pending.resolve({ ...original, assetCount: original.assetCount + 1 });
    await done;
    expect(invalidate).not.toHaveBeenCalled();
    expect(manager.refresh).not.toHaveBeenCalled();
  },
);

it('does not refresh a replacement timeline after invalidation', async () => {
  const pending = deferredPromise<void>();
  const original = albumFactory.build({ id: 'old-invalidation', kind: AlbumKind.Album });
  vi.mocked(getAlbumInfo).mockResolvedValueOnce(original);
  vi.mocked(invalidate).mockReturnValueOnce(pending.promise);
  const manager = albumLibraryFixture.manager as { refresh: ReturnType<typeof vi.fn> };
  const view = render(AlbumPage, { data: data(original) as never });
  const done = owners.header!.onRefresh();
  await waitFor(() => expect(invalidate).toHaveBeenCalled());
  await view.rerender({ data: data(albumFactory.build({ id: 'after-invalidation', kind: AlbumKind.Album })) as never });
  pending.resolve();
  await done;
  expect(manager.refresh).not.toHaveBeenCalled();
});

it.each(['replacement', 'session', 'close'] as const)(
  'does not open a shuffled slide after %s during month loading',
  async (change) => {
    const pending = deferredPromise<TimelineAsset>();
    const manager = albumLibraryFixture.manager as { getRandomAsset: ReturnType<typeof vi.fn> };
    manager.getRandomAsset.mockReturnValueOnce(pending.promise);
    vi.mocked(assetViewerManager.setAssetId).mockClear();
    const view = render(AlbumPage, {
      data: data(albumFactory.build({ id: 'shuffle-original', kind: AlbumKind.Album })) as never,
    });
    const done = owners.header!.onSlideshow();
    if (change === 'replacement') {
      await view.rerender({ data: data(albumFactory.build({ id: 'shuffle-next', kind: AlbumKind.Album })) as never });
    } else if (change === 'session') {
      owners.current = false;
    } else {
      view.unmount();
    }
    pending.resolve(assetFactory.build() as unknown as TimelineAsset);
    await done;
    expect(assetViewerManager.setAssetId).not.toHaveBeenCalled();
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.None);
  },
);

it('refreshes the same album and its original timeline after readback and invalidation', async () => {
  const original = albumFactory.build({ id: 'current-album', kind: AlbumKind.Album });
  vi.mocked(getAlbumInfo).mockResolvedValueOnce({ ...original, assetCount: original.assetCount + 1 });
  vi.mocked(invalidate).mockResolvedValueOnce();
  const manager = albumLibraryFixture.manager as { refresh: ReturnType<typeof vi.fn> };
  render(AlbumPage, { data: data(original) as never });
  await owners.header!.onRefresh();
  expect(manager.refresh).toHaveBeenCalledOnce();
});

it.each(['none', 'close', 'session'] as const)(
  'starts playback only when the album still owns the asset publication (%s)',
  async (change) => {
    const pending = deferredPromise<void>();
    const asset = assetFactory.build();
    const manager = albumLibraryFixture.manager as { getRandomAsset: ReturnType<typeof vi.fn> };
    manager.getRandomAsset.mockResolvedValueOnce(asset);
    vi.mocked(assetViewerManager.setAssetId).mockImplementationOnce(async (_id, options) => {
      await pending.promise;
      if (options?.isCurrent?.()) {
        options.onSet?.();
      }
      return asset;
    });
    const view = render(AlbumPage, {
      data: data(albumFactory.build({ id: 'publish-album', kind: AlbumKind.Album })) as never,
    });
    const done = owners.header!.onSlideshow();
    await tick();
    if (change === 'close') {
      view.unmount();
    } else if (change === 'session') {
      owners.current = false;
    }
    pending.resolve();
    await done;
    expect(get(slideshowStore.slideshowState)).toBe(
      change === 'none' ? SlideshowState.PlaySlideshow : SlideshowState.None,
    );
  },
);

it('ignores a retired header callback after switching albums', async () => {
  vi.mocked(getAlbumInfo).mockClear();
  vi.mocked(assetViewerManager.setAssetId).mockClear();
  const view = render(AlbumPage, {
    data: data(albumFactory.build({ id: 'old-header', kind: AlbumKind.Album })) as never,
  });
  const oldRefresh = owners.header!.onRefresh;
  const oldSlideshow = owners.header!.onSlideshow;
  await view.rerender({ data: data(albumFactory.build({ id: 'new-header', kind: AlbumKind.Album })) as never });
  await oldRefresh();
  await oldSlideshow();
  expect(getAlbumInfo).not.toHaveBeenCalled();
  expect(assetViewerManager.setAssetId).not.toHaveBeenCalled();
});

describe('leaving an empty, unnamed album', () => {
  const owned = (overrides: Partial<AlbumResponseDto>) =>
    albumFactory.build({
      kind: AlbumKind.Album,
      albumName: '',
      assetCount: 0,
      albumUsers: [{ user: userAdminFactory.build({ id: 'owner' }), role: AlbumUserRole.Owner }],
      ...overrides,
    });
  const leaveTo = async (routeId: string) => {
    const callback = vi.mocked(onNavigate).mock.calls.at(-1)![0] as (navigation: unknown) => Promise<void>;
    await callback({ to: { route: { id: routeId } } });
  };

  beforeEach(() => {
    vi.mocked(onNavigate).mockClear();
    vi.mocked(handleDeleteAlbum).mockClear();
  });

  it('deletes it when you go anywhere but another album', async () => {
    const album = owned({ id: 'draft' });
    render(AlbumPage, { data: data(album) as never });
    await leaveTo('/(user)/photos');
    expect(handleDeleteAlbum).toHaveBeenCalledWith(album, { notify: false });
  });

  it('keeps a Boards album holding an album of the other workspace (FL-670)', async () => {
    const album = owned({ id: 'boards-draft', libraryScope: LibraryScope.Design });
    const child = albumFactory.build({ id: 'personal-child', parentId: 'boards-draft' });
    render(AlbumPage, { data: data(album, { ...emptyTree(), albums: [child] as never[] }) as never });
    await leaveTo('/(user)/photos');
    expect(handleDeleteAlbum).not.toHaveBeenCalled();
  });

  it('keeps it when you open another album', async () => {
    render(AlbumPage, { data: data(owned({ id: 'draft-2' })) as never });
    await leaveTo('/(user)/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]');
    expect(handleDeleteAlbum).not.toHaveBeenCalled();
  });

  it.each([
    ['a named album', { albumName: 'Trip' }],
    ['an album with items', { assetCount: 2 }],
    ['a collection', { kind: AlbumKind.Collection }],
    [
      'an album someone else owns',
      { albumUsers: [{ user: userAdminFactory.build({ id: 'jamie' }), role: AlbumUserRole.Owner }] },
    ],
  ])('never deletes %s', async (_name, overrides) => {
    render(AlbumPage, { data: data(owned({ id: 'keep', ...(overrides as Partial<AlbumResponseDto>) })) as never });
    await leaveTo('/(user)/photos');
    expect(handleDeleteAlbum).not.toHaveBeenCalled();
  });
});
