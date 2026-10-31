import type { AssetResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LargeFilesUtility from '$lib/components/frameleaf/LargeFilesUtility.svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { navigate } from '$lib/utils/navigation';
import en from '../../../../../i18n/en.json';

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/utilities/large-files') },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { params: {}, user: { id: 'me', name: 'Taylor', isAdmin: false } },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { trash: true } },
}));
vi.mock('$lib/stores/websocket', () => ({
  websocketEvents: { on: vi.fn(() => () => {}) },
}));
vi.mock('$lib/utils/navigation', () => ({
  navigate: vi.fn(),
  isSharedLinkRoute: () => false,
}));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const asset = {
  id: 'big',
  ownerId: 'me',
  originalFileName: 'big.mov',
  originalPath: '/library/big.mov',
  originalMimeType: 'video/quicktime',
  thumbhash: null,
  exifInfo: { fileSizeInByte: 9_000_000 },
} as unknown as AssetResponseDto;

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  sdkMock.getPartners.mockResolvedValue([]);
  sdkMock.getUtilityActivity.mockResolvedValue({ entries: [] });
  sdkMock.getAssetInfo.mockResolvedValue(asset);
  assetViewerManager.showAssetViewer(false);
});

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Open big.mov' }));

describe('LargeFilesUtility (FL-47): opening an item', () => {
  it('leaves the viewer closed when navigation to the item fails', async () => {
    vi.mocked(navigate).mockRejectedValue(new Error('navigation failed'));
    render(LargeFilesUtility, { data: { tool: 'large-files', assets: [asset] } as never });

    await open();

    await waitFor(() => expect(handleError).toHaveBeenCalled());
    expect(assetViewerManager.isViewing).toBe(false);
    expect(assetViewerManager.asset).toBeUndefined();
  });

  it('shows the item once navigation succeeds', async () => {
    vi.mocked(navigate).mockResolvedValue(undefined);
    render(LargeFilesUtility, { data: { tool: 'large-files', assets: [asset] } as never });

    await open();

    await waitFor(() => expect(assetViewerManager.asset?.id).toBe('big'));
    expect(handleError).not.toHaveBeenCalled();
  });
});
