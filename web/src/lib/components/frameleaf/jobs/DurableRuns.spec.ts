import { fireEvent, render, screen, within, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '$i18n/en.json';
import { durableRun } from '$lib/__mocks__/durable-runs.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import DurableRuns from '$lib/components/frameleaf/jobs/DurableRuns.svelte';

beforeAll(async () => {
  register('en', () => Promise.resolve(en));
  await init({ fallbackLocale: 'en', initialLocale: 'en' });
  await waitLocale();
});
beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.listDurableJobRuns.mockResolvedValue({ items: [], hasNextPage: false });
});
describe('durable run history', () => {
  it('shows partial failures and distinct stage counts with paginated inspection', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({ items: [durableRun()], hasNextPage: true });
    sdkMock.listDurableJobRunItems.mockResolvedValue({
      items: [
        {
          id: 'opaque',
          outcome: 'paused',
          stageTotals: durableRun().stageTotals,
          lastProgressAt: null,
          lastStage: null,
          reasons: ['queue_paused'],
        },
      ],
      hasNextPage: true,
    });
    render(DurableRuns);
    expect(await screen.findByText('14,992 / 15,000 selected items settled')).toBeInTheDocument();
    expect(screen.getByText('75,000 stages')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Inspect items' }));
    const inspector = await screen.findByRole('region', { name: 'Selected item outcomes' });
    expect(await within(inspector).findByText('Paused')).toBeInTheDocument();
    await fireEvent.click(within(inspector).getByRole('button', { name: 'Next' }));
    expect(sdkMock.listDurableJobRunItems).toHaveBeenLastCalledWith({ id: durableRun().id, take: 25, skip: 25 });
  });
  it('uses server pagination and retains the last state after a failed refresh', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [durableRun({ state: 'completed_with_errors' })],
      hasNextPage: true,
    });
    render(DurableRuns);
    expect(await screen.findByText('Completed with errors')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(sdkMock.listDurableJobRuns).toHaveBeenLastCalledWith({ take: 25, skip: 25 });
    // Let the successful page request settle before requesting the failed refresh.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled());
    sdkMock.listDurableJobRuns.mockRejectedValueOnce(new Error('offline'));
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('status')).toHaveTextContent('last known progress');
    expect(screen.getByText('Completed with errors')).toBeInTheDocument();
  });
  it.each(['paused', 'retrying', 'delayed'] as const)('renders the %s status from the server', async (state) => {
    sdkMock.listDurableJobRuns.mockResolvedValue({ items: [durableRun({ state })], hasNextPage: false });
    render(DurableRuns);
    expect(
      await screen.findByText(state === 'paused' ? 'Paused' : state === 'retrying' ? 'Retrying' : 'Scheduled'),
    ).toBeInTheDocument();
  });
});
