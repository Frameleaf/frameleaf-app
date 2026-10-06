import {
  AssetRestorationMode,
  AssetRestorationRoute,
  AssetRestorationSourceType,
  AssetRestorationStatus,
  AssetTypeEnum,
  MlDestinationKind,
  type AssetRestorationResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { assetFactory } from '@test-data/factories/asset-factory';
import RestorationPanel from './RestorationPanel.svelte';

vi.mock('$lib/frameleaf/activity-session.svelte', () => ({
  activitySession: { watch: () => () => {}, operations: [], refresh: vi.fn(), cancel: vi.fn(), retry: vi.fn() },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { params: {} } }));

const asset = assetFactory.build({ type: AssetTypeEnum.Video, id: 'asset-1' });

const item = (overrides: Partial<AssetRestorationResponseDto> = {}) =>
  ({
    id: 'restoration-1',
    assetId: asset.id,
    revision: 1,
    status: AssetRestorationStatus.Restored,
    mode: AssetRestorationMode.Faithful,
    upscale: 2,
    smoothMotionFactor: null,
    keepGrain: false,
    destinationId: 'lan',
    destinationKind: MlDestinationKind.Lan,
    destinationName: 'Garage GPU',
    sourceType: AssetRestorationSourceType.Video,
    hasPreview: true,
    hasResult: true,
    isCurrent: false,
    activeOperationId: null,
    error: null,
    createdAt: '2026-09-27T10:00:00.000Z',
    updatedAt: '2026-09-27T10:00:00.000Z',
    restoredAt: '2026-09-27T10:00:00.000Z',
    ...overrides,
  }) as AssetRestorationResponseDto;

describe('RestorationPanel Use in Studio (FL-115)', () => {
  beforeEach(() => {
    sdkMock.getAssetRestorationOptions.mockResolvedValue({
      assetId: asset.id,
      sourceType: AssetRestorationSourceType.Video,
      sourceWidth: 1920,
      sourceHeight: 1080,
      durationSeconds: 20,
      mode: AssetRestorationMode.Faithful,
      workload: 'restoration-faithful',
      upscale: 2,
      outputWidth: 3840,
      outputHeight: 2160,
      previewSeconds: 5,
      adapterInstalled: true,
      destinations: [],
    } as never);
  });

  it('opens Studio with the restored version beside the original, never replacing it', async () => {
    sdkMock.getAssetRestorations.mockResolvedValue({ assetId: asset.id, currentRestorationId: null, items: [item()] });
    render(RestorationPanel, { asset, onCompare: vi.fn() });

    const link = await screen.findByTestId('restoration-use-in-studio');
    expect(link.getAttribute('href')).toBe('/studio?restored=restoration-1&from=asset-1');
    expect(sdkMock.setCurrentAssetRestoration).not.toHaveBeenCalled();
  });

  it('inside Studio, hands the version to the open project instead of navigating', async () => {
    sdkMock.getAssetRestorations.mockResolvedValue({ assetId: asset.id, currentRestorationId: null, items: [item()] });
    const onUseInStudio = vi.fn();
    render(RestorationPanel, { asset, onCompare: vi.fn(), onUseInStudio });

    await fireEvent.click(await screen.findByTestId('restoration-use-in-studio'));
    expect(onUseInStudio).toHaveBeenCalledWith(expect.objectContaining({ id: 'restoration-1' }));
  });

  it('offers nothing for a preview, a discarded version or one still rendering', async () => {
    sdkMock.getAssetRestorations.mockResolvedValue({
      assetId: asset.id,
      currentRestorationId: null,
      items: [
        item({ id: 'a', status: AssetRestorationStatus.PreviewReady, hasResult: false }),
        item({ id: 'b', status: AssetRestorationStatus.Discarded, hasResult: false }),
        item({ id: 'c', status: AssetRestorationStatus.Restoring, hasResult: false }),
      ],
    });
    render(RestorationPanel, { asset, onCompare: vi.fn() });

    await screen.findAllByText(/frameleaf_restoration_item_title/);
    expect(screen.queryByTestId('restoration-use-in-studio')).not.toBeInTheDocument();
  });
});

describe('RestorationPanel Smooth motion (FL-162, FL-159)', () => {
  const smoothOptions = (overrides: Record<string, unknown> = {}) =>
    ({
      assetId: asset.id,
      sourceType: AssetRestorationSourceType.Video,
      sourceWidth: 1920,
      sourceHeight: 1080,
      durationSeconds: 20,
      mode: AssetRestorationMode.SmoothMotion,
      workload: 'interpolation',
      upscale: 1,
      outputWidth: 1920,
      outputHeight: 1080,
      previewSeconds: 5,
      adapterInstalled: true,
      route: AssetRestorationRoute.Local,
      destinations: [
        {
          id: 'lan',
          kind: MlDestinationKind.Lan,
          name: 'Garage GPU',
          health: 'healthy',
          available: true,
          leavesNetwork: false,
          consentRequired: false,
          consentGranted: true,
          refusal: null,
          refusalDetail: null,
          estimate: { sampleCount: 0, bytesPerSecond: null, windowDays: 30, previewBytes: 0, fullBytes: 0 },
          gpu: { name: 'NVIDIA RTX 4070', memoryTotalBytes: 12 * 1024 ** 3 },
        },
      ],
      ...overrides,
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getAssetRestorations.mockResolvedValue({ assetId: asset.id, currentRestorationId: null, items: [] });
    sdkMock.getAssetRestorationOptions.mockImplementation(({ mode }: { mode?: AssetRestorationMode }) =>
      Promise.resolve(
        mode === AssetRestorationMode.SmoothMotion
          ? smoothOptions()
          : smoothOptions({ mode: AssetRestorationMode.Faithful, destinations: [] }),
      ),
    );
  });

  it('shows the model slider and previews Smooth motion on the home worker, as a new version', async () => {
    sdkMock.requestAssetRestoration.mockResolvedValue(
      item({ id: 'smooth-1', mode: AssetRestorationMode.SmoothMotion }),
    );
    render(RestorationPanel, { asset, onCompare: vi.fn() });

    expect(await screen.findByRole('group', { name: 'frameleaf_restoration_smooth_motion_model' })).toBeInTheDocument();
    const factors = screen.getByRole('radiogroup', { name: 'frameleaf_restoration_smooth_motion_factor_label' });
    await fireEvent.click(within(factors).getAllByRole('radio')[1]);
    const preview = await screen.findByRole('button', { name: /frameleaf_restoration_smooth_motion_preview/ });
    await fireEvent.click(preview);

    expect(sdkMock.requestAssetRestoration).toHaveBeenCalledWith({
      id: asset.id,
      assetRestorationRequestDto: expect.objectContaining({
        mode: AssetRestorationMode.SmoothMotion,
        upscale: 1,
        smoothMotionFactor: 4,
        destinationId: 'lan',
      }),
    });
    expect(sdkMock.estimateCloudMlJob).not.toHaveBeenCalled();
  });

  it('says so when no home worker runs Smooth motion, and sends nothing', async () => {
    sdkMock.getAssetRestorationOptions.mockResolvedValue(smoothOptions({ destinations: [] }));
    render(RestorationPanel, { asset, onCompare: vi.fn() });

    const area = await screen.findByTestId('restoration-smooth-motion');
    await waitFor(() => expect(area).toHaveTextContent('frameleaf_restoration_smooth_motion_no_local'));
    expect(sdkMock.requestAssetRestoration).not.toHaveBeenCalled();
  });
});
