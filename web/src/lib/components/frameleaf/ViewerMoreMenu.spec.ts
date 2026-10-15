import { AssetTypeEnum, AssetVisibility, DynamicRange } from '@frameleaf/sdk';
import { modalManager } from '@frameleaf/ui';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { setSharedLink } from '$lib/utils';
import { downloadAssetFile } from '$lib/utils/asset-utils';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import { personFactory } from '@test-data/factories/person-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import ViewerMoreMenu from './ViewerMoreMenu.svelte';

const features = vi.hoisted(() => ({
  value: {
    smartSearch: false,
    imageCapabilities: { experimentalEnabled: true, export: ['sdr-jpeg', 'hdr-jpeg', 'hdr-heic'] },
  },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: features }));

vi.mock('$lib/utils/asset-utils', async (original) => ({
  ...(await original<typeof import('$lib/utils/asset-utils')>()),
  downloadAssetFile: vi.fn(),
}));

beforeEach(() => {
  authManager.reset();
  authManager.setPreferences(preferencesFactory.build());
  authManager.setUser(userAdminFactory.build({ id: 'owner' }));
  setSharedLink(undefined);
  sdkMock.getAllAlbums.mockResolvedValue([]);
});
afterEach(() => {
  authManager.reset();
  vi.clearAllMocks();
});

it('exports an unedited Live Photo as a separate still through the download manager', async () => {
  const asset = assetFactory.build({
    ownerId: 'owner',
    originalFileName: 'IMG.HEIC',
    type: AssetTypeEnum.Image,
    isEdited: false,
    livePhotoVideoId: 'motion',
  });
  render(ViewerMoreMenu, { asset, preAction: vi.fn(), onAction: vi.fn() });
  await fireEvent.click(screen.getByText('frameleaf_editor_export_sdr_jpeg'));
  expect(downloadAssetFile).toHaveBeenCalledWith({
    id: asset.id,
    filename: 'IMG_still_sdr-jpeg.jpg',
    edited: false,
    format: 'sdr-jpeg',
  });
  expect(asset.livePhotoVideoId).toBe('motion');
});

it.each([
  { isEdited: true },
  { visibility: AssetVisibility.Locked },
  { isTrashed: true },
  { duration: 1 },
  { type: AssetTypeEnum.Video },
])('hides original conversion for an unavailable still: %j', (overrides) => {
  render(ViewerMoreMenu, {
    asset: assetFactory.build({ ownerId: 'owner', type: AssetTypeEnum.Image, ...overrides }),
    preAction: vi.fn(),
    onAction: vi.fn(),
  });
  expect(screen.queryByText('frameleaf_editor_export_sdr_jpeg')).not.toBeInTheDocument();
});

it('offers the server HDR formats only for a reconstructible HDR original', () => {
  render(ViewerMoreMenu, {
    asset: assetFactory.build({
      ownerId: 'owner',
      type: AssetTypeEnum.Image,
      imageEncoding: { dynamicRange: DynamicRange.Hdr, reconstructionAvailable: true, gainMap: 'ultra-hdr' },
    }),
    preAction: vi.fn(),
    onAction: vi.fn(),
  });
  expect(screen.getByText('frameleaf_editor_export_hdr_jpeg')).toBeInTheDocument();
  expect(screen.getByText('frameleaf_editor_export_hdr_heic')).toBeInTheDocument();
});

// The ticked image display choice has a tick and the other has no icon; both keep the icon slot, so
// the label of the one that is not ticked lines up with every other row of the menu.
it('keeps the icon slot on the image display choice that is not ticked', () => {
  render(ViewerMoreMenu, {
    asset: assetFactory.build({ ownerId: 'owner', type: AssetTypeEnum.Image }),
    preAction: vi.fn(),
    onAction: vi.fn(),
  });
  const ticked = screen.getByRole('menuitem', { name: /frameleaf_image_display_auto/ });
  const other = screen.getByRole('menuitem', { name: /frameleaf_image_display_sdr/ });
  for (const row of [ticked, other, screen.getByRole('menuitem', { name: 'download' })]) {
    expect(row.firstElementChild).toHaveClass('fl-menu-option-icon');
  }
  expect(ticked.firstElementChild?.querySelector('svg')).not.toBeNull();
  expect(other.firstElementChild?.querySelector('svg')).toBeNull();
});

it.each(['chooser', 'request', 'session'])('keeps featured-photo selection owned across %s', async (change) => {
  const person = personFactory.build({ isHidden: false, name: 'Person' });
  const original = assetFactory.build({ ownerId: 'owner', type: AssetTypeEnum.Image, people: [person] });
  const replacement = assetFactory.build({ ownerId: 'owner', type: AssetTypeEnum.Image });
  const chooser = deferredPromise<{ kind: 'person'; person: typeof person }>();
  const request = deferredPromise<typeof person>();
  const dialog = vi.spyOn(modalManager, 'show').mockReturnValue(chooser.promise);
  sdkMock.updatePerson.mockReturnValueOnce(request.promise);
  const onAction = vi.fn();
  const props = { asset: original, preAction: vi.fn(), onAction };
  const view = render(ViewerMoreMenu, props);
  try {
    await fireEvent.click(screen.getByRole('menuitem', { name: 'frameleaf_viewer_menu_person_featured' }));
    if (change === 'chooser') {
      await view.rerender({ ...props, asset: replacement });
    }
    if (change === 'session') {
      authManager.reset();
    }
    chooser.resolve({ kind: 'person', person });
    if (change === 'session') {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sdkMock.updatePerson).not.toHaveBeenCalled();
      request.resolve(person);
      return;
    }
    await waitFor(() => expect(sdkMock.updatePerson).toHaveBeenCalled());
    if (change === 'request') {
      await view.rerender({ ...props, asset: replacement });
    }
    request.resolve(person);
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    expect(sdkMock.updatePerson).toHaveBeenCalledWith({
      id: person.id,
      personUpdateDto: { featureFaceAssetId: original.id },
    });
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ asset: original }));
  } finally {
    request.resolve(person);
    dialog.mockRestore();
  }
});
