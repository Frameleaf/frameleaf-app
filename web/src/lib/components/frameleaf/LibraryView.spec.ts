import { AssetOrder, AssetTypeEnum, AssetVisibility } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { SvelteURL } from 'svelte/reactivity';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
import { writeLibraryView } from '$lib/frameleaf/library-session';
import { LibrarySessionStore, librarySession } from '$lib/frameleaf/library-session.svelte';
import { applyFilterQuery } from '$lib/frameleaf/search-shortcuts';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import LibraryView from './LibraryView.svelte';

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { init: vi.fn(), value: { smartSearch: true, trash: true, map: true } },
}));
vi.mock('$lib/utils/router-started', () => ({ hasRouterStarted: () => true }));

const app = vi.hoisted(() => ({
  page: {
    url: new URL('http://localhost/photos'),
    route: { id: '/(user)/photos/[[assetId=id]]' },
    params: {},
    data: {},
    state: {},
  },
}));
vi.mock('$app/state', () => ({ page: app.page }));

const navigation = vi.hoisted(() => ({ goto: vi.fn(), replaceState: vi.fn() }));
vi.mock('$app/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$app/navigation')>()),
  goto: navigation.goto,
  replaceState: navigation.replaceState,
}));

const mediaQueries = vi.hoisted(() => ({
  pointerCoarse: false,
  maxMd: false,
  isFullSidebar: true,
  reducedMotion: false,
  wideInspector: true,
}));
vi.mock('$lib/stores/media-query-manager.svelte', () => ({ mediaQueryManager: mediaQueries }));

const infoPanel = createRawSnippet(() => ({ render: () => '<p data-testid="work-panel">details</p>' }));

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', getResizeObserverMock());
});

beforeEach(() => {
  app.page.url = new SvelteURL('http://localhost/photos');
  // Keep `location.href` (read by the FL-40 fix) in step with the reset `page.url` mock so a test
  // earlier in the file that advanced `location` via a real `history.replaceState` call can't leak
  // a stale address into a later, unrelated test.
  history.replaceState(null, '', '/photos');
  navigation.replaceState.mockReset();
  sdkMock.getTimeBuckets.mockResolvedValue([]);
});

afterEach(() => {
  librarySession.setLayout('browse');
  localStorage.removeItem('frameleaf.albumViewSort.owner');
  authManager.reset();
});

const setup = async (publicView: boolean) => {
  render(LibraryView, {
    options: { albumId: 'album-1' },
    destination: { kind: 'album', id: 'album-1' },
    syncUrl: false,
    noSelectionBar: true,
    infoPanel,
    publicView,
  });
  await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
  // the device last used Work in the library, which on a private page opens the information panel
  librarySession.setLayout('work');
  await tick();
};

describe('LibraryView', () => {
  it('follows same-route Back and Forward views without restoring its own URL writes (FL-40)', async () => {
    authManager.setUser(userAdminFactory.build({ id: 'owner' }));
    authManager.setPreferences(preferencesFactory.build());
    const session = new LibrarySessionStore({ storage: null, transientStorage: null });
    const first = writeLibraryView(new URL('http://localhost/photos'), session.state);
    const second = writeLibraryView(first, { ...session.state, sort: 'filename' });
    app.page.url = new SvelteURL(first.href);
    navigation.replaceState.mockImplementation((url: URL) => {
      app.page.url.searchParams.set('fl', url.searchParams.get('fl') ?? '');
      // A real `replaceState` updates `location.href` synchronously (only the reactive `page.url`
      // store lags behind); keep this mock's `location` in step so the FL-40 fix's comparison
      // against `location.href` behaves as it would in the browser.
      history.replaceState(null, '', `${url.pathname}${url.search}`);
    });
    const restore = vi.spyOn(session, 'restore');

    try {
      const props = { options: {}, destination: { kind: 'library' as const }, session, noSelectionBar: true };
      const view = render(LibraryView, props);
      await screen.findByTestId('frameleaf-library');
      session.select('private-asset');

      app.page.url.searchParams.set('fl', second.searchParams.get('fl')!);
      await waitFor(() => expect(session.state.sort).toBe('filename'));
      expect(session.selection).toEqual([]);

      app.page.url.searchParams.set('fl', first.searchParams.get('fl')!);
      await waitFor(() => expect(session.state.sort).toBe('captured-desc'));
      app.page.url.searchParams.set('fl', second.searchParams.get('fl')!);
      await waitFor(() => expect(session.state.sort).toBe('filename'));

      const restoresBeforeEdit = restore.mock.calls.length;
      navigation.replaceState.mockClear();
      session.patchView({ sort: 'rating' });
      await waitFor(() => expect(navigation.replaceState).toHaveBeenCalled());
      await tick();
      expect(session.state.sort).toBe('rating');
      expect(navigation.replaceState).toHaveBeenCalledTimes(1);
      expect(restore).toHaveBeenCalledTimes(restoresBeforeEdit);

      session.select('private-asset');
      authManager.setUser(userAdminFactory.build({ id: 'second-owner' }));
      await waitFor(() => expect(session.selection).toEqual([]));
      expect(restore.mock.lastCall?.[1]).toBe('second-owner');

      session.select('private-asset');
      await view.rerender({ ...props, options: { isFavorite: true } });
      await waitFor(() => expect(session.selection).toEqual([]));

      session.select('private-asset');
      await view.rerender({ ...props, options: { isFavorite: true }, publicView: true });
      await waitFor(() => expect(session.selection).toEqual([]));
      expect(restore.mock.lastCall?.[1]).toBeUndefined();
    } finally {
      restore.mockRestore();
      authManager.reset();
    }
  });

  it('does not loop or drop a session write when replaceState leaves page.url stale (FL-40 regression)', async () => {
    // Real SvelteKit `replaceState` updates the address bar without synchronously updating the
    // reactive `page.url` store. The default `navigation.replaceState` mock (a plain vi.fn() no-op,
    // reset in beforeEach) reproduces that gap: unlike the mock above, it never mutates `app.page.url`.
    authManager.setUser(userAdminFactory.build({ id: 'owner' }));
    authManager.setPreferences(preferencesFactory.build());
    const session = new LibrarySessionStore({ storage: null, transientStorage: null });
    const initial = writeLibraryView(new URL('http://localhost/photos'), session.state);
    app.page.url = new SvelteURL(initial.href);
    history.replaceState(null, '', `${initial.pathname}${initial.search}`);
    const props = { options: {}, destination: { kind: 'library' as const }, session, noSelectionBar: true };
    render(LibraryView, props);
    await screen.findByTestId('frameleaf-library');
    await tick();
    await tick();

    navigation.replaceState.mockClear();
    session.patchView({ sort: 'rating' });
    await tick();
    await tick();
    await tick();
    await waitFor(() => expect(navigation.replaceState).toHaveBeenCalled());
    await tick();
    await tick();

    // Before the FL-40 fix, the restore and persist effects fought over `restoredView`/`page.url`
    // (which never advances here) and kept calling replaceState / session.restore without bound,
    // eventually tripping Svelte's effect_update_depth_exceeded and reverting the write. A single
    // write and a stable, unreverted view is the correct behavior.
    expect(navigation.replaceState.mock.calls.length).toBeLessThanOrEqual(1);
    expect(session.state.sort).toBe('rating');
  });

  it('applies supported album filters in place and preserves the resulting session across layouts (FL-40)', async () => {
    authManager.setUser(userAdminFactory.build({ id: 'owner' }));
    authManager.setPreferences(preferencesFactory.build());
    await setup(false);
    const sort = screen.getByRole('combobox', { name: 'frameleaf_library_sort' });
    await fireEvent.change(sort, { target: { value: 'captured-asc' } });
    const query = {
      ...emptyDiscoveryQuery(),
      filter: { albumIds: { any: ['album-1'] }, isFavorite: { eq: true }, type: { eq: AssetTypeEnum.Image } },
    };
    expect(applyFilterQuery(query)).toBe(true);
    await waitFor(() =>
      expect(sdkMock.getTimeBuckets).toHaveBeenLastCalledWith(
        expect.objectContaining({
          albumId: 'album-1',
          isFavorite: true,
          assetType: AssetTypeEnum.Image,
          order: AssetOrder.Asc,
        }),
      ),
    );
    librarySession.select('selected');
    librarySession.open('viewed', 12);
    librarySession.setLayout('browse');
    librarySession.setLayout('work');
    expect(librarySession.query).toEqual(query);
    expect(librarySession.selection).toEqual(['selected']);
    expect(librarySession.openAssetId).toBe('viewed');
    expect(librarySession.playbackPosition).toBe(12);
    expect(sort).toHaveValue('captured-asc');

    // Scope changes and queries the album cannot execute must still reach the search route.
    for (const unsupported of [
      emptyDiscoveryQuery(),
      { ...query, text: 'beach' },
      { ...query, queryAssetId: 'similar' },
      { ...query, spaceId: 'space' },
      { ...query, filter: { ...query.filter, albumIds: { any: ['other-album'] } } },
      { ...query, filter: { ...query.filter, city: { eq: 'Banff' } } },
    ]) {
      expect(applyFilterQuery(unsupported)).toBe(false);
      expect(librarySession.query).toEqual(query);
    }
    librarySession.clearSelection();
    librarySession.close();
    librarySession.setQuery(emptyDiscoveryQuery());
  });

  it('keeps the results toolbar and the Work panel on a private library page', async () => {
    await setup(false);
    expect(screen.getByTestId('frameleaf-results-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('frameleaf-library')).toHaveAttribute('data-layout', 'work');
    expect(screen.getByTestId('work-panel')).toBeInTheDocument();
  });

  it('offers Work’s file-name toggle in Work only, and remembers it on this device (FL-33)', async () => {
    localStorage.removeItem('frameleaf-work-filenames');
    libraryGridPreferences.reload();
    await setup(false);
    const toggle = screen.getByRole('button', { name: 'frameleaf_library_show_file_names' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'frameleaf_library_hide_file_names' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(localStorage.getItem('frameleaf-work-filenames')).toBe('true');
    librarySession.setLayout('browse');
    await tick();
    expect(screen.queryByRole('button', { name: 'frameleaf_library_hide_file_names' })).not.toBeInTheDocument();
    libraryGridPreferences.showFileNames = false;
  });

  it('draws no layout switch, Filter menu or Work panel on a public shared-link page', async () => {
    await setup(true);
    expect(screen.queryByTestId('frameleaf-results-toolbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'frameleaf_library_layout' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('work-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('frameleaf-library')).toHaveAttribute('data-layout', 'browse');
  });
  describe('Work’s information panel (FL-33)', () => {
    const setupWork = async () => {
      render(LibraryView, {
        options: { albumId: 'album-1' },
        destination: { kind: 'album', id: 'album-1' },
        syncUrl: false,
        noSelectionBar: true,
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
      librarySession.setLayout('work');
      await tick();
    };

    it('steps aside while Activity or the filter panel is open beside the results', async () => {
      const props = {
        options: { albumId: 'album-1' },
        destination: { kind: 'album' as const, id: 'album-1' },
        syncUrl: false,
        noSelectionBar: true,
      };
      render(LibraryView, { ...props, sidePanelOpen: true });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
      librarySession.setLayout('work');
      await tick();
      expect(screen.queryByTestId('frameleaf-work-inspector')).not.toBeInTheDocument();
      // the toggle still says the panel is on: it comes back when the side panel closes
      expect(screen.getByRole('button', { name: 'frameleaf_work_inspector_hide' })).toBeInTheDocument();
    });

    it('describes the selection itself when the page supplies no panel of its own', async () => {
      await setupWork();
      expect(screen.getByTestId('frameleaf-work-inspector')).toBeInTheDocument();
      expect(screen.getByText('frameleaf_work_inspector_empty')).toBeInTheDocument();
    });

    it('closes, opens again from the toolbar and from the I key, and reopens on a switch to Work', async () => {
      await setupWork();

      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_work_inspector_close' }));
      expect(screen.queryByTestId('frameleaf-work-inspector')).not.toBeInTheDocument();

      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_work_inspector_show' }));
      expect(screen.getByTestId('frameleaf-work-inspector')).toBeInTheDocument();

      await fireEvent.keyDown(document, { key: 'i' });
      expect(screen.queryByTestId('frameleaf-work-inspector')).not.toBeInTheDocument();

      librarySession.setLayout('browse');
      await tick();
      librarySession.setLayout('work');
      await tick();
      expect(screen.getByTestId('frameleaf-work-inspector')).toBeInTheDocument();
    });
  });

  describe('Work on a tablet and the Locked view (FL-31, T-20)', () => {
    afterEach(() => {
      mediaQueries.wideInspector = true;
    });

    it('does not open Work’s panel by itself at 1000px and below, but the toolbar still shows it', async () => {
      mediaQueries.wideInspector = false;
      render(LibraryView, {
        options: { albumId: 'album-1' },
        destination: { kind: 'album', id: 'album-1' },
        syncUrl: false,
        noSelectionBar: true,
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
      librarySession.setLayout('work');
      await tick();
      expect(screen.queryByTestId('frameleaf-work-inspector')).not.toBeInTheDocument();
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_work_inspector_show' }));
      expect(screen.getByTestId('frameleaf-work-inspector')).toBeInTheDocument();
    });

    it('offers only the Timeline in the Locked view, whatever this device last chose', async () => {
      render(LibraryView, {
        options: { visibility: AssetVisibility.Locked },
        syncUrl: false,
        noSelectionBar: true,
        bulkContext: { locked: true },
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
      librarySession.setLayout('work');
      await tick();
      expect(screen.getByTestId('frameleaf-library')).toHaveAttribute('data-layout', 'timeline');
      const layouts = screen.getByTestId('frameleaf-layout-switch');
      expect(layouts.querySelectorAll('button')).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'frameleaf_library_layout_timeline' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });

  describe('an album’s shared order and the viewer’s own sort (FL-31)', () => {
    beforeEach(() => {
      authManager.setUser(userAdminFactory.build({ id: 'owner' }));
      authManager.setPreferences(preferencesFactory.build());
    });

    it('preserves the live session through shared order changes but clears it for Locked (FL-40)', async () => {
      const session = new LibrarySessionStore({ storage: null, transientStorage: null });
      const props = {
        options: { albumId: 'album-1', order: AssetOrder.Desc },
        destination: { kind: 'album' as const, id: 'album-1' },
        session,
        syncUrl: false,
        noSelectionBar: true,
        infoPanel,
      };
      const view = render(LibraryView, props);
      const sort = await screen.findByRole('combobox', { name: 'frameleaf_library_sort' });
      session.select('photo');
      session.open('video', 12);
      const draft = { assetId: 'photo', recipe: [{ exposure: 0.5 }], undo: [[]], redo: [] };
      session.dispatch({ type: 'draft', draft });
      await tick();

      await view.rerender({ ...props, options: { albumId: 'album-1', order: AssetOrder.Asc } });
      await waitFor(() => expect(sort).toHaveValue('captured-asc'));
      expect(session.selection).toEqual(['photo']);
      expect(session.openAssetId).toBe('video');
      expect(session.playbackPosition).toBe(12);
      expect(session.session.draft).toEqual(draft);

      await view.rerender({
        ...props,
        options: { albumId: 'album-1', order: AssetOrder.Asc, visibility: AssetVisibility.Locked },
      });
      await waitFor(() => expect(session.selection).toEqual([]));
      expect(session.openAssetId).toBeUndefined();
      expect(session.playbackPosition).toBe(0);
      expect(session.session.draft).toBeNull();
    });

    it('starts from the shared order and keeps a new choice for this viewer only', async () => {
      render(LibraryView, {
        options: { albumId: 'album-1', order: AssetOrder.Asc },
        destination: { kind: 'album', id: 'album-1' },
        syncUrl: false,
        noSelectionBar: true,
      });
      const sort = await screen.findByRole('combobox', { name: 'frameleaf_library_sort' });
      expect(sort).toHaveValue('captured-asc');
      const sessionSort = librarySession.state.sort;

      await fireEvent.change(sort, { target: { value: 'filename' } });
      expect(sort).toHaveValue('filename');
      expect(JSON.parse(localStorage.getItem('frameleaf.albumViewSort.owner') ?? '{}')).toEqual({
        'album-1': 'filename',
      });
      // the library's own sort and the album's shared order are untouched
      expect(librarySession.state.sort).toBe(sessionSort);
      expect(sdkMock.updateAlbumInfo).not.toHaveBeenCalled();
    });

    it('shows Timeline’s date order while keeping a flat sort for Browse and Work', async () => {
      render(LibraryView, {
        options: { albumId: 'album-1', order: AssetOrder.Asc },
        destination: { kind: 'album', id: 'album-1' },
        syncUrl: false,
        noSelectionBar: true,
      });
      const sort = await screen.findByRole('combobox', { name: 'frameleaf_library_sort' });
      librarySession.setLayout('browse');
      await fireEvent.change(sort, { target: { value: 'filename' } });
      expect(sort).toHaveValue('filename');

      librarySession.setLayout('timeline');
      await waitFor(() => expect(sort).toHaveValue('captured-asc'));
      await waitFor(() =>
        expect(sdkMock.getTimeBuckets).toHaveBeenLastCalledWith(expect.objectContaining({ order: AssetOrder.Asc })),
      );

      librarySession.setLayout('work');
      await waitFor(() => expect(sort).toHaveValue('filename'));
      expect(JSON.parse(localStorage.getItem('frameleaf.albumViewSort.owner') ?? '{}')).toEqual({
        'album-1': 'filename',
      });
    });
  });

  describe('one toolbar and the status bar (FL-32, FL-33)', () => {
    const setupBars = async () => {
      render(LibraryView, {
        options: { albumId: 'album-1' },
        destination: { kind: 'album', id: 'album-1' },
        syncUrl: false,
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
    };

    afterEach(() => {
      librarySession.clearSelection();
      navigation.goto.mockClear();
    });

    // A collection page's header carries Slideshow (CollectionHeader.jsx:1430-1436, and the phone "…"
    // menu), so the results toolbar leaves it out there and the page has exactly one.
    it('offers Slideshow in the results toolbar unless the page header already does', async () => {
      const viewer = createRawSnippet(() => ({ render: () => '<div></div>' }));
      const first = render(LibraryView, {
        options: { albumId: 'album-1' },
        destination: { kind: 'album', id: 'album-1' },
        syncUrl: false,
        viewer,
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-results-toolbar')).toHaveTextContent('slideshow'));
      first.unmount();

      render(LibraryView, {
        options: { albumId: 'album-1' },
        destination: { kind: 'album', id: 'album-1' },
        syncUrl: false,
        viewer,
        headerHasSlideshow: true,
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-results-toolbar')).toBeInTheDocument());
      expect(screen.getByTestId('frameleaf-results-toolbar')).not.toHaveTextContent('slideshow');
    });

    it('shows the status bar with nothing selected and no Compare in the results toolbar', async () => {
      await setupBars();

      const bar = screen.getByTestId('library-status-bar');
      expect(bar).not.toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByTestId('frameleaf-results-toolbar')).not.toHaveTextContent('frameleaf_compare_title');
    });

    it('lets the selection bar take the status bar’s place, carrying Compare and Open in Studio', async () => {
      await setupBars();
      librarySession.dispatch({ type: 'selection', ids: ['a', 'b'] });
      await tick();

      expect(screen.getByTestId('library-status-bar')).toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByTestId('selection-leading-compare')).toBeEnabled();
      // No viewer on this page, so there is nothing to open the quick editor in.
      expect(screen.queryByTestId('selection-leading-quick-edit')).not.toBeInTheDocument();

      await fireEvent.click(screen.getByTestId('selection-leading-studio'));
      expect(navigation.goto).toHaveBeenCalledWith('/studio?assets=a%2Cb');
    });

    it('counts what an active filter leaves, once per result set', async () => {
      sdkMock.searchAssetStatistics.mockResolvedValue({ total: 7 } as never);
      render(LibraryView, {
        options: {},
        destination: { kind: 'library' },
        syncUrl: false,
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
      librarySession.patchView({
        query: { ...emptyDiscoveryQuery(), filter: { tagIds: { any: ['t1'] } } } as never,
      });

      // One count for "select all matching" and one for the scope without the filter (the status bar's Y).
      await waitFor(() => expect(sdkMock.searchAssetStatistics).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(librarySession.total).toBe(7));
      // One count per result set: re-rendering does not ask again.
      await tick();
      expect(sdkMock.searchAssetStatistics).toHaveBeenCalledTimes(2);
      librarySession.patchView({ query: emptyDiscoveryQuery() });
    });

    it('drops a condition the grid cannot apply instead of showing a chip for it (M3)', async () => {
      render(LibraryView, { options: {}, destination: { kind: 'library' }, syncUrl: false });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
      librarySession.patchView({
        query: {
          ...emptyDiscoveryQuery(),
          text: 'beach',
          filter: { city: { eq: 'Halifax' }, tagIds: { any: ['t1'] } },
        } as never,
      });
      await waitFor(() => expect(librarySession.query.filter).toEqual({ tagIds: { any: ['t1'] } }));
      expect(librarySession.query.text).toBe('');
      librarySession.patchView({ query: emptyDiscoveryQuery() });
    });

    it('applies a filter the time buckets can express to the grid itself (M3)', async () => {
      sdkMock.searchAssetStatistics.mockResolvedValue({ total: 40 } as never);
      sdkMock.getTimeBuckets.mockClear();
      render(LibraryView, {
        options: { visibility: AssetVisibility.Timeline },
        destination: { kind: 'library' },
        syncUrl: false,
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
      librarySession.patchView({
        query: { ...emptyDiscoveryQuery(), filter: { tagIds: { any: ['t1'] }, isFavorite: { eq: true } } } as never,
      });
      await waitFor(() =>
        expect(sdkMock.getTimeBuckets).toHaveBeenLastCalledWith(
          expect.objectContaining({ tagId: 't1', isFavorite: true }),
        ),
      );
      // The grid is empty under the applied filter, so the page says so and offers to clear it.
      const empty = await screen.findByTestId('frameleaf-library-empty');
      await waitFor(() => expect(empty).toHaveTextContent('frameleaf_library_empty_filtered_title'));
      librarySession.patchView({ query: emptyDiscoveryQuery() });
    });

    it('carries Thumbnail size on the library, not on a person’s page', async () => {
      const first = render(LibraryView, { options: {}, destination: { kind: 'library' }, syncUrl: false });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
      expect(screen.getByTestId('frameleaf-thumbnail-size')).toBeInTheDocument();
      first.unmount();

      render(LibraryView, {
        options: { personId: 'p1' },
        destination: { kind: 'person', id: 'p1' },
        syncUrl: false,
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
      expect(screen.queryByTestId('frameleaf-thumbnail-size')).not.toBeInTheDocument();
    });

    it('never hands Locked items to Studio', async () => {
      render(LibraryView, {
        options: { visibility: AssetVisibility.Locked },
        destination: { kind: 'library' },
        syncUrl: false,
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
      librarySession.dispatch({ type: 'selection', ids: ['a', 'b'] });
      await tick();

      expect(screen.getByTestId('selection-leading-studio')).toBeDisabled();
      await fireEvent.click(screen.getByTestId('selection-leading-studio'));
      expect(navigation.goto).not.toHaveBeenCalled();
    });

    it('offers Compare only for two or more items', async () => {
      await setupBars();
      librarySession.dispatch({ type: 'selection', ids: ['a'] });
      await tick();

      // It stays reachable so it can say why it is not offered.
      const compare = screen.getByTestId('selection-leading-compare');
      expect(compare).toHaveAttribute('aria-disabled', 'true');
      expect(compare).toHaveAttribute('title', 'frameleaf_selection_compare_needs_two');
      await fireEvent.click(compare);
      expect(librarySession.state.view).not.toBe('compare');
    });

    it('keeps the private library actions and the status bar off a public shared-link page', async () => {
      render(LibraryView, {
        options: { albumId: 'album-1' },
        destination: { kind: 'album', id: 'album-1' },
        syncUrl: false,
        publicView: true,
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
      librarySession.dispatch({ type: 'selection', ids: ['a', 'b'] });
      await tick();

      expect(screen.queryByTestId('selection-leading-compare')).not.toBeInTheDocument();
      expect(screen.queryByTestId('selection-leading-studio')).not.toBeInTheDocument();
      expect(screen.queryByTestId('library-status-bar')).not.toBeInTheDocument();
    });

    it('neither reads nor writes a signed-in visitor’s stored library view on a public share (FL-56)', async () => {
      authManager.setUser(userAdminFactory.build({ id: 'visitor' }));
      authManager.setPreferences(preferencesFactory.build());
      const restore = vi.spyOn(librarySession, 'restore');
      const persist = vi.spyOn(librarySession, 'persist');
      try {
        render(LibraryView, {
          options: { albumId: 'album-1' },
          destination: { kind: 'album', id: 'album-1' },
          syncUrl: false,
          publicView: true,
        });
        await waitFor(() => expect(persist).toHaveBeenCalled());

        expect(restore).toHaveBeenCalledWith(expect.anything(), undefined, expect.any(String));
        expect(restore.mock.calls.every(([, userId]) => userId === undefined)).toBe(true);
        expect(persist.mock.calls.every(([userId]) => userId === undefined)).toBe(true);
      } finally {
        restore.mockRestore();
        persist.mockRestore();
        authManager.reset();
      }
    });

    it('draws no status bar for a picking step', async () => {
      render(LibraryView, {
        options: { albumId: 'album-1' },
        destination: { kind: 'album', id: 'album-1' },
        syncUrl: false,
        noSelectionBar: true,
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());

      expect(screen.queryByTestId('library-status-bar')).not.toBeInTheDocument();
    });
  });

  describe('the results toolbar, empty state and library keys (FL-30, FL-33)', () => {
    const setupLibrary = async (props: Record<string, unknown> = {}) => {
      render(LibraryView, { options: {}, destination: { kind: 'library' }, syncUrl: false, ...props });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
    };

    afterEach(() => {
      librarySession.patchView({ query: emptyDiscoveryQuery(), sort: 'captured-desc' });
      librarySession.clearSelection();
    });

    it('gives a brand-new library a way forward and holds back the chrome that needs photos', async () => {
      await setupLibrary();
      const empty = await screen.findByTestId('frameleaf-library-empty');
      expect(within(empty).getByRole('status')).toBeInTheDocument();
      expect(empty).toHaveTextContent('frameleaf_library_first_run_title');
      expect(screen.getByRole('button', { name: 'frameleaf_library_first_run_upload' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'frameleaf_transfer_upload_folder' })).toBeInTheDocument();
      // Nothing to arrange yet: no layout switch, results toolbar or status capsule.
      expect(screen.queryByTestId('frameleaf-layout-switch')).not.toBeInTheDocument();
      expect(screen.queryByTestId('frameleaf-results-toolbar')).not.toBeInTheDocument();
      expect(screen.queryByTestId('library-status-bar')).not.toBeInTheDocument();
    });

    it('keeps the plain empty state, with no upload offer, on any other empty view (T-10)', async () => {
      render(LibraryView, {
        options: { albumId: 'album-1' },
        destination: { kind: 'album', id: 'album-1' },
        syncUrl: false,
        noSelectionBar: true,
      });
      const empty = await screen.findByTestId('frameleaf-library-empty');
      // the Frameleaf copy (TimelineLibrary.jsx `.tl-empty`): a status message, no upload card or button
      expect(within(empty).getByRole('status')).toBeInTheDocument();
      expect(empty.querySelector(':scope p')).toHaveTextContent('frameleaf_library_empty');
      expect(empty.querySelector(':scope button')).toBeNull();
    });

    it('says a filter left nothing, never how much it hides, and offers to clear it', async () => {
      sdkMock.searchAssetStatistics.mockResolvedValue({ total: 0 } as never);
      await setupLibrary();
      librarySession.patchView({
        query: { ...emptyDiscoveryQuery(), filter: { tagIds: { any: ['t1'] } } } as never,
      });
      const empty = await screen.findByTestId('frameleaf-library-empty');
      await waitFor(() => expect(empty).toHaveTextContent('frameleaf_library_empty_filtered_title'));
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_library_empty_filtered_clear' }));
      expect(librarySession.filterActive).toBe(false);
    });

    it('orders the timeline by the chosen sort where the page leaves ordering to it (S-15)', async () => {
      sdkMock.getTimeBuckets.mockResolvedValue([{ timeBucket: '2026-09-01', count: 3 }] as never);
      await setupLibrary();
      const sort = screen.getByRole('combobox', { name: 'frameleaf_library_sort' });
      await fireEvent.change(sort, { target: { value: 'captured-asc' } });
      await waitFor(() =>
        expect(sdkMock.getTimeBuckets).toHaveBeenLastCalledWith(expect.objectContaining({ order: 'asc' })),
      );
      await fireEvent.change(sort, { target: { value: 'imported-desc' } });
      await waitFor(() =>
        expect(sdkMock.getTimeBuckets).toHaveBeenLastCalledWith(
          expect.objectContaining({ order: 'desc', dateType: 'added' }),
        ),
      );
    });

    it('keeps the Timeline dated, and pages Browse by file name or rating (S-15)', async () => {
      sdkMock.getTimeBuckets.mockResolvedValue([{ timeBucket: '2026-09-01', count: 3 }] as never);
      await setupLibrary();
      const sort = () => screen.getByRole('combobox', { name: 'frameleaf_library_sort' }) as HTMLSelectElement;
      await fireEvent.change(sort(), { target: { value: 'filename' } });
      // The manager pages GET /timeline/ordered in that order (timeline-manager ordered mode).
      await waitFor(() =>
        expect(sdkMock.getTimeBuckets).toHaveBeenLastCalledWith(expect.objectContaining({ orderedBy: 'filename' })),
      );

      librarySession.setLayout('timeline');
      await tick();
      // The Timeline only turns newest-first or oldest-first; a flat sort leaves it dated.
      expect([...sort().options].filter((option) => !option.disabled).map((option) => option.value)).toEqual([
        'captured-desc',
        'captured-asc',
      ]);
      await waitFor(() =>
        expect(sdkMock.getTimeBuckets).toHaveBeenLastCalledWith(expect.not.objectContaining({ orderedBy: 'filename' })),
      );
      librarySession.setLayout('browse');
    });

    it('offers List outside the Timeline and draws rows (S-15)', async () => {
      await setupLibrary();
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_library_list_view' }));
      expect(librarySession.state.view).toBe('list');
      librarySession.setLayout('timeline');
      await tick();
      expect(screen.queryByRole('button', { name: 'frameleaf_library_list_view' })).not.toBeInTheDocument();
      librarySession.setLayout('browse');
      librarySession.patchView({ view: 'grid' });
    });

    it('draws no Sort where the page fixes its own order', async () => {
      await setupLibrary({ options: { dateType: 'added' } });
      expect(screen.queryByRole('combobox', { name: 'frameleaf_library_sort' })).not.toBeInTheDocument();
    });

    // Favorites, Archive and Recently added (prototype `.collection-header`): one row, not a bar above.
    it('draws a named destination’s title as the page heading, on the layout switch’s row', async () => {
      await setupLibrary({ options: { isFavorite: true }, destination: { kind: 'favorites' }, title: 'Favorites' });
      const heading = screen.getByRole('heading', { level: 1, name: 'Favorites' });
      expect(heading.closest('.fl-library-header')).toContainElement(screen.getByTestId('frameleaf-layout-switch'));
    });

    it('draws no heading of its own where the page gives no title', async () => {
      await setupLibrary({ options: { isFavorite: true }, destination: { kind: 'favorites' } });
      expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    });

    it('shows the information panel toggle in every layout and opens More library actions', async () => {
      sdkMock.getTimeBuckets.mockResolvedValue([{ timeBucket: '2026-09-01', count: 3 }] as never);
      await setupLibrary();
      expect(librarySession.layout).toBe('browse');
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_work_inspector_show' }));
      expect(screen.getByTestId('frameleaf-work-inspector')).toBeInTheDocument();

      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_library_more_actions' }));
      expect(await screen.findByRole('heading', { name: 'frameleaf_library_view_actions_title' })).toBeInTheDocument();
      // Compare lives on the selection bar only; the sheet does not repeat it.
      expect(screen.queryByRole('button', { name: 'frameleaf_library_compare_selected' })).not.toBeInTheDocument();
    });

    it('opens the Frameleaf shortcuts sheet on ?, with Done', async () => {
      await setupLibrary();
      await fireEvent.keyDown(document, { key: '?', shiftKey: true });
      expect(await screen.findByTestId('frameleaf-shortcuts-help')).toBeInTheDocument();
      expect(screen.getByText('frameleaf_shortcuts_note')).toBeInTheDocument();
      await fireEvent.click(screen.getByRole('button', { name: 'done' }));
      await waitFor(() => expect(screen.queryByTestId('frameleaf-shortcuts-help')).not.toBeInTheDocument());
    });
  });

  describe('the open item and the viewer (FL-31)', () => {
    const viewerSnippet = createRawSnippet(() => ({ render: () => '<div data-testid="viewer-host">viewer</div>' }));

    const setupWithViewer = async () => {
      render(LibraryView, {
        options: { albumId: 'album-1' },
        destination: { kind: 'album', id: 'album-1' },
        syncUrl: false,
        noSelectionBar: true,
        viewer: viewerSnippet,
      });
      await waitFor(() => expect(screen.getByTestId('frameleaf-library')).toBeInTheDocument());
      librarySession.setLayout('work');
      await tick();
    };

    afterEach(() => {
      assetViewerManager.showAssetViewer(false);
      librarySession.close();
    });

    it('gives the keys back to the library once the viewer has closed, though the item stays open', async () => {
      await setupWithViewer();
      librarySession.open('asset-1');
      await tick();
      expect(screen.getByTestId('frameleaf-work-inspector')).toBeInTheDocument();

      await fireEvent.keyDown(document, { key: 'i' });
      expect(screen.queryByTestId('frameleaf-work-inspector')).not.toBeInTheDocument();

      // Escape is not swallowed by an item the viewer no longer shows.
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(false);
      expect(librarySession.openAssetId).toBe('asset-1');
    });

    it('follows the viewer from item to item and leaves its keys to it', async () => {
      await setupWithViewer();
      const first = assetFactory.build({ id: 'viewer-1' });
      assetViewerManager.setAsset(first);
      await tick();
      expect(librarySession.openAssetId).toBe('viewer-1');
      expect(librarySession.session.scrollAnchor).toBe('viewer-1');
      librarySession.recordPlayhead('viewer-1', 12);

      assetViewerManager.setAsset(assetFactory.build({ id: 'viewer-2' }));
      await tick();
      expect(librarySession.openAssetId).toBe('viewer-2');
      expect(librarySession.playbackPosition).toBe(0);

      await fireEvent.keyDown(document, { key: 'i' });
      expect(screen.getByTestId('frameleaf-work-inspector')).toBeInTheDocument();
    });

    it('returns from editing to the same page: query, selection, layout and the edited item', async () => {
      await setupWithViewer();
      librarySession.setQuery({ ...emptyDiscoveryQuery(), filter: { isFavorite: { eq: true } } });
      librarySession.select('asset-a');
      librarySession.select('asset-b');
      const before = { state: librarySession.state, selection: [...librarySession.selection] };

      assetViewerManager.setAsset(assetFactory.build({ id: 'edited' }));
      assetViewerManager.openEditor();
      await tick();
      assetViewerManager.closeEditor();
      assetViewerManager.showAssetViewer(false);
      await tick();

      expect(librarySession.state).toEqual(before.state);
      expect(librarySession.selection).toEqual(before.selection);
      expect(librarySession.layout).toBe('work');
      expect(librarySession.openAssetId).toBe('edited');
      expect(librarySession.session.scrollAnchor).toBe('edited');
      librarySession.clearSelection();
      librarySession.setQuery(emptyDiscoveryQuery());
    });

    it('drops an item trashed or deleted elsewhere from the selection and the open item (FL-33)', async () => {
      const subscribe = vi.spyOn(TimelineManager.prototype, 'onRemoved');
      await setupWithViewer();
      const manager = subscribe.mock.contexts.at(-1) as TimelineManager;
      librarySession.select('kept');
      librarySession.select('gone');
      librarySession.open('open-gone', 30);

      // what the live on_asset_trash / on_asset_delete events do to the timeline
      manager.removeAssets(['gone', 'open-gone']);

      expect(librarySession.selection).toEqual(['kept']);
      expect(librarySession.openAssetId).toBeUndefined();
      librarySession.clearSelection();
      subscribe.mockRestore();
    });

    it('keeps the viewer, and whatever it is editing, mounted across a layout switch', async () => {
      await setupWithViewer();
      assetViewerManager.setAsset(assetFactory.build({ id: 'viewer-1' }));
      await tick();
      const host = screen.getByTestId('viewer-host');
      for (const layout of ['timeline', 'browse', 'work'] as const) {
        librarySession.setLayout(layout);
        await tick();
        expect(screen.getByTestId('viewer-host')).toBe(host);
      }
      expect(librarySession.openAssetId).toBe('viewer-1');
    });
  });
});
