import { JobRunFailureCause, QueueName } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
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
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.listDurableJobRuns.mockResolvedValue({ items: [], hasNextPage: false });
});
describe('recent work', () => {
  it('says how far a run has got in photos, and what is left over by cause', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [
        durableRun({
          failedQueues: [QueueName.ThumbnailGeneration],
          failureCauses: [
            { cause: JobRunFailureCause.Drive, count: 19 },
            { cause: JobRunFailureCause.Damaged, count: 5 },
          ],
        }),
      ],
      hasNextPage: false,
    });
    render(DurableRuns);
    expect(await screen.findByText('14,992 of 15,000 photos')).toBeInTheDocument();
    expect(sdkMock.listDurableJobRuns).toHaveBeenCalledWith({ take: 25, skip: 0, foldNightly: true });
    // No operator wording: stages, settled items or coordination work.
    expect(document.body.textContent).not.toMatch(/stage|settled|coordination|queue|job/i);
  });
  it('shows causes with counts and one Review what failed button, no See what failed links', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [
        durableRun({
          failed: 2,
          needsAttention: 0,
          failedQueues: [QueueName.ThumbnailGeneration, QueueName.MetadataExtraction],
          failureCauses: [
            { cause: JobRunFailureCause.Drive, count: 19 },
            { cause: JobRunFailureCause.Damaged, count: 5 },
          ],
        }),
      ],
      hasNextPage: false,
    });
    render(DurableRuns);
    // The number is the sum of the causes beside it, though the run itself counts fewer so far.
    expect(await screen.findByText('24 photos need a look')).toBeInTheDocument();
    expect(screen.getByText('A drive can’t be reached · 19')).toBeInTheDocument();
    expect(screen.getByText('Damaged file · 5')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Review what failed' })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: /See what failed/ })).not.toBeInTheDocument();

    sdkMock.getJobRunFailures.mockResolvedValue({ photos: 0, countsPhotos: true, causes: [] });
    await fireEvent.click(screen.getByRole('button', { name: 'Review what failed' }));
    expect(await screen.findByText('What failed in Thumbnails')).toBeInTheDocument();
    expect(sdkMock.getJobRunFailures).toHaveBeenCalledWith({ id: '0195e2a0-0000-7000-8000-000000000001' });
  });
  it('a paused run shows Paused and one reason, not Running', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [
        durableRun({
          state: 'running',
          reasons: ['queue_paused', 'scheduled_delay'],
          pausedQueues: [QueueName.MetadataExtraction],
          failed: 0,
          needsAttention: 0,
        }),
      ],
      hasNextPage: false,
    });
    sdkMock.updateQueue.mockResolvedValue({} as never);
    render(DurableRuns);
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('Paused. It carries on when you resume it.')).toBeInTheDocument();
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
    expect(screen.queryByText(/night window/)).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(sdkMock.updateQueue).toHaveBeenCalledWith({
        name: QueueName.MetadataExtraction,
        queueUpdateDto: { isPaused: false },
      }),
    );
    await waitFor(() => expect(sdkMock.listDurableJobRuns).toHaveBeenCalledTimes(2));
  });
  it('three nightly runs show as one card; Earlier nights lists two', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [
        durableRun({
          kind: 'OvernightSequence',
          nightly: true,
          state: 'completed_with_errors',
          active: 0,
          total: 2221,
          completed: 1358,
          failed: 863,
          needsAttention: 0,
          finishedAt: '2026-11-10T09:06:00.000Z',
          failureCauses: [{ cause: JobRunFailureCause.Damaged, count: 863 }],
          earlierRuns: [
            {
              id: 'n2',
              createdAt: '2026-11-09T08:00:00.000Z',
              finishedAt: '2026-11-09T09:06:00.000Z',
              total: 2177,
              leftOver: 861,
            },
            {
              id: 'n3',
              createdAt: '2026-11-08T08:00:00.000Z',
              finishedAt: '2026-11-08T09:05:00.000Z',
              total: 2100,
              leftOver: 12,
            },
          ],
        }),
      ],
      hasNextPage: false,
    });
    render(DurableRuns);
    expect(await screen.findByText('Nightly processing')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').filter((item) => item.closest('ol'))).toHaveLength(1);
    expect(screen.getByText('Finished, with photos left over')).toBeInTheDocument();
    expect(screen.getByText(/^Every night · last finished/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Earlier nights' }));
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    // A heading row, this night, then the two earlier ones.
    expect(rows).toHaveLength(4);
    expect(rows[2]).toHaveTextContent('2,177861');
    expect(rows[3]).toHaveTextContent('2,10012');
    expect(screen.getByRole('button', { name: 'Hide earlier nights' })).toHaveAttribute('aria-expanded', 'true');
  });
  it('the same 863 photos have been left over 2 nights in a row', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [
        durableRun({
          nightly: true,
          state: 'completed_with_errors',
          active: 0,
          failureCauses: [{ cause: JobRunFailureCause.Damaged, count: 863 }],
          leftOverStreak: { photos: 863, nights: 2 },
        }),
      ],
      hasNextPage: false,
    });
    render(DurableRuns);
    expect(
      await screen.findByText(
        'The same 863 photos have been left over 2 nights in a row. Sorting them out once stops them coming back.',
      ),
    ).toBeInTheDocument();
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
    [
      { state: 'blocked' as const, reasons: ['destination-unavailable' as const] },
      'It carries on by itself when machine learning is available.',
    ],
    [
      { state: 'blocked' as const, reasons: ['source-unavailable' as const], unreachableLibraries: ['Archive'] },
      'The external library “Archive” can’t be reached. It carries on by itself when the drive is back.',
    ],
    [
      { state: 'blocked' as const, reasons: ['first_setup_pending' as const], held: 1200 },
      '1,200 photos are waiting for library setup to finish checking your files.',
    ],
  ])('says what is holding a run up in words, once', async (overrides, words) => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [durableRun({ ...overrides, failed: 0, needsAttention: 0 })],
      hasNextPage: false,
    });
    render(DurableRuns);
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(document.querySelectorAll('.why')).toHaveLength(1);
  });
  it('offers Release only for held work, and reads again after releasing', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [
        durableRun({
          id: '0195e2a0-0000-7000-8000-000000000002',
          state: 'blocked',
          reasons: ['first_setup_pending'],
          held: 1200,
          canRelease: true,
        }),
        durableRun(),
      ],
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
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [durableRun({ state: 'blocked', reasons: ['first_setup_pending'], held: 3, canRelease: true })],
      hasNextPage: false,
    });
    sdkMock.releaseJobRun.mockRejectedValue({ status: 400 });
    sdkMock.isHttpError.mockReturnValue(true);
    render(DurableRuns);
    await fireEvent.click(await screen.findByRole('button', { name: 'Release' }));
    expect(await screen.findByText(/until Frameleaf Manager has finished/)).toBeInTheDocument();
  });
  it('uses server pagination and keeps the last runs after a failed refresh', async () => {
    sdkMock.listDurableJobRuns.mockResolvedValue({
      items: [durableRun({ state: 'completed_with_errors', active: 0 })],
      hasNextPage: true,
    });
    render(DurableRuns);
    expect(await screen.findByText('Finished, with photos left over')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(sdkMock.listDurableJobRuns).toHaveBeenLastCalledWith({ take: 25, skip: 25, foldNightly: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled());
    sdkMock.listDurableJobRuns.mockRejectedValueOnce(new Error('offline'));
    await fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('status')).toHaveTextContent('may be out of date');
    expect(screen.getByText('Finished, with photos left over')).toBeInTheDocument();
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
    expect(sdkMock.listDurableJobRuns).toHaveBeenLastCalledWith({ take: 25, skip: 0, foldNightly: true });
    expect(await screen.findByText('Finished, with photos left over')).toBeInTheDocument();
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
