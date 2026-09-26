import {
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  type MediaOperationDto,
} from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ActivityView from '$lib/components/frameleaf/ActivityView.svelte';
import { activitySession } from '$lib/frameleaf/activity-session.svelte';
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

  it('offers retry only after a failure, and sends it to the server', async () => {
    sdkMock.retryMediaOperation.mockResolvedValue(
      operation({ id: '0195e2a0-0000-7000-8000-000000000002', status: MediaOperationStatus.Queued }),
    );
    await mount([operation({ status: MediaOperationStatus.Failed, error: 'The worker stopped responding' })]);

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

    await vi.waitFor(() => expect(screen.getByText('Paused')).toBeInTheDocument());
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
    await screen.findByRole('heading', { name: 'Nothing processing' });

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

  it('keeps the last known list when the server cannot be reached', async () => {
    activitySession.operations = [operation()];
    activitySession.unreachable = true;
    render(ActivityView, { props: { filter: 'all' } });

    expect(screen.getByRole('heading', { name: 'Summer in the Rockies' })).toBeInTheDocument();
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
  });

  it('draws the prototype job card: status chip, progress bar and status line (FL-43)', async () => {
    const { container } = await mount([operation()]);

    const heading = await screen.findByRole('heading', { name: 'Summer in the Rockies' });
    const card = heading.closest('article');
    expect(card?.classList).toContain('fla-job');
    expect(card?.getAttribute('aria-labelledby')).toBe(heading.id);
    const bar = screen.getByRole('progressbar', { name: /summer in the rockies/i });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    // Prototype `statusText`: the state, the percentage and about how long is left at the rate so far.
    expect(card?.querySelector(':scope .fla-status')?.textContent?.trim()).toMatch(/^Rendering · 42% · about .+ left$/);
    expect(card?.querySelector(':scope .fla-chip .fla-dot')).not.toBeNull();
    // The prototype's summary names only what is not zero.
    expect(container.querySelector('.fla-summary')?.textContent).toBe('1 running');
    expect(screen.getByRole('button', { name: /^running/i }).getAttribute('aria-pressed')).toBe('false');
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

  it('shows a finished result by thumbnail and clears it with a labelled icon button', async () => {
    await mount([
      operation({
        status: MediaOperationStatus.Completed,
        progress: 100,
        resultAssetId: '0195e2a0-0000-7000-8000-0000000000bb',
        finishedAt: '2026-09-22T10:10:00.000Z',
      }),
    ]);

    const heading = await screen.findByRole('heading', { name: 'Summer in the Rockies' });
    const card = heading.closest('article')!;
    // The SDK is mocked here, so only the presence of the result's picture is asserted.
    expect(card.querySelector(':scope .fla-thumb img')).not.toBeNull();
    expect(screen.getByRole('button', { name: /open result/i })).toBeInTheDocument();
    const clear = screen.getByRole('button', { name: /summer in the rockies/i });
    expect(clear.textContent?.trim()).toBe('');
  });

  it('says nothing is processing when there are no tasks', async () => {
    await mount([]);

    // The prototype's words (Activity.jsx).
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Nothing processing' })).toBeInTheDocument());
    expect(screen.getByText('Nothing running')).toBeInTheDocument();
    const filters = screen.getByRole('group', { name: 'Filter jobs' });
    expect(filters.querySelectorAll('button')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Failed' })).toBeInTheDocument();
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
});
