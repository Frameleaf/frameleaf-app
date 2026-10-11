import { AssetTypeEnum, AssetVisibility, DynamicRange } from '@frameleaf/sdk';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { setSharedLink } from '$lib/utils';
import { downloadAssetFile } from '$lib/utils/asset-utils';
import { assetFactory } from '@test-data/factories/asset-factory';
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
