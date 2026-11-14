import { CloudMlJobPurpose, CloudMlJobStage, MlWorkload, type CloudMlJobEstimateResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import messages from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
import CloudJobDialog from './CloudJobDialog.svelte';

vi.mock('$lib/frameleaf/activity-session.svelte', () => ({
  activitySession: { watch: () => () => {}, operations: [], refresh: vi.fn(), cancel: vi.fn(), retry: vi.fn() },
}));

const model = {
  sku: 'ms_54S55W7C',
  rev: 'mr_0WNPDD697MT0',
  label: 'Upscale · Standard',
  gpu: 'L4-class, 24 GB',
  rank: 1,
  perSecondUsd: 0.0004,
  startFeeUsd: 0.02,
};

const estimate = (upscale: CloudMlJobEstimateResponseDto['upscale']): CloudMlJobEstimateResponseDto =>
  ({
    estimateId: 'estimate-1',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    workload: MlWorkload.Upscale,
    model,
    models: [model],
    basis: 'modelled',
    p50Usd: 0.11,
    p90Usd: 0.13,
    startupUsd: 0.05,
    startFeeUsd: 0.05,
    perSecondUsd: 0.000513,
    holdUsd: 0.21,
    minimumUsd: 0.05,
    plannedWorkers: 1,
    coldStartSeconds: 10,
    runSeconds: 76,
    perUnit: { unit: 'photo', p50Usd: 0.11, p90Usd: 0.13, quantity: 1 },
    availableUsd: 10,
    dailyCapUsd: null,
    spentTodayUsd: 0,
    consent: { version: '2026-09-26.1', summary: 'Metadata is removed.', documentUrl: null },
    refusal: null,
    permission: { canConfirm: true, reason: null, monthlyCapUsd: null, spentThisMonthUsd: null },
    upscale,
  }) as unknown as CloudMlJobEstimateResponseDto;

const open = () =>
  render(CloudJobDialog, {
    open: true,
    title: 'Restore on Frameleaf Cloud',
    request: {
      assetId: 'asset-1',
      purpose: CloudMlJobPurpose.Restoration,
      stage: CloudMlJobStage.Full,
      destinationId: 'cloud-1',
    },
  });

describe('CloudJobDialog: one confirmation per job', () => {
  const insufficient = {
    ...estimate(null),
    holdUsd: 40,
    refusal: { code: 'insufficient-credits', message: 'Not enough credit.', topUpUrl: 'https://top.up/x' },
  } as unknown as CloudMlJobEstimateResponseDto;

  beforeEach(() => {
    getCloudManager.close();
    vi.clearAllMocks();
  });

  it('does not confirm a displayed estimate when its Studio project is no longer current', async () => {
    let current = true;
    render(CloudJobDialog, {
      open: true,
      title: 'Cloud captions',
      estimateWith: async () => estimate(null),
      canSubmit: () => current,
    });
    const submit = await screen.findByRole('button', { name: /frameleaf_cloud_job_submit/ });
    await waitFor(() => expect(submit).toBeEnabled());

    current = false;
    await fireEvent.click(submit);
    expect(sdkMock.createCloudMlJob).not.toHaveBeenCalled();
  });

  it('confirms the disclosed estimate and terms only after pressing Run', async () => {
    sdkMock.estimateCloudMlJob.mockResolvedValue(estimate(null));
    sdkMock.createCloudMlJob.mockResolvedValue({ operationId: 'op-1' } as never);
    open();

    expect(await screen.findByText('frameleaf_cloud_job_disclosure')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    const submit = await screen.findByRole('button', { name: /frameleaf_cloud_job_submit/ });
    await waitFor(() => expect(submit).toBeEnabled());
    await fireEvent.click(submit);

    await waitFor(() =>
      expect(sdkMock.createCloudMlJob).toHaveBeenCalledWith({
        cloudMlJobCreateDto: {
          estimateId: 'estimate-1',
          consentVersion: '2026-09-26.1',
          acknowledgeDataLeaves: true,
        },
      }),
    );
  });

  it('opens the sheet on a refusal and estimates again when it is done', async () => {
    sdkMock.estimateCloudMlJob.mockResolvedValue(insufficient);
    open();

    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_add_ai_credit' }));
    expect(getCloudManager.request).toMatchObject({
      feature: 'processing',
      creditNeeded: 40,
      topUpUrl: 'https://top.up/x',
    });

    sdkMock.estimateCloudMlJob.mockResolvedValue(estimate(null));
    getCloudManager.request?.onDone?.();
    await screen.findByRole('button', { name: /frameleaf_cloud_job_submit/ });
    expect(sdkMock.estimateCloudMlJob).toHaveBeenCalledTimes(2);
  });

  it('estimates the named Smooth motion model before asking for consent', async () => {
    const selected = { ...model, sku: 'ms_RIFE', label: 'Smooth motion · Standard' };
    sdkMock.estimateCloudMlJob.mockResolvedValue({
      ...estimate(null),
      workload: MlWorkload.Interpolation,
      model: selected,
      models: [selected],
    });
    render(CloudJobDialog, {
      open: true,
      title: 'Smooth motion',
      initialModelSku: 'ms_RIFE',
      request: {
        assetId: 'asset-1',
        purpose: CloudMlJobPurpose.SmoothMotion,
        stage: CloudMlJobStage.Preview,
        destinationId: 'cloud-1',
        factor: 2,
      },
    });
    await waitFor(() =>
      expect(sdkMock.estimateCloudMlJob).toHaveBeenCalledWith({
        cloudMlJobEstimateRequestDto: expect.objectContaining({ modelSku: 'ms_RIFE', factor: 2 }),
      }),
    );
    expect(sdkMock.createCloudMlJob).not.toHaveBeenCalled();
  });
});

describe('CloudJobDialog: photo upscale under the 64 MP output cap (FC-46)', () => {
  it('shows the explicit approved maximum alongside a routed quote', async () => {
    sdkMock.estimateCloudMlJob.mockResolvedValue({ ...estimate(null), approvedMaximumUsd: 0.21 });
    open();
    expect(await screen.findByText('frameleaf_cloud_job_authorized_maximum')).toBeInTheDocument();
    expect(messages.frameleaf_cloud_job_authorized_maximum_help).toMatch(/maximum.*approve.*higher/i);
    expect(screen.getByText('frameleaf_cloud_job_never_fallback')).toBeInTheDocument();
    expect(screen.queryByText('frameleaf_cloud_job_legacy_price_tolerance')).not.toBeInTheDocument();
  });

  it('describes the legacy reseal tolerance without promising approval for every price change', async () => {
    sdkMock.estimateCloudMlJob.mockResolvedValue(estimate(null));
    open();
    expect(await screen.findByText('frameleaf_cloud_job_legacy_price_tolerance')).toBeInTheDocument();
    expect(screen.queryByText('frameleaf_cloud_job_never_fallback')).not.toBeInTheDocument();
  });

  it('shows the lowered factor and what it changes before the owner confirms', async () => {
    sdkMock.estimateCloudMlJob.mockResolvedValue(
      estimate({ requestedScale: 4, appliedScale: 2, lowered: true, outputWidth: 8000, outputHeight: 6000 }),
    );
    open();

    const fact = await screen.findByTestId('cloud-job-upscale');
    expect(fact).toHaveTextContent('frameleaf_cloud_job_upscale_lowered');
    expect(fact).toHaveTextContent('frameleaf_cloud_job_upscale_lowered_help');
    // the copy says the factor, the cap and that it is what is paid for (prototype wording: "capped")
    expect(messages.frameleaf_cloud_job_upscale_lowered).toBe(
      '{scale}× (capped from {requested}×) · {width} × {height}',
    );
    expect(messages.frameleaf_cloud_job_upscale_lowered_help).toMatch(
      /capped at 64 MP.*what you pay are for \{scale\}×/,
    );
  });

  it('shows the factor plainly when the cap did not lower it, and nothing for a video', async () => {
    sdkMock.estimateCloudMlJob.mockResolvedValue(
      estimate({ requestedScale: 4, appliedScale: 4, lowered: false, outputWidth: 8000, outputHeight: 6000 }),
    );
    const first = open();
    const fact = await screen.findByTestId('cloud-job-upscale');
    expect(fact).toHaveTextContent('frameleaf_cloud_job_upscale_value');
    expect(fact).not.toHaveTextContent('lowered');
    first.unmount();

    sdkMock.estimateCloudMlJob.mockResolvedValue(estimate(null));
    open();
    await screen.findByText('Upscale · Standard');
    expect(screen.queryByTestId('cloud-job-upscale')).toBeNull();
  });
  it('prices through estimateWith, and says when the dialog closes with nothing sent (FL-1304)', async () => {
    const estimateWith = vi.fn().mockResolvedValue(estimate(null));
    const onDismissed = vi.fn();
    const { rerender } = render(CloudJobDialog, {
      open: true,
      title: 'Captions on Frameleaf Cloud',
      workName: 'Captions',
      summary: 'Lake.mov',
      estimateWith,
      onDismissed,
    });
    expect(await screen.findByText(/Captions · Lake\.mov/)).toBeInTheDocument();
    expect(estimateWith).toHaveBeenCalledWith(null);
    expect(sdkMock.estimateCloudMlJob).not.toHaveBeenCalled();
    await rerender({ open: false });
    expect(onDismissed).toHaveBeenCalledOnce();
  });
  it('lists the rest of a batch with each estimate and lets this clip be skipped (FL-1429)', async () => {
    const onSkip = vi.fn();
    render(CloudJobDialog, {
      open: true,
      title: 'Captions on Frameleaf Cloud · clip 2 of 3',
      workName: 'Captions',
      summary: 'Forest trail.mov',
      estimateWith: () => Promise.resolve(estimate(null)),
      steps: [
        { label: '1. Lake morning.mov', value: 'Sent', current: false },
        { label: '2. Forest trail.mov', value: '$0.05–$0.06', current: true },
        { label: '3. Kayaking.mov', value: '$0.04–$0.05', current: false },
      ],
      onSkip,
      cancelLabel: 'Stop here',
    });
    expect(screen.getByText('3. Kayaking.mov')).toBeInTheDocument();
    expect(screen.getByText('2. Forest trail.mov').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'Stop here' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_studio_cloud_captions_batch_skip' }));
    expect(onSkip).toHaveBeenCalledOnce();
    expect(sdkMock.createCloudMlJob).not.toHaveBeenCalled();
  });

  const pressConfirm = async () => {
    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_cloud_job_submit' }));
  };

  it('does not call a confirmation on its way dismissed when the dialog closes (FL-1304)', async () => {
    let admit!: (job: unknown) => void;
    sdkMock.createCloudMlJob.mockReturnValue(new Promise((resolve) => (admit = resolve)) as never);
    const onSubmitted = vi.fn();
    const onDismissed = vi.fn();
    const { rerender } = render(CloudJobDialog, {
      open: true,
      title: 'Captions',
      estimateWith: () => Promise.resolve(estimate(null)),
      onSubmitted,
      onDismissed,
    });
    await pressConfirm();
    await rerender({ open: false });
    expect(onDismissed).not.toHaveBeenCalled();
    admit({ operationId: 'operation-1' });
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(onDismissed).not.toHaveBeenCalled();
  });

  it('settles a closed dialog when its confirmation is refused (FL-1304)', async () => {
    let refuse!: (error: Error) => void;
    sdkMock.createCloudMlJob.mockReturnValue(new Promise((_, reject) => (refuse = reject)) as never);
    const onDismissed = vi.fn();
    const { rerender } = render(CloudJobDialog, {
      open: true,
      title: 'Captions',
      estimateWith: () => Promise.resolve(estimate(null)),
      onDismissed,
    });
    await pressConfirm();
    await rerender({ open: false });
    refuse(new Error('no'));
    await vi.waitFor(() => expect(onDismissed).toHaveBeenCalledOnce());
  });
});
