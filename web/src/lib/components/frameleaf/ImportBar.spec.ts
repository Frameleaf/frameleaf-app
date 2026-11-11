import { QueueName, type DurableRunningJobs } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { durableRun } from '$lib/__mocks__/durable-runs.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ImportBar from '$lib/components/frameleaf/ImportBar.svelte';
import { runningJobsSession } from '$lib/frameleaf/running-jobs-session.svelte';
import { setupProgress } from '$lib/stores/setup-progress.svelte';

const thumbnails = {
  name: QueueName.ThumbnailGeneration,
  isPaused: false,
  canPause: true,
  active: 4,
  waiting: 9210,
  processed: 7103,
  total: 16_317,
  startedAt: new Date(Date.now() - 600_000).toISOString(),
  unavailable: false,
};
const scan = durableRun({
  id: 'scan-1',
  kind: 'library_scan',
  total: 16_317,
  completed: 7000,
  failed: 0,
  needsAttention: 0,
  waiting: 9313,
  reasons: [],
  stageTotals: { ...durableRun().stageTotals, failed: 0, needsAttention: 0 },
  pausedQueues: [],
});
const answer = (patch: Partial<DurableRunningJobs>) =>
  sdkMock.getRunningJobs.mockResolvedValue({
    operations: [],
    memoryExports: [],
    queues: [],
    canManageQueues: true,
    canReadJobRuns: true,
    durableRuns: [],
    ...patch,
  } as never);

/** FL-1409 (M5): the first-run bar's row, during any large import. */
describe('the import bar (FL-1409)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });
  beforeEach(() => {
    vi.resetAllMocks();
    setupProgress.reset();
    // The session outlives a test: the last test's answer must not show in the next.
    runningJobsSession.summary = { operations: [], memoryExports: [], queues: [], canManageQueues: false };
  });

  it('says how many photos a scan has ready and about how long is left', async () => {
    answer({
      queues: [thumbnails],
      durableRuns: [scan],
      operations: [{ id: 'scan-1', label: 'Family archive' }] as DurableRunningJobs['operations'],
    });
    render(ImportBar);

    const line = await screen.findByRole('status');
    expect(line).toHaveTextContent('Adding photos from “Family archive”');
    expect(line).toHaveTextContent('7,103 of 16,317 ready · about 13 minutes left');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43');
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  it('says a paused scan in its Recent work card’s words, and resumes it', async () => {
    answer({
      queues: [{ ...thumbnails, isPaused: true, active: 0 }],
      durableRuns: [{ ...scan, active: 0, reasons: ['queue_paused'], pausedQueues: [QueueName.ThumbnailGeneration] }],
    });
    sdkMock.updateQueue.mockResolvedValue({} as never);
    render(ImportBar);

    const line = await screen.findByRole('status');
    expect(line).toHaveTextContent('Paused: You paused this. It carries on when you resume it.');
    expect(line).not.toHaveTextContent('left');
    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await vi.waitFor(() =>
      expect(sdkMock.updateQueue).toHaveBeenCalledWith({
        name: QueueName.ThumbnailGeneration,
        queueUpdateDto: { isPaused: false },
      }),
    );
  });

  it('says Waiting for a drive, by the library’s name, with nothing to press', async () => {
    answer({
      queues: [{ ...thumbnails, active: 0 }],
      durableRuns: [{ ...scan, active: 0, reasons: ['source-unavailable'], unreachableLibraries: ['Family archive'] }],
    });
    render(ImportBar);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Waiting for a drive: The external library “Family archive” can’t be reached.',
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('stays away for a few photos, and while the first-run bar shows', async () => {
    answer({ queues: [{ ...thumbnails, waiting: 20, processed: 30, total: 54 }] });
    const few = render(ImportBar);
    await vi.waitFor(() => expect(runningJobsSession.summary.queues).toHaveLength(1));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    few.unmount();
    runningJobsSession.summary = { operations: [], memoryExports: [], queues: [], canManageQueues: false };

    answer({ queues: [thumbnails] });
    setupProgress.progress = { active: true, completedAt: null } as never;
    render(ImportBar);
    await vi.waitFor(() => expect(runningJobsSession.summary.queues).toHaveLength(1));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
