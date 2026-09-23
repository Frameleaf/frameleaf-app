import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ActivityView from '$lib/components/frameleaf/ActivityView.svelte';
import { activitySession } from '$lib/frameleaf/activity-session.svelte';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus, type MediaOperationDto } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const operation = (overrides: Partial<MediaOperationDto> = {}): MediaOperationDto =>
  ({
    id: '0195e2a0-0000-7000-8000-000000000001',
    kind: MediaOperationKind.StudioExport,
    status: MediaOperationStatus.Rendering,
    destination: MediaOperationDestination.RunPod,
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
    error: null,
    errorCode: null,
    cancelRequestedAt: null,
    cancelAcknowledgedAt: null,
    startedAt: '2026-09-22T09:50:00.000Z',
    finishedAt: null,
    createdAt: '2026-09-22T09:49:00.000Z',
    updatedAt: '2026-09-22T09:59:00.000Z',
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

    await vi.waitFor(() => expect(screen.getByText(/RunPod/)).toBeInTheDocument());
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

    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    expect(screen.getByText('The worker stopped responding')).toBeInTheDocument();

    await fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(sdkMock.retryMediaOperation).toHaveBeenCalledWith({ id: '0195e2a0-0000-7000-8000-000000000001' });
  });

  it('keeps the last known list when the server cannot be reached', async () => {
    activitySession.operations = [operation()];
    activitySession.unreachable = true;
    render(ActivityView, { props: { filter: 'all' } });

    expect(screen.getByRole('heading', { name: 'Summer in the Rockies' })).toBeInTheDocument();
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
  });

  it('says nothing is processing when there are no tasks', async () => {
    await mount([]);

    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Nothing is processing' })).toBeInTheDocument());
  });
});
