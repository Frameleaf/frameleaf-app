import { QueueName } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
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
describe('recent work', () => {
  it('says how far a run has got in photos, what failed and where to see it', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [durableRun({ failedQueues: [QueueName.ThumbnailGeneration] })],
      hasNextPage: false,
    });
    render(DurableRuns);
    expect(await screen.findByText('14,992 of 15,000 photos')).toBeInTheDocument();
    expect(screen.getByText(/2 photos failed/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /See what failed in/ });
    expect(link.getAttribute('href')).toContain('tab=failed');
    // No operator wording: stages, settled items or coordination work.
    expect(document.body.textContent).not.toMatch(/stage|settled|coordination/i);
  });
  it('counts tasks when the work is not about photos', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [durableRun({ countsPhotos: false, failed: 0, needsAttention: 0 })],
      hasNextPage: false,
    });
    render(DurableRuns);
    expect(await screen.findByText('14,990 of 15,000 tasks')).toBeInTheDocument();
  });
  it.each([
    [{ state: 'paused' as const, reasons: ['queue_paused' as const] }, 'Paused. It carries on when you resume it.'],
    [{ state: 'delayed' as const, reasons: ['scheduled_delay' as const] }, /Waiting for the night window/],
    [{ state: 'blocked' as const, reasons: ['destination-unavailable' as const] }, 'Waiting on machine learning.'],
    [
      { state: 'blocked' as const, reasons: ['first_setup_pending' as const], held: 1200 },
      '1,200 photos are waiting for library setup to finish checking your files.',
    ],
  ])('says what is holding a run up in words', async (overrides, words) => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [durableRun({ ...overrides, failed: 0, needsAttention: 0 })],
      hasNextPage: false,
    });
    render(DurableRuns);
    expect(await screen.findByText(words)).toBeInTheDocument();
  });
  it('offers Release only for held work, and reads again after releasing', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [durableRun({ id: '0195e2a0-0000-7000-8000-000000000002', canRelease: true }), durableRun()],
      hasNextPage: false,
    });
    sdkMock.releaseJobRun.mockResolvedValue(undefined as never);
    render(DurableRuns);
    const buttons = await screen.findAllByRole('button', { name: 'Release' });
    expect(buttons).toHaveLength(1);
    await fireEvent.click(buttons[0]);
    await waitFor(() =>
      expect(sdkMock.releaseJobRun).toHaveBeenCalledWith({ id: '0195e2a0-0000-7000-8000-000000000002' }),
    );
    expect(await screen.findByText(/is released/)).toBeInTheDocument();
    expect(sdkMock.listDurableJobRuns).toHaveBeenCalledTimes(2);
  });
  it('explains an import that cannot be released yet', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({ items: [durableRun({ canRelease: true })], hasNextPage: false });
    sdkMock.releaseJobRun.mockRejectedValue({ status: 400 });
    sdkMock.isHttpError.mockReturnValue(true);
    render(DurableRuns);
    await fireEvent.click(await screen.findByRole('button', { name: 'Release' }));
    expect(await screen.findByText(/until Frameleaf Manager has finished/)).toBeInTheDocument();
  });
  it('uses server pagination and keeps the last runs after a failed refresh', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [durableRun({ state: 'completed_with_errors' })],
      hasNextPage: true,
    });
    render(DurableRuns);
    expect(await screen.findByText('Completed with errors')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(sdkMock.listDurableJobRuns).toHaveBeenLastCalledWith({ take: 25, skip: 25 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled());
    sdkMock.listDurableJobRuns.mockRejectedValueOnce(new Error('offline'));
    await fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('status')).toHaveTextContent('may be out of date');
    expect(screen.getByText('Completed with errors')).toBeInTheDocument();
  });
  it('runs a refresh asked for while a read is on its way once that read ends', async () => {
    let finish: (value: never) => void = () => {};
    sdkMock.listDurableJobRuns.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const { rerender } = render(DurableRuns, { refreshToken: 0 });
    await waitFor(() => expect(sdkMock.listDurableJobRuns).toHaveBeenCalledTimes(1));

    await rerender({ refreshToken: 1 });
    expect(sdkMock.listDurableJobRuns).toHaveBeenCalledTimes(1);
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [durableRun({ state: 'completed_with_errors' })],
      hasNextPage: false,
    });
    finish({ items: [], hasNextPage: false } as never);

    await waitFor(() => expect(sdkMock.listDurableJobRuns).toHaveBeenCalledTimes(2));
    expect(sdkMock.listDurableJobRuns).toHaveBeenLastCalledWith({ take: 25, skip: 0 });
    expect(await screen.findByText('Completed with errors')).toBeInTheDocument();
  });
  it('does not poll recent work while the tab is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      render(DurableRuns);
      await vi.waitFor(() => expect(sdkMock.listDurableJobRuns).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(sdkMock.listDurableJobRuns).toHaveBeenCalledTimes(1);
      hidden.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sdkMock.listDurableJobRuns).toHaveBeenCalledTimes(2);
    } finally {
      hidden.mockRestore();
      vi.useRealTimers();
    }
  });
});
