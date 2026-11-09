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
import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import RestorationPanel from './RestorationPanel.svelte';

vi.mock('$lib/frameleaf/activity-session.svelte', () => ({
  activitySession: { watch: () => () => {}, operations: [], refresh: vi.fn(), cancel: vi.fn(), retry: vi.fn() },
}));
const auth = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    params: {},
    get user() {
      return { isAdmin: auth.isAdmin };
    },
  },
}));

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

describe('RestorationPanel polling', () => {
  it('does not start polling again when a list read lands after the panel is gone', async () => {
    const busy = {
      assetId: asset.id,
      currentRestorationId: null,
      items: [item({ status: AssetRestorationStatus.Restoring, hasResult: false })],
    };
    sdkMock.getAssetRestorationOptions.mockResolvedValue({ assetId: asset.id, destinations: [] } as never);
    sdkMock.getAssetRestorations.mockResolvedValueOnce(busy);
    vi.useFakeTimers();
    try {
      const { unmount } = render(RestorationPanel, { asset, onCompare: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);
      const reads = sdkMock.getAssetRestorations.mock.calls.length;

      // The next poll is on its way when the panel closes.
      let answer: (value: typeof busy) => void = () => {};
      sdkMock.getAssetRestorations.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)) as never);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sdkMock.getAssetRestorations).toHaveBeenCalledTimes(reads + 1);

      unmount();
      sdkMock.getAssetRestorations.mockResolvedValue(busy);
      answer(busy);
      await vi.advanceTimersByTimeAsync(20_000);

      expect(sdkMock.getAssetRestorations).toHaveBeenCalledTimes(reads + 1);
    } finally {
      vi.useRealTimers();
    }
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
          models: [],
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

    const slider = await screen.findByRole('group', { name: 'frameleaf_restoration_smooth_motion_model' });
    await waitFor(() => expect(slider).toHaveTextContent('frameleaf_restoration_smooth_motion_no_local'));
    expect(sdkMock.requestAssetRestoration).not.toHaveBeenCalled();
  });

  it('sends the model the computer at home reported', async () => {
    sdkMock.requestAssetRestoration.mockResolvedValue(
      item({ id: 'smooth-2', mode: AssetRestorationMode.SmoothMotion }),
    );
    const base = smoothOptions();
    const destinations = (base as unknown as { destinations: object[] }).destinations.map((destination) => ({
      ...destination,
      models: [
        { id: 'rife-4.25', name: 'RIFE', family: 'rife', mode: AssetRestorationMode.SmoothMotion, available: true },
      ],
    }));
    sdkMock.getAssetRestorationOptions.mockResolvedValue({ ...(base as object), destinations } as never);
    render(RestorationPanel, { asset, onCompare: vi.fn() });

    const preview = await screen.findByRole('button', { name: /frameleaf_restoration_smooth_motion_preview/ });
    await waitFor(() => expect(preview).toBeEnabled());
    await fireEvent.click(preview);

    expect(sdkMock.requestAssetRestoration).toHaveBeenCalledWith({
      id: asset.id,
      assetRestorationRequestDto: expect.objectContaining({
        mode: AssetRestorationMode.SmoothMotion,
        model: 'rife-4.25',
      }),
    });
  });

  it('offers the live catalogue on its blue stops, and estimates with the model chosen there', async () => {
    const base = smoothOptions() as unknown as { destinations: object[] };
    sdkMock.getAssetRestorationOptions.mockResolvedValue({
      ...base,
      route: 'both',
      destinations: [
        ...base.destinations,
        {
          ...base.destinations[0],
          id: 'cloud',
          kind: MlDestinationKind.FrameleafCloud,
          name: 'Frameleaf Cloud',
          models: [],
        },
      ],
    } as never);
    sdkMock.getCloudMlStatus.mockResolvedValue({ connection: 'ready' } as never);
    sdkMock.getCloudMlModelChoices.mockResolvedValue({ choices: [] } as never);
    sdkMock.getCloudMlCatalog.mockResolvedValue({
      models: [
        {
          id: 'ms_RIFE',
          group: 'interpolation',
          workload: 'interpolation',
          name: 'Smooth motion',
          modelName: 'RIFE on Cloud',
          rank: 1,
          isDefault: true,
          priceUsd: 0.01,
          pricingUnit: 'second',
        },
      ],
    } as never);
    sdkMock.estimateCloudMlJob.mockImplementation(() => new Promise(() => {}));
    render(RestorationPanel, { asset, onCompare: vi.fn() });

    const slider = await screen.findByRole('group', { name: 'frameleaf_restoration_smooth_motion_model' });
    const blue = await within(slider).findByRole('radio', { name: /RIFE on Cloud/ });
    expect(within(slider).queryByRole('radio', { name: /FILM/ })).toBeNull();
    await fireEvent.click(blue);
    await fireEvent.click(await screen.findByRole('button', { name: /frameleaf_restoration_smooth_motion_estimate/ }));

    await waitFor(() =>
      expect(sdkMock.estimateCloudMlJob).toHaveBeenCalledWith({
        cloudMlJobEstimateRequestDto: expect.objectContaining({ modelSku: 'ms_RIFE', factor: 2 }),
      }),
    );
  });
});

// VIEWER-P6 (Editor.jsx:1872-1924): the photo editor's Enhance tab is one card, one slider, one button.
describe('RestorationPanel Enhance & upscale (VIEWER-P6)', () => {
  const photo = assetFactory.build({ type: AssetTypeEnum.Image, id: 'photo-1' });

  beforeEach(() => {
    vi.clearAllMocks();
    auth.isAdmin = true;
    sdkMock.getAssetRestorations.mockResolvedValue({ assetId: photo.id, currentRestorationId: null, items: [] });
    sdkMock.getAssetRestorationOptions.mockResolvedValue({
      assetId: photo.id,
      sourceType: AssetRestorationSourceType.Image,
      sourceWidth: 1800,
      sourceHeight: 1200,
      durationSeconds: null,
      mode: AssetRestorationMode.Faithful,
      workload: 'restoration-faithful',
      upscale: 4,
      outputWidth: 3840,
      outputHeight: 2560,
      previewSeconds: null,
      adapterInstalled: true,
      route: AssetRestorationRoute.Local,
      destinations: [
        {
          id: 'server',
          kind: MlDestinationKind.Local,
          name: 'This server',
          health: 'healthy',
          available: true,
          leavesNetwork: false,
          consentRequired: false,
          consentGranted: true,
          refusal: null,
          refusalDetail: null,
          estimate: { sampleCount: 0, windowDays: 30, previewSeconds: null, fullSeconds: null },
          gpu: null,
          models: [],
        },
      ],
    } as never);
  });

  it('asks for a model on one slider instead of a destination, and previews on this server at 4×', async () => {
    sdkMock.requestAssetRestoration.mockResolvedValue(item({ id: 'enhance-1', sourceType: 'image' as never }));
    render(RestorationPanel, { asset: photo, onCompare: vi.fn(), enhance: true });

    expect(await screen.findByRole('group', { name: 'frameleaf_enhance_model' })).toBeInTheDocument();
    expect(screen.getByTestId('restoration-enhance')).toHaveTextContent('frameleaf_enhance_title');
    expect(screen.queryByText('frameleaf_restoration_process_on')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'frameleaf_restoration_mode' })).not.toBeInTheDocument();

    const run = await screen.findByRole('button', { name: /frameleaf_enhance_run_here/ });
    await waitFor(() => expect(run).toBeEnabled());
    await fireEvent.click(run);
    expect(sdkMock.requestAssetRestoration).toHaveBeenCalledWith({
      id: photo.id,
      assetRestorationRequestDto: expect.objectContaining({
        mode: AssetRestorationMode.Faithful,
        upscale: 4,
        destinationId: 'server',
      }),
    });
    // FL-423: a computer that listed no models keeps its usual one, so no model is named
    expect(sdkMock.requestAssetRestoration.mock.calls[0][0].assetRestorationRequestDto).not.toHaveProperty('model');
  });
});

// FL-423: the Enhance slider's stops are the models the computer at home runs, then Frameleaf Cloud.
describe('RestorationPanel Enhance model choice (FL-423)', () => {
  const photo = assetFactory.build({ type: AssetTypeEnum.Image, id: 'photo-3' });
  const destination = (overrides: Record<string, unknown>) => ({
    health: 'healthy',
    available: true,
    leavesNetwork: false,
    consentRequired: false,
    consentGranted: true,
    refusal: null,
    refusalDetail: null,
    estimate: { sampleCount: 0, windowDays: 30, previewSeconds: null, fullSeconds: null },
    gpu: null,
    models: [],
    ...overrides,
  });
  const garage = destination({
    id: 'garage',
    kind: MlDestinationKind.Lan,
    name: 'Garage GPU',
    gpu: { name: 'NVIDIA RTX 4090', memoryTotalBytes: 24e9 },
    models: [
      { id: 'seedvr2-3b', name: 'SeedVR2 3B', family: 'seedvr2', mode: AssetRestorationMode.Creative, available: true },
      {
        id: 'realbasicvsr-x4',
        name: 'RealBasicVSR',
        family: 'realbasicvsr',
        mode: AssetRestorationMode.Faithful,
        available: true,
      },
      {
        id: 'seedvr2-7b',
        name: 'SeedVR2 7B',
        family: 'seedvr2',
        mode: AssetRestorationMode.Creative,
        available: false,
      },
    ],
  });
  const cloud = destination({
    id: 'cloud',
    kind: MlDestinationKind.FrameleafCloud,
    name: 'Frameleaf Cloud',
    leavesNetwork: true,
    consentRequired: true,
  });
  const options = (route: AssetRestorationRoute, destinations: unknown[]) =>
    sdkMock.getAssetRestorationOptions.mockImplementation(({ mode }: { mode?: AssetRestorationMode }) =>
      Promise.resolve({
        assetId: photo.id,
        sourceType: AssetRestorationSourceType.Image,
        sourceWidth: 1800,
        sourceHeight: 1200,
        durationSeconds: null,
        mode,
        workload: `restoration-${mode}`,
        upscale: 4,
        outputWidth: 3840,
        outputHeight: 2560,
        previewSeconds: null,
        adapterInstalled: true,
        route,
        destinations,
      } as never),
    );

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getAssetRestorations.mockResolvedValue({ assetId: photo.id, currentRestorationId: null, items: [] });
    sdkMock.requestAssetRestoration.mockResolvedValue(item({ id: 'enhance-2', sourceType: 'image' as never }));
  });

  it('offers each model the computer runs, lighter first, and starts on a ready Faithful one', async () => {
    options(AssetRestorationRoute.Both, [garage, cloud]);
    render(RestorationPanel, { asset: photo, onCompare: vi.fn(), enhance: true });

    const slider = await screen.findByRole('group', { name: 'frameleaf_enhance_model' });
    await waitFor(() => expect(within(slider).getAllByRole('radio')).toHaveLength(4));
    const radios = within(slider).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual([
      'realbasicvsr-x4',
      'seedvr2-3b',
      'seedvr2-7b',
      'frameleaf-cloud',
    ]);
    expect(radios.map((radio) => radio.disabled)).toEqual([false, false, true, false]);
    await waitFor(() => expect(radios[0]).toBeChecked());
    expect(slider).toHaveTextContent('frameleaf_enhance_model_not_ready');
    expect(slider).toHaveTextContent('frameleaf_enhance_model_on');
  });

  it('asks the computer for the chosen model, with the kind of restoration it does', async () => {
    options(AssetRestorationRoute.Local, [garage]);
    render(RestorationPanel, { asset: photo, onCompare: vi.fn(), enhance: true });

    const slider = await screen.findByRole('group', { name: 'frameleaf_enhance_model' });
    const creative = await within(slider).findByRole('radio', { name: /SeedVR2 3B/ });
    await fireEvent.click(creative);
    await waitFor(() =>
      expect(sdkMock.getAssetRestorationOptions).toHaveBeenCalledWith(
        expect.objectContaining({ mode: AssetRestorationMode.Creative }),
      ),
    );
    // Where work runs is a preference: the blue stop is still there
    expect(within(slider).getByRole('radio', { name: /frameleaf_enhance_model_cloud/ })).toBeEnabled();

    const run = screen.getByRole('button', { name: /frameleaf_enhance_run_on/ });
    await waitFor(() => expect(run).toBeEnabled());
    await fireEvent.click(run);
    expect(sdkMock.requestAssetRestoration).toHaveBeenCalledWith({
      id: photo.id,
      assetRestorationRequestDto: expect.objectContaining({
        mode: AssetRestorationMode.Creative,
        model: 'seedvr2-3b',
        upscale: 4,
        destinationId: 'garage',
      }),
    });
  });

  const runBlueStop = async () => {
    render(RestorationPanel, { asset: photo, onCompare: vi.fn(), enhance: true });
    await fireEvent.click(
      await within(await screen.findByRole('group', { name: 'frameleaf_enhance_model' })).findByRole('radio', {
        name: /frameleaf_enhance_model_cloud/,
      }),
    );
    const run = await screen.findByRole('button', { name: /frameleaf_enhance_run_cloud/ });
    await waitFor(() => expect(run).toBeEnabled());
    await fireEvent.click(run);
  };

  it('sends a blue stop to the Frameleaf Cloud estimate', async () => {
    options(AssetRestorationRoute.Both, [garage, cloud]);
    await runBlueStop();
    await waitFor(() => expect(sdkMock.estimateCloudMlJob).toHaveBeenCalled());
    expect(sdkMock.requestAssetRestoration).not.toHaveBeenCalled();
  });

  it('opens the set-up sheet when Cloud is not set up, then carries on and estimates', async () => {
    getCloudManager.close();
    options(AssetRestorationRoute.Local, [garage]);
    await runBlueStop();

    expect(sdkMock.estimateCloudMlJob).not.toHaveBeenCalled();
    expect(getCloudManager.request?.feature).toBe('processing');

    options(AssetRestorationRoute.Both, [garage, cloud]);
    getCloudManager.request?.onDone?.();
    await waitFor(() => expect(sdkMock.estimateCloudMlJob).toHaveBeenCalled());
  });

  it('moves work kept at home to Both when an administrator runs a blue stop', async () => {
    options(AssetRestorationRoute.Local, [garage, cloud]);
    const config = { frameleafCloud: { cloudMl: { enabled: true, routing: { upscale: 'local' } } } };
    sdkMock.getAdminConfigWithRevision.mockResolvedValue({ config, revision: 'r1' } as never);
    sdkMock.updateAdminConfigWithRevision.mockImplementation(() => {
      options(AssetRestorationRoute.Both, [garage, cloud]);
      return Promise.resolve({ config, revision: 'r2' } as never);
    });
    await runBlueStop();

    await waitFor(() => expect(sdkMock.estimateCloudMlJob).toHaveBeenCalled());
    const saved = sdkMock.updateAdminConfigWithRevision.mock.calls[0][0].adminConfigRevisionUpdateDto.config;
    expect(saved.frameleafCloud!.cloudMl.routing).toMatchObject({ upscale: 'both' });
  });

  it('moves work kept at home once, and stops, when the options keep failing', async () => {
    options(AssetRestorationRoute.Local, [garage, cloud]);
    const config = { frameleafCloud: { cloudMl: { enabled: true, routing: { upscale: 'local' } } } };
    sdkMock.getAdminConfigWithRevision.mockResolvedValue({ config, revision: 'r1' } as never);
    sdkMock.updateAdminConfigWithRevision.mockImplementation(() => {
      sdkMock.getAssetRestorationOptions.mockRejectedValue(new Error('offline'));
      return Promise.resolve({ config, revision: 'r2' } as never);
    });
    await runBlueStop();

    await waitFor(() => expect(document.body.textContent).toContain('frameleaf_model_route_failed'));
    expect(sdkMock.updateAdminConfigWithRevision).toHaveBeenCalledTimes(1);
    expect(sdkMock.estimateCloudMlJob).not.toHaveBeenCalled();
  });

  it('tells a non-administrator why a blue stop on home-only work does not run', async () => {
    auth.isAdmin = false;
    options(AssetRestorationRoute.Local, [garage, cloud]);
    await runBlueStop();
    await waitFor(() => expect(document.body.textContent).toContain('frameleaf_cloud_route_admin_only'));
    expect(sdkMock.estimateCloudMlJob).not.toHaveBeenCalled();
    expect(sdkMock.updateAdminConfigWithRevision).not.toHaveBeenCalled();
    auth.isAdmin = true;
  });

  it('says the real reason Cloud refused the photo', async () => {
    options(AssetRestorationRoute.Both, [
      garage,
      { ...cloud, available: false, refusal: 'budget-exceeded', refusalDetail: 'Spending limit reached.' },
    ]);
    render(RestorationPanel, { asset: photo, onCompare: vi.fn(), enhance: true });
    await fireEvent.click(
      await within(await screen.findByRole('group', { name: 'frameleaf_enhance_model' })).findByRole('radio', {
        name: /frameleaf_enhance_model_cloud/,
      }),
    );
    expect(await screen.findByText(/Spending limit reached\./)).toBeInTheDocument();
    expect(screen.queryByText('frameleaf_enhance_cloud_unavailable')).toBeNull();
  });

  describe('accepting a reviewed Cloud preview', () => {
    const preview = item({
      id: 'cloud-preview',
      status: AssetRestorationStatus.PreviewReady,
      destinationId: 'cloud',
      destinationKind: MlDestinationKind.FrameleafCloud,
    });
    const quote = (p90Usd: number) => ({
      estimateId: `estimate-${p90Usd}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      p50Usd: p90Usd / 2,
      p90Usd,
      holdUsd: p90Usd,
      consent: { version: 'v1' },
      refusal: null,
      permission: { canConfirm: true },
    });
    const acceptButton = () => screen.findByRole('button', { name: 'frameleaf_restoration_accept' });

    beforeEach(() => {
      options(AssetRestorationRoute.Both, [garage, cloud]);
      sdkMock.getAssetRestorations.mockResolvedValue({
        assetId: photo.id,
        currentRestorationId: null,
        items: [preview],
      });
    });

    it('asks nothing more at the price it showed', async () => {
      sdkMock.estimateCloudMlJob.mockResolvedValue(quote(2) as never);
      sdkMock.createCloudMlJob.mockResolvedValue({ operationId: 'op' } as never);
      render(RestorationPanel, { asset: photo, onCompare: vi.fn(), enhance: true });

      expect(await screen.findByTestId('restoration-full-price')).toBeInTheDocument();
      await fireEvent.click(await acceptButton());

      await waitFor(() =>
        expect(sdkMock.createCloudMlJob).toHaveBeenCalledWith({
          cloudMlJobCreateDto: { estimateId: 'estimate-2', consentVersion: 'v1', acknowledgeDataLeaves: true },
        }),
      );
      expect(screen.queryByRole('dialog', { name: 'frameleaf_cloud_job_title_restoration_full' })).toBeNull();
    });

    it('asks again when the upscale was lowered, which the row does not say', async () => {
      sdkMock.estimateCloudMlJob.mockResolvedValue({
        ...quote(2),
        upscale: { requestedScale: 4, appliedScale: 2, lowered: true, outputWidth: 8000, outputHeight: 6000 },
      } as never);
      render(RestorationPanel, { asset: photo, onCompare: vi.fn(), enhance: true });

      await screen.findByTestId('restoration-full-price');
      await fireEvent.click(await acceptButton());

      expect(
        await screen.findByRole('dialog', { name: 'frameleaf_cloud_job_title_restoration_full' }),
      ).toBeInTheDocument();
      expect(sdkMock.createCloudMlJob).not.toHaveBeenCalled();
    });

    it('asks again when the price went up', async () => {
      const expired = { ...quote(2), expiresAt: new Date(Date.now() - 1000).toISOString() };
      sdkMock.estimateCloudMlJob.mockResolvedValueOnce(expired as never).mockResolvedValue(quote(5) as never);
      render(RestorationPanel, { asset: photo, onCompare: vi.fn(), enhance: true });

      await screen.findByTestId('restoration-full-price');
      await fireEvent.click(await acceptButton());

      expect(
        await screen.findByRole('dialog', { name: 'frameleaf_cloud_job_title_restoration_full' }),
      ).toBeInTheDocument();
      expect(sdkMock.createCloudMlJob).not.toHaveBeenCalled();
    });
  });
});

describe('RestorationPanel options for the chosen mode', () => {
  const photo = assetFactory.build({ type: AssetTypeEnum.Image, id: 'photo-2' });
  const destination = (name: string) => ({
    id: name,
    kind: MlDestinationKind.Local,
    name,
    health: 'healthy',
    available: true,
    leavesNetwork: false,
    consentRequired: false,
    consentGranted: true,
    refusal: null,
    refusalDetail: null,
    estimate: { sampleCount: 0, windowDays: 30, previewSeconds: null, fullSeconds: null },
    gpu: null,
    models: [],
  });
  const optionsWith = (name: string, mode: AssetRestorationMode) =>
    ({
      assetId: photo.id,
      sourceType: AssetRestorationSourceType.Image,
      sourceWidth: 1800,
      sourceHeight: 1200,
      durationSeconds: null,
      mode,
      workload: 'restoration-faithful',
      upscale: 2,
      outputWidth: 3600,
      outputHeight: 2400,
      previewSeconds: null,
      adapterInstalled: true,
      route: AssetRestorationRoute.Local,
      destinations: [destination(name)],
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getAssetRestorations.mockResolvedValue({ assetId: photo.id, currentRestorationId: null, items: [] });
  });

  it('keeps the options of the latest choice when an earlier answer arrives last', async () => {
    let resolveStale: (value: never) => void = () => {};
    let calls = 0;
    sdkMock.getAssetRestorationOptions.mockImplementation(({ mode }: { mode?: AssetRestorationMode }) => {
      calls++;
      if (calls === 2) {
        return new Promise((resolve) => (resolveStale = resolve));
      }
      return Promise.resolve(optionsWith(calls === 1 ? 'Initial' : 'Current', mode!));
    });
    render(RestorationPanel, { asset: photo, onCompare: vi.fn() });
    await screen.findByRole('option', { name: /Initial/ });

    const modes = screen.getByRole('radiogroup', { name: 'frameleaf_restoration_mode' });
    await fireEvent.click(within(modes).getAllByRole('radio')[1]);
    await fireEvent.click(within(modes).getAllByRole('radio')[0]);
    await screen.findByRole('option', { name: /Current/ });

    resolveStale(optionsWith('Stale', AssetRestorationMode.Creative));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('option', { name: /Stale/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Current/ })).toBeInTheDocument();
  });

  it('lets the person pick a model only when the computer has more than one ready for the kind (FL-423)', async () => {
    const faithful = (id: string, name: string, available = true) => ({
      id,
      name,
      family: 'realbasicvsr',
      mode: AssetRestorationMode.Faithful,
      available,
    });
    const withModels = (models: unknown[]) =>
      ({
        ...(optionsWith('Garage', AssetRestorationMode.Faithful) as object),
        destinations: [{ ...destination('Garage'), models }],
      }) as never;
    sdkMock.getAssetRestorationOptions.mockResolvedValue(
      withModels([faithful('rbv-a', 'Model A'), faithful('rbv-x', 'Model X', false)]),
    );
    const { unmount } = render(RestorationPanel, { asset: photo, onCompare: vi.fn() });
    await screen.findByRole('option', { name: /Garage/ });
    expect(screen.queryByRole('radiogroup', { name: 'frameleaf_restoration_model' })).not.toBeInTheDocument();
    unmount();

    sdkMock.getAssetRestorationOptions.mockResolvedValue(
      withModels([faithful('rbv-a', 'Model A'), faithful('rbv-b', 'Model B')]),
    );
    sdkMock.requestAssetRestoration.mockResolvedValue(item({ id: 'chosen', sourceType: 'image' as never }));
    render(RestorationPanel, { asset: photo, onCompare: vi.fn() });
    const models = await screen.findByRole('radiogroup', { name: 'frameleaf_restoration_model' });
    expect(within(models).getByRole('radio', { name: 'Model A' })).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(within(models).getByRole('radio', { name: 'Model B' }));
    await fireEvent.click(screen.getByRole('button', { name: /frameleaf_restoration_request_preview/ }));

    expect(sdkMock.requestAssetRestoration).toHaveBeenCalledWith({
      id: photo.id,
      assetRestorationRequestDto: expect.objectContaining({ mode: AssetRestorationMode.Faithful, model: 'rbv-b' }),
    });
  });
});
