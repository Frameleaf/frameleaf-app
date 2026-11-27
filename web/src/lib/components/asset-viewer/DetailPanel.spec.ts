import type { ServerFeaturesDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { faceManager } from '$lib/stores/face.svelte';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import DetailPanel from './DetailPanel.svelte';

vi.mock('$lib/components/asset-viewer/DetailPanelCameraIdentification.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/asset-viewer/DetailPanelDate.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/asset-viewer/DetailPanelDescription.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/asset-viewer/DetailPanelImageEnrichment.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/asset-viewer/DetailPanelLocation.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/asset-viewer/DetailPanelStarRating.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/asset-viewer/DetailPanelClassification.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/asset-viewer/DetailPanelTags.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/asset-viewer/DetailPanelPets.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/DocumentTextSection.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/VideoMomentsPanel.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/ViewerDetailRows.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/asset-viewer/DetailPanelScanSplit.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/asset-viewer/DetailPanelPrintBack.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/asset-viewer/DetailPanelPeople.svelte', async () => ({
  default: (await import('@test-data/components/DetailPanelBoundaryFixture.svelte')).default,
}));
vi.mock('$lib/components/shared-components/map/Map.svelte', async () => ({
  default: (await import('@test-data/components/DetailPanelBoundaryFixture.svelte')).default,
}));
beforeEach(() => {
  vi.resetAllMocks();
  authManager.setUser(userAdminFactory.build({ id: 'owner' }));
  authManager.setPreferences(preferencesFactory.build());
  sdkMock.getAllAlbums.mockResolvedValue([]);
  vi.spyOn(featureFlagsManager, 'value', 'get').mockReturnValue({ map: true } as ServerFeaturesDto);
});
afterEach(() => vi.restoreAllMocks());

it.each([
  [0, 20],
  [10, 0],
  [10.123456789, 20.123456789],
])('passes coordinates %s,%s through to the map', async (lat, lng) => {
  const asset = assetFactory.build({ exifInfo: { latitude: lat, longitude: lng } });
  render(DetailPanel, { asset });
  const output = await screen.findByTestId('map-input');
  const input = JSON.parse(output.textContent!);
  expect(input.center).toEqual({ lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) });
  expect(input.mapMarkers[0]).toMatchObject({ id: asset.id, lat: input.center.lat, lon: input.center.lng });
});

it.each(['current', 'replace', 'return', 'close', 'session'])(
  'keeps people refresh with the original panel: %s',
  async (change) => {
    const asset = assetFactory.build({ ownerId: 'owner' });
    const pending = deferredPromise<typeof asset>();
    sdkMock.getAssetInfo.mockReturnValueOnce(pending.promise);
    const clear = vi.spyOn(faceManager, 'clear').mockImplementation(() => {});
    const faces = vi.spyOn(faceManager, 'getAssetFaces').mockResolvedValue();
    const onAssetUpdate = vi.fn();
    const view = render(DetailPanel, { asset, onAssetUpdate });
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh people' }));
    await waitFor(() => expect(sdkMock.getAssetInfo).toHaveBeenCalledWith({ id: asset.id }));
    if (change === 'replace' || change === 'return') {
      await view.rerender({ asset: assetFactory.build() });
    }
    switch (change) {
      case 'return': {
        await view.rerender({ asset });
        break;
      }
      case 'close': {
        view.unmount();
        break;
      }
      case 'session': {
        authManager.reset();
        break;
      }
      // No default
    }
    pending.resolve(asset);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAssetUpdate).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
    expect(clear).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
    if (change === 'current') {
      expect(faces).toHaveBeenCalledWith(asset.id);
    } else {
      expect(faces).not.toHaveBeenCalled();
    }
  },
);

it.each([
  [0, 0],
  [undefined, 20],
  [10, null],
  [NaN, 20],
  [91, 20],
])('omits absent or invalid coordinates %s,%s', async (latitude, longitude) => {
  render(DetailPanel, { asset: assetFactory.build({ exifInfo: { latitude, longitude } }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByTestId('map-input')).not.toBeInTheDocument();
});

// FL-1811 (prototype PR 102): what stays open, what folds, and in which order.
describe('open sections and folds (FL-1811)', () => {
  it('folds the scan and the text away, closed, after the open sections', async () => {
    render(DetailPanel, { asset: assetFactory.build({ ownerId: 'owner' }) });
    await waitFor(() => expect(sdkMock.getAllAlbums).toHaveBeenCalled());
    const folds = [...document.querySelectorAll<HTMLDetailsElement>('.fl-info > details[data-fold]')];
    expect(folds.map((fold) => [fold.dataset.fold, fold.open])).toEqual([
      ['scan', false],
      ['text', false],
    ]);
    expect(folds.map((fold) => fold.querySelector('summary')?.textContent?.trim())).toEqual([
      'frameleaf_info_fold_scan',
      'frameleaf_documents_text_in_photo',
    ]);
    // Captured is the first band, and nothing that folds comes before the open sections end.
    const panel = document.querySelector('.fl-info')!;
    expect(panel.firstElementChild).toHaveTextContent('frameleaf_info_captured');
    expect(folds[0].nextElementSibling).toBe(folds[1]);
  });

  it('keeps the albums the item appears in open, above the folds', async () => {
    sdkMock.getAllAlbums.mockResolvedValue([{ id: 'album-1', albumName: 'Summer', albumUsers: [] }] as never);
    render(DetailPanel, { asset: assetFactory.build({ ownerId: 'owner' }) });
    const albums = (await screen.findByText('appears_in')).closest('section')!;
    expect(albums.closest('details')).toBeNull();
    const scan = document.querySelector('details[data-fold="scan"]')!;
    expect(albums.compareDocumentPosition(scan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
