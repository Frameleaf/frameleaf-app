import { CloudMlJobPurpose, CloudMlJobStage, MlWorkload, type CloudMlJobEstimateResponseDto } from '@frameleaf/sdk';
import { render, screen } from '@testing-library/svelte';
import messages from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import CloudJobDialog from './CloudJobDialog.svelte';

vi.mock('$lib/frameleaf/activity-session.svelte', () => ({
  activitySession: { watch: () => () => {}, operations: [], refresh: vi.fn(), cancel: vi.fn(), retry: vi.fn() },
}));

const model = { sku: 'ms_54S55W7C', rev: 'mr_0WNPDD697MT0', label: 'Upscale · Standard', gpu: 'L4-class, 24 GB' };

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

describe('CloudJobDialog: photo upscale under the 64 MP output cap (FC-46)', () => {
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
});
