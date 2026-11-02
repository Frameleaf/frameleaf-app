import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { activitySession } from '$lib/frameleaf/activity-session.svelte';
import CloudGpuUpgrade from './CloudGpuUpgrade.svelte';

vi.mock('$lib/frameleaf/activity-session.svelte', () => ({ activitySession: { refresh: vi.fn() } }));

const quote = () => ({
  estimateId: 'upgrade-1',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  computeSku: 'cs_FQ4BWNHK',
  pricingRevision: 0,
  incurredUsd: 0.4,
  remainingP50Usd: 1,
  remainingP90Usd: 1.5,
  approvedMaximumUsd: 2.9,
  perSecondUsd: 0.02,
  startFeeUsd: 0.2,
  plannedWorkers: 2,
  permission: { canConfirm: true, reason: null, monthlyCapUsd: null, spentThisMonthUsd: null },
  refusal: null,
});

describe('GPU upgrade confirmation', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });
  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.estimateCloudMlJobUpgrade.mockResolvedValue(quote());
    sdkMock.upgradeCloudMlJob.mockResolvedValue({} as never);
  });

  const open = async () => {
    render(CloudGpuUpgrade, { operationId: 'operation-1' });
    await fireEvent.click(screen.getByRole('button', { name: 'Upgrade GPU' }));
    await screen.findByText('New total maximum');
  };

  it('shows incurred charges, remaining work and new maximum before explicit approval', async () => {
    await open();
    expect(screen.getByText('$0.40')).toBeInTheDocument();
    expect(screen.getByText('$1.00–$1.50')).toBeInTheDocument();
    expect(screen.getByText('$2.90')).toBeInTheDocument();
    expect(screen.getByText(/Work already assigned keeps its approved price/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Approve upgrade' });
    expect(confirm).toBeDisabled();
    expect(sdkMock.upgradeCloudMlJob).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('checkbox'));
    await fireEvent.click(confirm);
    expect(sdkMock.upgradeCloudMlJob).toHaveBeenCalledExactlyOnceWith({
      id: 'operation-1',
      cloudMlJobUpgradeDto: { estimateId: 'upgrade-1', acknowledgeMaximum: true },
    });
    expect(activitySession.refresh).toHaveBeenCalled();
    expect(sdkMock.cancelMediaOperation).not.toHaveBeenCalled();
  });

  it('leaves the current job alone when the owner keeps waiting or cannot spend', async () => {
    sdkMock.estimateCloudMlJobUpgrade.mockResolvedValue({
      ...quote(),
      permission: { canConfirm: false, reason: 'monthly-cap', monthlyCapUsd: 2, spentThisMonthUsd: 1 },
    });
    await open();
    expect(screen.getByText(/This upgrade exceeds your monthly/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve upgrade' })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Keep waiting at current price' }));
    expect(sdkMock.upgradeCloudMlJob).not.toHaveBeenCalled();
    expect(sdkMock.cancelMediaOperation).not.toHaveBeenCalled();
  });

  it('requires fresh approval when the quote expires', async () => {
    sdkMock.estimateCloudMlJobUpgrade.mockResolvedValueOnce({ ...quote(), expiresAt: '2020-01-01T00:00:00.000Z' });
    await open();
    await fireEvent.click(screen.getByRole('checkbox'));
    await fireEvent.click(screen.getByRole('button', { name: 'Approve upgrade' }));
    await vi.waitFor(() => expect(sdkMock.estimateCloudMlJobUpgrade).toHaveBeenCalledTimes(2));
    expect(sdkMock.upgradeCloudMlJob).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
});
