import type { AssetResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LargeFilesUtility from '$lib/components/frameleaf/LargeFilesUtility.svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { navigate } from '$lib/utils/navigation';
import en from '../../../../../i18n/en.json';

const pageState = vi.hoisted(() => ({ url: new URL('http://localhost/utilities/large-files') }));

vi.mock('$app/state', () => ({
  page: {
    get url() {
      return pageState.url;
    },
  },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    params: {},
    user: { id: 'me', name: 'Taylor', isAdmin: false },
    captureSession: () => () => true,
  },
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

const asset = (id: string, bytes: number) =>
  ({
    id,
    ownerId: 'me',
    originalFileName: `${id}.mov`,
    originalPath: `/library/${id}.mov`,
    originalMimeType: 'video/quicktime',
    thumbhash: null,
    exifInfo: { fileSizeInByte: bytes },
  }) as unknown as AssetResponseDto;

const big = asset('big', 9_000_000);
const mid = asset('mid', 5_000_000);

/** Navigation that lands on the item, as the router does once it succeeds. */
const landOn = (assetId: string | null | undefined) => {
  pageState.url = new URL('http://localhost/utilities/large-files');
  if (assetId) {
    pageState.url.searchParams.set('assetId', assetId);
  }
};

const setup = () => render(LargeFilesUtility, { data: { tool: 'large-files', assets: [big, mid] } as never });

const open = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Open ${name}` }));

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  landOn(null);
  sdkMock.getPartners.mockResolvedValue([]);
  sdkMock.getUtilityActivity.mockResolvedValue({ entries: [] });
  sdkMock.getAssetInfo.mockImplementation(({ id }) => Promise.resolve(id === 'mid' ? mid : big));
  vi.mocked(navigate).mockImplementation(({ assetId }) => {
    landOn(assetId);
    return Promise.resolve();
  });
  assetViewerManager.showAssetViewer(false);
});

describe('LargeFilesUtility (FL-47): opening an item', () => {
  it('leaves the viewer closed when navigation to the item fails', async () => {
    vi.mocked(navigate).mockRejectedValue(new Error('navigation failed'));
    setup();

    await open('big.mov');

    await waitFor(() => expect(handleError).toHaveBeenCalled());
    expect(assetViewerManager.isViewing).toBe(false);
    expect(assetViewerManager.asset).toBeUndefined();
  });

  it('shows the item once navigation succeeds', async () => {
    setup();

    await open('big.mov');

    await waitFor(() => expect(assetViewerManager.asset?.id).toBe('big'));
    expect(assetViewerManager.isViewing).toBe(true);
    expect(handleError).not.toHaveBeenCalled();
  });

  it('does not show an item whose navigation was overtaken by a later open', async () => {
    let finishFirst = () => {};
    vi.mocked(navigate).mockImplementationOnce(
      ({ assetId }) =>
        new Promise<void>((resolve) => {
          finishFirst = () => {
            landOn(assetId);
            resolve();
          };
        }),
    );
    setup();

    await open('big.mov');
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    await open('mid.mov');
    await waitFor(() => expect(assetViewerManager.asset?.id).toBe('mid'));

    finishFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(assetViewerManager.asset?.id).toBe('mid');
  });

  it('does not show the item when the address moved away before navigation finished', async () => {
    vi.mocked(navigate).mockImplementation(() => {
      landOn(null);
      return Promise.resolve();
    });
    setup();

    await open('big.mov');

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    await Promise.resolve();
    expect(assetViewerManager.isViewing).toBe(false);
    expect(handleError).not.toHaveBeenCalled();
  });
});
