import {
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  StudioRenderStage,
  QueueName,
  type MediaOperationDto,
  type QueueRunDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import en from '$i18n/en.json';
import { durableRun } from '$lib/__mocks__/durable-runs.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ActivityView from '$lib/components/frameleaf/ActivityView.svelte';
import { activitySession } from '$lib/frameleaf/activity-session.svelte';
import { runningJobsSession } from '$lib/frameleaf/running-jobs-session.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { downloadManager } from '$lib/managers/download-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

const operation = (overrides: Partial<MediaOperationDto> = {}): MediaOperationDto =>
  ({
    id: '0195e2a0-0000-7000-8000-000000000001',
    kind: MediaOperationKind.StudioExport,
    status: MediaOperationStatus.Rendering,
    destination: MediaOperationDestination.FrameleafCloud,
    destinationDetail: null,
    label: 'Summer in the Rockies',
    assetId: null,
    resultAssetId: null,
    retryOfId: null,
    projectId: null,
    revisionId: null,
    settings: { resolution: '3840×2160' },
    estimate: null,
    progress: 42,
    processedUnits: '420',
    totalUnits: '1000',
    attempt: 1,
    maxAttempts: 3,
    autoRetries: 0,
    retryAt: null,
    error: null,
    errorCode: null,
    cancelRequestedAt: null,
    cancelAcknowledgedAt: null,
    pausable: true,
    pauseRequestedAt: null,
    startedAt: '2026-09-22T09:50:00.000Z',
    finishedAt: null,
    createdAt: '2026-09-22T09:49:00.000Z',
    updatedAt: '2026-09-22T09:59:00.000Z',
    withheld: false,
    ...overrides,
  }) as MediaOperationDto;

/**
 * The page's contract: it shows what the server said, and Cancel and Retry are requests to the
 * server rather than local state changes.
 */
describe('Frameleaf Activity page', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
    activitySession.operations = [];
    activitySession.loading = false;
    activitySession.unreachable = false;
  });

  const mount = async (operations: MediaOperationDto[]) => {
    sdkMock.searchMediaOperations.mockResolvedValue({ items: operations, total: operations.length });
    const result = render(ActivityView, { props: { filter: 'all' } });
    await vi.waitFor(() => expect(sdkMock.searchMediaOperations).toHaveBeenCalled());
    return result;
  };

  it('offers a GPU upgrade only when the Cloud job reports available capacity repricing', async () => {
    const cloudJob = {
      purpose: 'restoration',
      stage: 'full',
      activityStage: 'queued',
      model: 'Restore',
      modelSku: 'ms_54S55W7C',
      plannedWorkers: 1,
      workers: 0,
      cloudStatus: 'queued',
      progressUnit: null,
      cost: {
        estimatedP50Usd: 1,
        estimatedP90Usd: 1.5,
        holdUsd: 2,
        soFarUsd: null,
        settledUsd: null,
        outcome: null,
        note: null,
      },
      routing: {
        quotedComputeSku: 'cs_KGECTVQ0',
        approvedMaximumUsd: 2,
        pricingRevision: 0,
        queuedSince: '2026-09-26T03:59:00.000Z',
        upgradeAvailable: true,
        priceHistory: [],
      },
    };
    await mount([operation({ kind: MediaOperationKind.CloudMlJob, cloudJob } as never)]);
    expect(await screen.findByRole('button', { name: 'Upgrade GPU' })).toBeInTheDocument();
    expect(screen.getByText('Authorized maximum')).toBeInTheDocument();
  });

  it('names the destination on every job so cloud work is never implicit', async () => {
    await mount([operation()]);

    await vi.waitFor(() => expect(screen.getByText(/Frameleaf Cloud/)).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Summer in the Rockies' })).toBeInTheDocument();
  });

  it('asks the server to cancel rather than marking the row itself', async () => {
    sdkMock.cancelMediaOperation.mockResolvedValue(operation({ status: MediaOperationStatus.Cancelling }));
    await mount([operation()]);

    await fireEvent.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(sdkMock.cancelMediaOperation).toHaveBeenCalledWith({ id: '0195e2a0-0000-7000-8000-000000000001' });
    // The row reports stopping, not stopped: the worker has not acknowledged yet.
    await vi.waitFor(() => expect(screen.getByText('Stopping')).toBeInTheDocument());
  });

  it.each([MediaOperationStatus.Queued, MediaOperationStatus.Preparing])(
    'shows render time and a stuck warning only after a worker claims the export (%s)',
    async (status) => {
      await mount([
        operation({
          status,
          startedAt: status === MediaOperationStatus.Queued ? null : '2026-09-22T09:50:00.000Z',
          renderProgress: {
            stage: StudioRenderStage.Preparing,
            lastProgressAt: null,
            framesPerSecond: null,
            remainingRenderSeconds: null,
          },
        }),
      ]);
      if (status === MediaOperationStatus.Queued) {
        // Waiting for its turn isn't work: no elapsed time and no stuck warning.
        await vi.waitFor(() => expect(document.querySelector('.fla-status')).not.toBeNull());
        expect(screen.queryByText(/Elapsed:/)).not.toBeInTheDocument();
        expect(screen.queryByText(/No progress for/)).not.toBeInTheDocument();
      } else {
        await screen.findByText(/Elapsed:/);
        expect(screen.getByText(/No progress for/)).toBeInTheDocument();
      }
    },
  );

  it('offers retry only after a failure, and sends it to the server', async () => {
    sdkMock.retryMediaOperation.mockResolvedValue(
      operation({
        kind: MediaOperationKind.Restoration,
        id: '0195e2a0-0000-7000-8000-000000000002',
        status: MediaOperationStatus.Queued,
      }),
    );
    await mount([
      operation({
        kind: MediaOperationKind.Restoration,
        status: MediaOperationStatus.Failed,
        error: 'The worker stopped responding',
      }),
    ]);

    // The request resolving is not the page having rendered its answer: wait for the row first.
    expect(await screen.findByText('The worker stopped responding')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();

    await fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(sdkMock.retryMediaOperation).toHaveBeenCalledWith({ id: '0195e2a0-0000-7000-8000-000000000001' });
  });

  it('asks the server to pause and shows pausing until the worker gets there (FL-104)', async () => {
    sdkMock.pauseMediaOperation.mockResolvedValue(operation({ pauseRequestedAt: '2026-09-23T10:00:00.000Z' }));
    await mount([operation()]);

    await fireEvent.click(await screen.findByRole('button', { name: /^pause/i }));

    expect(sdkMock.pauseMediaOperation).toHaveBeenCalledWith({ id: '0195e2a0-0000-7000-8000-000000000001' });
    await vi.waitFor(() => expect(screen.getByText('Pausing')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^resume/i })).toBeInTheDocument();
  });

  it('shows a paused job as paused and resumes it through the server (FL-104)', async () => {
    sdkMock.resumeMediaOperation.mockResolvedValue(operation({ status: MediaOperationStatus.Queued }));
    await mount([operation({ status: MediaOperationStatus.Paused, pauseRequestedAt: '2026-09-23T10:00:00.000Z' })]);

    // FL-162 groups In progress by stage: the job sits under the Paused stage and its own status reads Paused.
    const pausedStage = await screen.findByRole('group', { name: /^paused/i });
    const job = within(pausedStage).getByRole('article');
    expect(within(job).getByText(/^Paused at 42%/, { selector: '.fla-status' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^pause/i })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: /^resume/i }));
    expect(sdkMock.resumeMediaOperation).toHaveBeenCalledWith({ id: '0195e2a0-0000-7000-8000-000000000001' });
  });

  it('names a withheld Locked job only as a Locked item (FL-43)', async () => {
    await mount([operation({ kind: MediaOperationKind.Restoration, label: '', withheld: true })]);

    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Locked item' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /pause “locked item”/i })).toBeInTheDocument();
  });

  it('keeps the last state on screen while offline and reconnects on request (FL-43)', async () => {
    sdkMock.searchMediaOperations.mockRejectedValueOnce(new Error('offline'));
    render(ActivityView, { props: { filter: 'all' } });
    const reconnect = await screen.findByRole('button', { name: 'Reconnect' });

    sdkMock.searchMediaOperations.mockResolvedValue({ items: [operation()], total: 1 });
    await fireEvent.click(reconnect);

    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Summer in the Rockies' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('recovers on its own when the server’s socket reconnects (FL-43)', async () => {
    sdkMock.searchMediaOperations.mockRejectedValueOnce(new Error('offline'));
    const { unmount } = render(ActivityView, { props: { filter: 'all' } });
    await screen.findByRole('button', { name: 'Reconnect' });

    // Nobody presses Reconnect: the socket coming back is enough, and the job is where the server left it.
    sdkMock.searchMediaOperations.mockResolvedValue({
      items: [operation({ status: MediaOperationStatus.Validating, progress: 97 })],
      total: 1,
    });
    eventManager.emit('WebsocketConnect');

    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Summer in the Rockies' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /summer in the rockies/i }).getAttribute('aria-valuenow')).toBe(
      '97',
    );

    // Leaving the page stops listening.
    unmount();
    const calls = sdkMock.searchMediaOperations.mock.calls.length;
    eventManager.emit('WebsocketConnect');
    expect(sdkMock.searchMediaOperations).toHaveBeenCalledTimes(calls);
  });

  it('shows a job queued elsewhere as soon as the server says it changed (FL-43)', async () => {
    await mount([]);
    await screen.findByRole('heading', { name: 'Everything is up to date' });

    sdkMock.searchMediaOperations.mockResolvedValue({
      items: [
        operation({
          id: '0195e2a0-0000-7000-8000-000000000031',
          kind: MediaOperationKind.QuickEdit,
          status: MediaOperationStatus.Queued,
          label: 'IMG_0042.jpg',
          settings: { edit: 'photo_version' },
          pausable: false,
          progress: 0,
          processedUnits: '0',
          totalUnits: null,
        }),
      ],
      total: 1,
    });
    eventManager.emit('MediaOperationUpdate', { id: '0195e2a0-0000-7000-8000-000000000031' });

    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'IMG_0042.jpg' })).toBeInTheDocument());
    expect(screen.getByText(/Photo version/)).toBeInTheDocument();
  });

  it('names edits by what was edited and offers cancel only where the server allows it (FL-43)', async () => {
    await mount([
      operation({
        kind: MediaOperationKind.QuickEdit,
        label: 'IMG_0100.MOV',
        settings: { edit: 'video_edit' },
        destination: MediaOperationDestination.Local,
        pausable: false,
      }),
    ]);

    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'IMG_0100.MOV' })).toBeInTheDocument());
    expect(screen.getByText(/Video edit/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
  });

  it('shows pause disabled, with its reason, for a kind that runs in one go (A-10)', async () => {
    await mount([operation({ kind: MediaOperationKind.StudioPreview, pausable: false, projectId: 'project-1' })]);

    await vi.waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument());
    const pause = screen.getByRole('button', { name: /pause/i });
    expect(pause).toHaveAttribute('aria-disabled', 'true');
    expect(pause).toHaveAccessibleDescription("This kind of job runs in one go and can't be paused");
    await fireEvent.click(pause);
    expect(sdkMock.pauseMediaOperation).not.toHaveBeenCalled();
  });

  it('opens a Studio render in Studio (FL-104)', async () => {
    await mount([operation({ kind: MediaOperationKind.StudioExport, projectId: 'project-1' })]);
    await fireEvent.click(await screen.findByRole('button', { name: /open in studio/i }));
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('project-1'));
  });

  it.each([
    [MediaOperationKind.StudioExport, MediaOperationStatus.Failed],
    [MediaOperationKind.StudioExport, MediaOperationStatus.Cancelled],
    [MediaOperationKind.StudioExportPublish, MediaOperationStatus.Failed],
    [MediaOperationKind.StudioExportPublish, MediaOperationStatus.Cancelled],
    [MediaOperationKind.StudioPreview, MediaOperationStatus.Failed],
    [MediaOperationKind.StudioPreview, MediaOperationStatus.Cancelled],
    [MediaOperationKind.StudioPreviewStream, MediaOperationStatus.Failed],
    [MediaOperationKind.StudioPreviewStream, MediaOperationStatus.Cancelled],
  ])('opens %s %s in Studio instead of offering a copied retry', async (kind, status) => {
    await mount([operation({ kind, status, projectId: 'project-1' })]);
    await fireEvent.click(await screen.findByRole('button', { name: /open in studio/i }));
    expect(screen.queryByRole('button', { name: /^retry$/i })).not.toBeInTheDocument();
    expect(sdkMock.retryMediaOperation).not.toHaveBeenCalled();
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('project-1'));
  });

  it('keeps the last known list when the server cannot be reached', async () => {
    activitySession.operations = [operation()];
    activitySession.unreachable = true;
    render(ActivityView, { props: { filter: 'all' } });

    expect(screen.getByRole('heading', { name: 'Summer in the Rockies' })).toBeInTheDocument();
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
  });

  it('draws the prototype job card: status chip, progress bar and status line (FL-43)', async () => {
    await mount([operation()]);

    const heading = await screen.findByRole('heading', { name: 'Summer in the Rockies' });
    const card = heading.closest('article');
    expect(card?.classList).toContain('fla-job');
    expect(card?.getAttribute('aria-labelledby')).toBe(heading.id);
    const bar = screen.getByRole('progressbar', { name: /summer in the rockies/i });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    // A legacy Studio worker supplies counted percent, but no measured frame rate or render ETA.
    expect(card?.querySelector(':scope .fla-status')?.textContent?.trim()).toBe('Rendering · 42%');
    expect(card?.querySelector(':scope .fla-chip .fla-dot')).not.toBeNull();
    // FL-1388: the page opens on one sentence about how the work is going.
    expect(screen.getByRole('heading', { name: '1 job in progress' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^in progress/i }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /^all/i }).getAttribute('aria-pressed')).toBe('true');
  });

  it('never draws a thumbnail for a withheld Locked job, only the kind icon (FL-43)', async () => {
    await mount([
      operation({
        kind: MediaOperationKind.Restoration,
        label: '',
        withheld: true,
        assetId: '0195e2a0-0000-7000-8000-0000000000aa',
      }),
    ]);

    const heading = await screen.findByRole('heading', { name: 'Locked item' });
    const card = heading.closest('article')!;
    expect(card.querySelector(':scope .fla-thumb img')).toBeNull();
    expect(card.querySelector(':scope .fla-thumb svg')).not.toBeNull();
  });

  it('shows a finished job as one line, with its result to open (FL-1388)', async () => {
    const { container } = await mount([
      operation({
        status: MediaOperationStatus.Completed,
        progress: 100,
        resultAssetId: '0195e2a0-0000-7000-8000-0000000000bb',
        finishedAt: '2026-09-22T10:10:00.000Z',
      }),
    ]);

    const finished = await screen.findByRole('region', { name: 'Finished' });
    const [line] = within(finished).getAllByRole('listitem');
    expect(within(line).getByText('Summer in the Rockies')).toBeInTheDocument();
    // Cloud work is never implicit, and the result says more than "Done".
    expect(within(line).getByText('Export · Frameleaf Cloud · 3840×2160 · Done in 20 minutes')).toBeInTheDocument();
    expect(line.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-22T10:10:00.000Z');
    // A line, not a card: no picture, no bar, no chip, no clear button of its own.
    expect(container.querySelector('article')).toBeNull();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    await fireEvent.click(within(line).getByRole('button', { name: /open the result of “summer in the rockies”/i }));
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('0195e2a0-0000-7000-8000-0000000000bb'));
  });

  it('puts every run of the same job on one line (FL-1388)', async () => {
    const scans = Array.from({ length: 79 }, (_, index) =>
      operation({
        id: `0195e2a0-0000-7000-8000-${String(index).padStart(12, '0')}`,
        kind: MediaOperationKind.MediaHealth,
        status: MediaOperationStatus.Completed,
        destination: MediaOperationDestination.Local,
        label: 'Scheduled library health scan',
        settings: {},
        progress: 100,
        pausable: false,
        startedAt: new Date(Date.UTC(2026, 8, 22, 3) - index * 86_400_000).toISOString(),
        finishedAt: new Date(Date.UTC(2026, 8, 22, 3, 12) - index * 86_400_000).toISOString(),
      }),
    );
    const { container } = await mount(scans);

    const finished = await screen.findByRole('region', { name: 'Finished' });
    const lines = within(finished).getAllByRole('listitem');
    expect(lines).toHaveLength(1);
    expect(within(lines[0]).getByText('Scheduled library health scan')).toBeInTheDocument();
    expect(within(lines[0]).getByText('Library Care · 79 times')).toBeInTheDocument();
    // The newest run's time.
    expect(lines[0].querySelector('time')?.getAttribute('datetime')).toBe('2026-09-22T03:12:00.000Z');
    expect(container.querySelector('article')).toBeNull();
    // The Done chip counts lines, as the list shows them.
    expect(screen.getByRole('button', { name: /^done/i })).toHaveTextContent(/^Done\s*1/);
    // Clear finished still clears every run.
    expect(screen.getByRole('button', { name: 'Clear finished' })).toBeInTheDocument();
  });

  it('keeps a failure as a card under Needs a look, with its reason and Retry (FL-1388)', async () => {
    await mount([
      operation({
        kind: MediaOperationKind.Restoration,
        status: MediaOperationStatus.Failed,
        label: 'IMG_4821.MOV',
        error: 'The file is damaged near the end.',
        finishedAt: '2026-09-22T10:10:00.000Z',
      }),
    ]);

    const section = await screen.findByRole('region', { name: /needs a look/i });
    const card = within(section).getByRole('article', { name: 'IMG_4821.MOV' });
    expect(within(card).getByText('The file is damaged near the end.')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1 thing needs a look' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Finished' })).not.toBeInTheDocument();
  });

  // FL-1412 (M13): a quiet Activity page is the one empty-page pattern, with the page's own words.
  it('says everything is up to date, once and with nothing to filter, when there are no tasks', async () => {
    await mount([]);

    const empty = await screen.findByTestId('frameleaf-empty-state');
    expect(within(empty).getByRole('heading', { name: 'Everything is up to date' })).toBeInTheDocument();
    expect(empty).toHaveTextContent(en.frameleaf_activity_empty_help_own);
    expect(empty.querySelector('button, a')).toBeNull();
    // No filters, no status line and no empty In progress section beside it.
    expect(screen.queryByRole('group', { name: 'Filter jobs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'How the work is going' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'In progress' })).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing is running.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to library' })).not.toBeInTheDocument();
    // Nobody who may not pause the server's work is offered it.
    expect(screen.queryByRole('button', { name: 'Pause all' })).not.toBeInTheDocument();
  });

  it('keeps the filters, and says so in the same pattern, when only the chosen filter is empty', async () => {
    sdkMock.searchMediaOperations.mockResolvedValue({ items: [], total: 0 });
    render(ActivityView, { props: { filter: 'done' } });

    const empty = await screen.findByTestId('frameleaf-empty-state');
    expect(within(empty).getByRole('heading', { name: 'No finished jobs yet' })).toBeInTheDocument();
    expect(empty).toHaveTextContent('Jobs move here as they finish.');
    expect(screen.getByRole('group', { name: 'Filter jobs' }).querySelectorAll('button')).toHaveLength(4);
  });

  const queue = (name: QueueName, overrides: Partial<QueueRunDto> = {}): QueueRunDto => ({
    name,
    isPaused: false,
    canPause: true,
    active: 0,
    waiting: 0,
    processed: 0,
    total: 0,
    startedAt: '2026-10-16T06:21:07.685Z',
    unavailable: false,
    ...overrides,
  });
  const idle = { operations: [], memoryExports: [], queues: [], canManageQueues: false };

  it('shows busy server work by feature, never by the server’s own names (FL-1388)', async () => {
    sdkMock.getRunningJobs.mockResolvedValue({
      operations: [],
      memoryExports: [],
      canManageQueues: true,
      canReadJobRuns: true,
      queues: [
        queue(QueueName.ThumbnailGeneration, { active: 2, waiting: 18, processed: 30, total: 50 }),
        queue(QueueName.MetadataExtraction, { active: 1, waiting: 9, processed: 40, total: 50 }),
        queue(QueueName.FaceDetection, { isPaused: true, waiting: 52, total: 52 }),
        queue(QueueName.Ocr),
      ],
      durableRuns: [],
    });
    try {
      await mount([]);

      const section = await screen.findByRole('region', { name: 'In progress' });
      const rows = within(section).getAllByRole('listitem');
      // Every feature while any is busy: two tasks of one feature are one row.
      expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual([
        'Ready to browse',
        'Faces & identity',
        'Visual search',
        'Text, documents & receipts',
        'Descriptions & tags',
        'Transcripts & captions',
        'Studio export',
        'Upkeep',
      ]);
      expect(within(rows[0]).getByText('70 of 100')).toBeInTheDocument();
      expect(within(rows[0]).getByRole('progressbar', { name: /ready to browse/i })).toHaveAttribute(
        'aria-valuenow',
        '70',
      );
      expect(within(rows[1]).getByText('Paused · 52 left')).toBeInTheDocument();
      expect(within(rows[3]).getByText('Up to date')).toBeInTheDocument();
      // The server's names stay under Technical details.
      expect(within(rows[1]).getByText('Technical details')).toBeInTheDocument();
      expect(within(rows[1]).getByText(/The server’s tasks: Face detection, /)).toBeInTheDocument();
      // One sentence at the top, with Pause all and the settings.
      expect(screen.getByRole('heading', { name: 'Working through 82 items' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Background work settings' })).toHaveAttribute(
        'href',
        expect.stringContaining('area=processing'),
      );
      expect(screen.queryByText(/stage|prerequisite|queue/i)).not.toBeInTheDocument();

      // Pause all is a request to the server for every task that can pause; the rows wait for its answer.
      await fireEvent.click(screen.getByRole('button', { name: 'Pause all' }));
      await vi.waitFor(() =>
        expect(sdkMock.updateQueue).toHaveBeenCalledWith({
          name: QueueName.ThumbnailGeneration,
          queueUpdateDto: { isPaused: true },
        }),
      );
      expect(sdkMock.updateQueue).not.toHaveBeenCalledWith(expect.objectContaining({ name: QueueName.BackgroundTask }));
      expect(within(rows[0]).getByText('70 of 100')).toBeInTheDocument();

      // A feature's own control resumes just its tasks, once the page is done asking.
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Pause all' })).toBeEnabled());
      sdkMock.updateQueue.mockClear();
      await fireEvent.click(within(rows[1]).getByRole('button', { name: 'Resume Faces & identity' }));
      await vi.waitFor(() =>
        expect(sdkMock.updateQueue).toHaveBeenCalledWith({
          name: QueueName.FaceDetection,
          queueUpdateDto: { isPaused: false },
        }),
      );
      expect(sdkMock.updateQueue).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: QueueName.ThumbnailGeneration }),
      );
    } finally {
      runningJobsSession.summary = idle;
    }
  });

  it('says background work is paused, and resumes it, when every busy feature is paused (FL-1388)', async () => {
    sdkMock.getRunningJobs.mockResolvedValue({
      operations: [],
      memoryExports: [],
      canManageQueues: true,
      queues: [queue(QueueName.FaceDetection, { isPaused: true, waiting: 52, total: 52 })],
    });
    try {
      await mount([]);

      expect(await screen.findByRole('heading', { name: 'Background work is paused' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Pause all' })).not.toBeInTheDocument();
      await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      await vi.waitFor(() =>
        expect(sdkMock.updateQueue).toHaveBeenCalledWith({
          name: QueueName.FaceDetection,
          queueUpdateDto: { isPaused: false },
        }),
      );
    } finally {
      runningJobsSession.summary = idle;
    }
  });

  it('names a held import and opens Background work, never a queue page it does not have (FL-1177)', async () => {
    sdkMock.getRunningJobs.mockResolvedValue({
      operations: [],
      memoryExports: [],
      canManageQueues: true,
      canReadJobRuns: true,
      queues: [],
      durableRuns: [
        durableRun({
          kind: 'immich-import-derived',
          state: 'waiting',
          active: 0,
          waiting: 40,
          total: 40,
          completed: 0,
          held: 40,
        }),
      ],
    });
    try {
      await mount([]);
      const section = await screen.findByRole('region', { name: 'In progress' });
      const row = within(section).getByText('Library import').closest('li')!;
      const link = within(row).getByRole('link');
      expect(link).toHaveAccessibleName('Library import: Waiting for the file check · 40 left. Open Background work.');
      expect(link).toHaveAttribute('href', expect.stringContaining('section=queues'));
      expect(link.getAttribute('href')).not.toContain('immich-import-derived');
      // It is work in progress, so the page never opens on "Everything is up to date" above it.
      expect(screen.getByRole('heading', { name: '1 job in progress' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Everything is up to date' })).not.toBeInTheDocument();
    } finally {
      runningJobsSession.summary = idle;
    }
  });

  it('declares its own theme scope so the Frameleaf colours resolve', async () => {
    const { container } = await mount([]);

    expect(container.querySelector<HTMLElement>('main.frameleaf')?.dataset.theme).toMatch(/^(dark|light)$/);
  });

  it('names a row whose id holds spaces, and never draws an upload picture', async () => {
    downloadManager.start({ name: 'Holiday (1/2).zip', assetIds: ['a'], total: 10 }, () => new Promise<Blob>(() => {}));
    uploadAssetsStore.addItem({
      id: 'upload-1',
      file: new File([''], 'private.jpg'),
      assetId: '0195e2a0-0000-7000-8000-00000000000a',
      state: UploadState.DONE,
    });
    try {
      await mount([]);

      // The row heading id comes from the list position, so a key with spaces still names the row.
      expect(await screen.findByRole('article', { name: 'Holiday (1/2)' })).toBeInTheDocument();
      // An upload row carries no withheld flag, so it never shows its (possibly Locked) picture.
      const upload = screen.getByRole('article', { name: 'private.jpg' });
      expect(upload.querySelector(':scope .fla-thumb img')).toBeNull();
    } finally {
      downloadManager.clearAll();
      uploadAssetsStore.reset();
    }
  });

  /** Activity as an administrator sees it: the server's background and cloud work too. */
  const asAdmin = () => {
    const spies = [
      vi.spyOn(authManager, 'authenticated', 'get').mockReturnValue(true),
      vi.spyOn(authManager, 'user', 'get').mockReturnValue({ id: 'admin', isAdmin: true } as never),
    ];
    return () => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    };
  };

  it('tells somebody who is not an administrator only about their own work when nothing runs', async () => {
    await mount([]);

    await vi.waitFor(() => expect(screen.getByText(en.frameleaf_activity_empty_help_own)).toBeInTheDocument());
    expect(screen.queryByText(en.frameleaf_activity_work_quiet)).not.toBeInTheDocument();
  });

  it('keeps a cloud backup in the list until the cloud status shows it, and asks for that status again', async () => {
    const restore = asAdmin();
    sdkMock.getCloudBackupStatus.mockRejectedValue(new Error('unavailable'));
    try {
      await mount([operation({ kind: MediaOperationKind.CloudBackup, label: 'Nightly cloud backup' })]);

      expect(await screen.findByRole('article', { name: 'Nightly cloud backup' })).toBeInTheDocument();
      await vi.waitFor(() => expect(sdkMock.getCloudBackupStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(screen.getByRole('article', { name: 'Nightly cloud backup' })).toBeInTheDocument();
      // The cloud status could not be read, so Activity says its background numbers may be stale.
      expect(screen.getByText(en.frameleaf_activity_background_stale)).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('says background work may be out of date when it cannot be read', async () => {
    const restore = asAdmin();
    sdkMock.getRunningJobs.mockRejectedValue(new Error('unavailable'));
    try {
      await mount([]);

      expect(await screen.findByText(en.frameleaf_activity_background_stale)).toBeInTheDocument();
      // Numbers that may be old are never read as "up to date".
      expect(screen.getByRole('heading', { name: 'Couldn’t be read' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Everything is up to date' })).not.toBeInTheDocument();
    } finally {
      restore();
      runningJobsSession.unreachable = false;
    }
  });

  it('says nothing about how the work is going until the server has answered', async () => {
    let answer: (value: undefined) => void = () => {};
    sdkMock.getRunningJobs.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    runningJobsSession.loading = true;
    await mount([]);

    expect(screen.queryByRole('region', { name: 'How the work is going' })).not.toBeInTheDocument();
    answer(undefined);
    expect(await screen.findByRole('heading', { name: 'Everything is up to date' })).toBeInTheDocument();
  });

  // FL-1409: Activity agrees with Recent work.
  it('counts finished work that left photos over, and opens its review (FL-1409)', async () => {
    sdkMock.getRunningJobs.mockResolvedValue({
      operations: [],
      memoryExports: [],
      canManageQueues: true,
      canReadJobRuns: true,
      queues: [],
      durableRuns: [
        durableRun({
          state: 'completed_with_errors',
          finishedAt: '2026-11-10T04:06:00.000Z',
          active: 0,
          total: 15_000,
          completed: 14_688,
          failed: 312,
          needsAttention: 0,
          leftOver: 312,
          failureCauses: [
            { cause: 'drive', count: 300 },
            { cause: 'damaged', count: 12 },
          ],
        } as never),
      ],
    });
    sdkMock.getJobRunFailures.mockResolvedValue({ photos: 312, countsPhotos: true, causes: [] });
    try {
      await mount([]);

      // Never "Everything is up to date" beside Recent work's "312 photos need a look".
      expect(await screen.findByRole('heading', { name: '1 thing needs a look' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Everything is up to date' })).not.toBeInTheDocument();
      const section = screen.getByRole('region', { name: /Needs a look/ });
      const card = within(section).getByRole('article', { name: 'Thumbnails' });
      // Recent work's state, count and plain causes.
      expect(card).toHaveTextContent('Finished, with photos left over · 312 photos need a look');
      expect(card).toHaveTextContent('A drive can’t be reached · 300, Damaged file · 12');
      expect(screen.getByRole('button', { name: 'Failed 1 job' })).toBeInTheDocument();

      await fireEvent.click(within(card).getByRole('button', { name: 'Review what failed' }));
      await vi.waitFor(() =>
        expect(sdkMock.getJobRunFailures).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) })),
      );
    } finally {
      runningJobsSession.summary = idle;
    }
  });

  // FL-1412 (M13): the empty page keeps to Recent work's run rules (FL-1409).
  it.each([
    ['is paused', { state: 'paused', reasons: ['queue_paused'], active: 0, paused: 40 }],
    [
      'waits for a drive',
      {
        state: 'waiting',
        reasons: ['source-unavailable'],
        unreachableLibraries: ['Family NAS'],
        active: 0,
        waiting: 40,
      },
    ],
  ])('never says everything is up to date while a run %s', async (_, patch) => {
    sdkMock.getRunningJobs.mockResolvedValue({
      operations: [],
      memoryExports: [],
      canManageQueues: true,
      canReadJobRuns: true,
      queues: [],
      durableRuns: [durableRun({ total: 40, completed: 0, failed: 0, needsAttention: 0, ...patch } as never)],
    });
    try {
      await mount([]);

      expect(await screen.findByRole('region', { name: 'In progress' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Everything is up to date' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('frameleaf-empty-state')).not.toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Filter jobs' })).toBeInTheDocument();
    } finally {
      runningJobsSession.summary = idle;
    }
  });

  it('shows an interrupted scan in plain words, and starts it again (FL-1409)', async () => {
    sdkMock.getAllLibraries.mockResolvedValue([
      { id: 'library-1', name: 'Family archive', assetCount: 7103, scan: { operationId: 'scan-1' } },
    ] as never);
    sdkMock.scanLibrary.mockResolvedValue(undefined as never);
    sdkMock.dismissMediaOperation.mockResolvedValue(undefined as never);
    await mount([
      operation({
        id: 'scan-1',
        kind: MediaOperationKind.LibraryScan,
        status: MediaOperationStatus.Failed,
        destination: MediaOperationDestination.Local,
        label: 'Family archive',
        error: 'The library queue attempt was interrupted',
        errorCode: 'library_scan_interrupted',
        finishedAt: '2026-11-10T09:20:00.000Z',
      }),
    ]);

    const section = await screen.findByRole('region', { name: /Needs a look/ });
    const card = within(section).getByRole('article', { name: 'The scan of “Family archive” was interrupted' });
    expect(card).toHaveTextContent('The server restarted while it was reading the folder. Nothing was lost');
    // Not the old row: "Failed", the raw message in the main line and only a dismiss button.
    expect(within(card).queryByText('Failed')).not.toBeInTheDocument();
    expect(within(card).getByText('The library queue attempt was interrupted').closest('details')).not.toBeNull();

    await fireEvent.click(await within(card).findByRole('button', { name: 'Scan again' }));
    await vi.waitFor(() => expect(sdkMock.scanLibrary).toHaveBeenCalledWith({ id: 'library-1' }));
    await vi.waitFor(() => expect(sdkMock.dismissMediaOperation).toHaveBeenCalledWith({ id: 'scan-1' }));
  });

  it('still reads the new scan when only clearing the stopped one fails (FL-1409)', async () => {
    sdkMock.getAllLibraries.mockResolvedValue([
      { id: 'library-1', name: 'Family archive', assetCount: 7103, scan: { operationId: 'scan-1' } },
    ] as never);
    sdkMock.scanLibrary.mockResolvedValue(undefined as never);
    sdkMock.dismissMediaOperation.mockRejectedValue(new Error('offline'));
    await mount([
      operation({
        id: 'scan-1',
        kind: MediaOperationKind.LibraryScan,
        status: MediaOperationStatus.Failed,
        destination: MediaOperationDestination.Local,
        label: 'Family archive',
        error: 'The library queue attempt was interrupted',
        errorCode: 'library_scan_interrupted',
        finishedAt: '2026-11-10T09:20:00.000Z',
      }),
    ]);
    const reads = sdkMock.searchMediaOperations.mock.calls.length;

    await fireEvent.click(await screen.findByRole('button', { name: 'Scan again' }));
    await vi.waitFor(() => expect(sdkMock.dismissMediaOperation).toHaveBeenCalled());
    // The scan was asked for once, the list is read again, and the card can still be cleared.
    await vi.waitFor(() => expect(sdkMock.searchMediaOperations.mock.calls.length).toBeGreaterThan(reads));
    expect(sdkMock.scanLibrary).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });
});
