import type { AssetResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { mapRouteStub } from '@test-data/frameleaf/map-route-stub';
import type { PageData } from './$types';
import MapPage from './+page.svelte';

vi.mock('$lib/components/frameleaf/MapScreen.svelte', async () => ({
  default: (await import('@test-data/frameleaf/MapScreenStub.svelte')).default,
}));
vi.mock('$lib/components/asset-viewer/AssetViewer.svelte', async () => ({
  default: (await import('@test-data/frameleaf/MapViewerStub.svelte')).default,
}));
vi.mock('$lib/components/layouts/UserPageLayout.svelte', async () => ({
  default: (await import('@test-data/mocks/UserPageLayout.mock.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/PlacesRestoringNotice.svelte', async () => ({
  default: (await import('@test-data/frameleaf/EmptyStub.svelte')).default,
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: { map: true } } }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { params: {}, authenticated: true, user: { id: 'user-1' }, captureSession: () => () => true },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/utils/navigation', () => ({ navigate: vi.fn() }));

const data = { meta: { title: 'Map' } } as PageData;

describe('map route viewer (FL-1216)', () => {
  beforeEach(() => {
    sdkMock.getAssetInfo.mockImplementation(({ id }) => Promise.resolve({ id } as AssetResponseDto));
  });
  afterEach(() => {
    assetViewerManager.showAssetViewer(false);
  });

  it('reads the next page of in-view items when the viewer reaches the last one read', async () => {
    const more = vi.fn<() => Promise<string[]>>().mockResolvedValueOnce(['c']).mockResolvedValue([]);
    render(MapPage, { data });
    mapRouteStub.open?.('a', ['a', 'b'], more);

    await fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('viewer-current')).toHaveTextContent('b'));
    // on the last item read, the next page is read and next goes on to it
    await waitFor(() => expect(more).toHaveBeenCalledTimes(1));
    await fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('viewer-current')).toHaveTextContent('c'));

    // past the last page there is nothing more to step to
    await waitFor(() => expect(more).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(more).toHaveBeenCalledTimes(2);
  });

  it('reads nothing more when every item in view was passed', async () => {
    render(MapPage, { data });
    mapRouteStub.open?.('a', ['a', 'b']);

    await fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('viewer-current')).toHaveTextContent('b'));
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });
});
