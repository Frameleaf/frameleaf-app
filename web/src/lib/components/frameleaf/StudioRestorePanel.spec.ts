import {
  AssetRestorationMode,
  AssetRestorationRoute,
  AssetRestorationSourceType,
  AssetRestorationStatus,
  AssetTypeEnum,
  MlDestinationKind,
  type AssetRestorationResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import type { StudioAssetRef } from '$lib/frameleaf/studio/host-contract';
import { assetFactory } from '@test-data/factories/asset-factory';
import StudioRestorePanel from './StudioRestorePanel.svelte';

vi.mock('$lib/frameleaf/activity-session.svelte', () => ({
  activitySession: { watch: () => () => {}, operations: [], refresh: vi.fn(), cancel: vi.fn(), retry: vi.fn() },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { params: {} } }));

const video = assetFactory.build({ id: 'video-1', type: AssetTypeEnum.Video, originalFileName: 'lake.mp4' });

const ref = (id: string, name: string, overrides: Partial<StudioAssetRef> = {}): StudioAssetRef => ({
  id,
  kind: 'video',
  name,
  duration: null,
  thumbnailUrl: '',
  previewUrl: '',
  playbackUrl: null,
  isOffline: false,
  ...overrides,
});

const finished = {
  id: 'restoration-1',
  assetId: video.id,
  revision: 1,
  status: AssetRestorationStatus.Restored,
  mode: AssetRestorationMode.Faithful,
  upscale: 2,
  destinationKind: MlDestinationKind.Lan,
  destinationName: 'Garage GPU',
  sourceType: AssetRestorationSourceType.Video,
  hasResult: true,
  isCurrent: false,
  createdAt: '2026-09-27T10:00:00.000Z',
  updatedAt: '2026-09-27T10:00:00.000Z',
  restoredAt: '2026-09-27T10:00:00.000Z',
} as AssetRestorationResponseDto;

describe('Studio Restore tab (FL-115, FL-162)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getAssetInfo.mockResolvedValue(video);
    sdkMock.getAssetRestorations.mockResolvedValue({
      assetId: video.id,
      currentRestorationId: null,
      items: [finished],
    });
    sdkMock.getAssetRestorationOptions.mockResolvedValue({
      assetId: video.id,
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
      route: AssetRestorationRoute.Local,
      destinations: [],
    } as never);
  });

  it('restores one of the project’s originals, never a restored version, and hands a finished one back', async () => {
    const onUseInStudio = vi.fn();
    render(StudioRestorePanel, {
      assets: [ref('video-1', 'lake.mp4'), ref('restored-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0009', 'lake.mp4 (restored)')],
      onUseInStudio,
      onClose: vi.fn(),
    });

    const source = screen.getByRole('combobox', { name: 'frameleaf_studio_restore_source' });
    expect([...source.querySelectorAll('option')].map((option) => option.value)).toEqual(['video-1']);
    await fireEvent.click(await screen.findByTestId('restoration-use-in-studio'));

    expect(sdkMock.getAssetInfo).toHaveBeenCalledWith({ id: 'video-1' });
    expect(onUseInStudio).toHaveBeenCalledWith(expect.objectContaining({ id: 'restoration-1' }));
    expect(sdkMock.setCurrentAssetRestoration).not.toHaveBeenCalled();
  });

  it('closes on request', async () => {
    const onClose = vi.fn();
    render(StudioRestorePanel, { assets: [], onUseInStudio: vi.fn(), onClose });
    expect(screen.getByText('frameleaf_studio_restore_no_sources')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
