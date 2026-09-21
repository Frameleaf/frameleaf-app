import { getAssetInfo, getAllAlbums } from '@immich/sdk';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import DetailPanel from './DetailPanel.svelte';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  getAssetInfo: vi.fn(),
  getAllAlbums: vi.fn(),
}));
vi.mock('$lib/components/faces-page/PersonSidePanel.svelte', async () => {
  const { default: Component } = await import('@test-data/components/MockDetailRefresh.svelte');
  return { default: Component };
});
vi.mock('$lib/components/asset-viewer/DetailPanelImageEnrichment.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/asset-viewer/DetailPanelTags.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/shared-components/UserAvatar.svelte', () => ({ default: () => {} }));
vi.mock('$lib/stores/face.svelte', () => ({
  faceManager: { clear: vi.fn(), getAssetFaces: vi.fn(), data: [], people: [], facesByPersonId: new Map() },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: {} } }));
afterEach(() => vi.clearAllMocks());

it.each(['lock', 'account', 'dispose'] as const)('drops the people refresh callback after %s', async (change) => {
  const user = userAdminFactory.build();
  authManager.setUser(user);
  authManager.setPreferences(preferencesFactory.build());
  eventManager.emit('AuthUserLoaded', user);
  const asset = assetFactory.build({ ownerId: user.id });
  assetViewerManager.setAsset(asset);
  assetViewerManager.openEditFacesPanel();
  vi.mocked(getAllAlbums).mockResolvedValue([]);
  let resolve!: (value: typeof asset) => void;
  vi.mocked(getAssetInfo).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const onAssetUpdate = vi.fn();
  const view = renderWithTooltips(DetailPanel, { asset, onAssetUpdate });
  await fireEvent.click(await screen.findByRole('button', { name: 'Refresh people' }));
  await waitFor(() => expect(getAssetInfo).toHaveBeenCalledOnce());
  if (change === 'lock') {
    eventManager.emit('SessionLocked');
  } else if (change === 'account') {
    eventManager.emit('AuthUserLoaded', userAdminFactory.build());
  } else {
    view.unmount();
  }
  resolve(asset);
  await new Promise((done) => setTimeout(done, 0));
  expect(onAssetUpdate).not.toHaveBeenCalled();
});

it('delivers a current people refresh across harmless unlock and same-account refresh', async () => {
  const user = userAdminFactory.build();
  authManager.setUser(user);
  authManager.setPreferences(preferencesFactory.build());
  eventManager.emit('AuthUserLoaded', user);
  const asset = assetFactory.build({ ownerId: user.id });
  assetViewerManager.setAsset(asset);
  assetViewerManager.openEditFacesPanel();
  vi.mocked(getAllAlbums).mockResolvedValue([]);
  let resolve!: (value: typeof asset) => void;
  vi.mocked(getAssetInfo).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const onAssetUpdate = vi.fn();
  renderWithTooltips(DetailPanel, { asset, onAssetUpdate });
  await fireEvent.click(await screen.findByRole('button', { name: 'Refresh people' }));
  eventManager.emit('SessionAccessChanged', { isElevated: true });
  eventManager.emit('AuthUserLoaded', user);
  resolve(asset);
  await waitFor(() => expect(onAssetUpdate).toHaveBeenCalledWith(asset));
});
