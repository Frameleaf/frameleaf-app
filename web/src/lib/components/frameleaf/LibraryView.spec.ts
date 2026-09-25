import { AssetOrder, AssetVisibility } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
import { librarySession } from '$lib/frameleaf/library-session.svelte';
import LibraryView from './LibraryView.svelte';

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { init: vi.fn(), value: { smartSearch: true, trash: true, map: true } },
}));

const navigation = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$app/navigation')>()),
  goto: navigation.goto,
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
  sdkMock.getTimeBuckets.mockResolvedValue([]);
});

afterEach(() => {
  librarySession.setLayout('browse');
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
    afterEach(() => localStorage.removeItem('frameleaf.albumViewSort'));

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
      expect(JSON.parse(localStorage.getItem('frameleaf.albumViewSort') ?? '{}')).toEqual({ 'album-1': 'filename' });
      // the library's own sort and the album's shared order are untouched
      expect(librarySession.state.sort).toBe(sessionSort);
      expect(sdkMock.updateAlbumInfo).not.toHaveBeenCalled();
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

      expect(screen.getByTestId('selection-leading-compare')).toBeDisabled();
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

    it('shows the Frameleaf empty state, not the legacy upload card (T-10)', async () => {
      await setupLibrary();
      const empty = await screen.findByTestId('frameleaf-library-empty');
      // the Frameleaf copy (TimelineLibrary.jsx `.tl-empty`): a status message, no upload card or button
      expect(empty).toHaveAttribute('role', 'status');
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

    it('shows the information panel toggle in every layout and opens More library actions', async () => {
      await setupLibrary();
      expect(librarySession.layout).toBe('browse');
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_work_inspector_show' }));
      expect(screen.getByTestId('frameleaf-work-inspector')).toBeInTheDocument();

      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_library_more_actions' }));
      expect(await screen.findByRole('heading', { name: 'frameleaf_library_actions_title' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'frameleaf_library_compare_selected' })).toBeDisabled();
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
});
