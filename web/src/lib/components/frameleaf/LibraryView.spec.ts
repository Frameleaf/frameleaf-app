import { render, screen, waitFor } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { librarySession } from '$lib/frameleaf/library-session.svelte';
import LibraryView from './LibraryView.svelte';

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { init: vi.fn(), value: { smartSearch: true, trash: true, map: true } },
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

  it('draws no layout switch, Filter menu or Work panel on a public shared-link page', async () => {
    await setup(true);
    expect(screen.queryByTestId('frameleaf-results-toolbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'frameleaf_library_layout' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('work-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('frameleaf-library')).toHaveAttribute('data-layout', 'browse');
  });
});
