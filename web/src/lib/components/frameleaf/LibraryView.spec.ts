import { AssetVisibility } from '@immich/sdk';
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
        query: { ...emptyDiscoveryQuery(), filter: { isFavorite: { eq: true } } } as never,
      });

      await waitFor(() => expect(sdkMock.searchAssetStatistics).toHaveBeenCalledOnce());
      await waitFor(() => expect(librarySession.total).toBe(7));
      // One count per result set: re-rendering does not ask again.
      await tick();
      expect(sdkMock.searchAssetStatistics).toHaveBeenCalledOnce();
      librarySession.patchView({ query: emptyDiscoveryQuery() });
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
});
