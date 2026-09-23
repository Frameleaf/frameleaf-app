import { MediaOperationItemStatus, MediaOperationStatus, type MediaOperationDetailDto } from '@immich/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableBulkTracker } from '$lib/frameleaf/durable-bulk-tracker.svelte';

const detail = (overrides: Partial<MediaOperationDetailDto> = {}): MediaOperationDetailDto =>
  ({
    id: 'job-1',
    status: MediaOperationStatus.Rendering,
    processedUnits: '0',
    bulkItems: [],
    bulkRetryPending: [],
    bulk: { retried: 0, itemsTruncated: false },
    ...overrides,
  }) as MediaOperationDetailDto;

describe('the durable bulk tracker', () => {
  let tracker: DurableBulkTracker;
  let fetch: ReturnType<typeof vi.fn<(operationId: string) => Promise<MediaOperationDetailDto>>>;
  let removed: string[][];

  beforeEach(() => {
    vi.useFakeTimers();
    fetch = vi.fn<(operationId: string) => Promise<MediaOperationDetailDto>>();
    tracker = new DurableBulkTracker({ fetch, pollMs: 1000 });
    removed = [];
    tracker.onRemoved((ids) => void removed.push(ids));
  });

  afterEach(() => {
    tracker.reset();
    vi.useRealTimers();
  });

  it('puts a loader on every item the job covers as soon as it is followed', () => {
    tracker.track('delete', 'job-1', ['a', 'b', 'c']);

    expect(tracker.stateOf('a')).toEqual({ state: 'pending' });
    expect(tracker.stateOf('c')).toEqual({ state: 'pending' });
    expect(tracker.stateOf('z')).toBeUndefined();
  });

  it('takes finished items out of the view as the job reaches them, not all at once', () => {
    tracker.track('delete', 'job-1', ['a', 'b', 'c']);

    tracker.apply('job-1', detail({ processedUnits: '2' }));

    expect(removed).toEqual([['a', 'b']]);
    expect(tracker.stateOf('a')).toBeUndefined();
    expect(tracker.stateOf('c')).toEqual({ state: 'pending' });

    tracker.apply('job-1', detail({ status: MediaOperationStatus.Completed, processedUnits: '3' }));

    // An item is removed once, never again on a later answer.
    expect(removed).toEqual([['a', 'b'], ['c']]);
    expect(tracker.tracking).toBe(0);
  });

  it('only drops the loader for an action that leaves the item in the view', () => {
    tracker.track('favorite', 'job-1', ['a']);

    tracker.apply('job-1', detail({ status: MediaOperationStatus.Completed, processedUnits: '1' }));

    expect(removed).toEqual([]);
    expect(tracker.stateOf('a')).toBeUndefined();
  });

  it('shows a failure mark once an item has failed its automatic retry', () => {
    tracker.track('delete', 'job-1', ['a', 'b']);
    const refusal = {
      id: 'b',
      status: MediaOperationItemStatus.Failed,
      reasonKey: 'frameleaf_bulk_reason_failed',
      message: 'connection reset',
    };

    // Before the retry pass is planned, a failure is still going to be tried again.
    tracker.apply('job-1', detail({ processedUnits: '2', bulkItems: [refusal] }));
    expect(tracker.stateOf('b')).toEqual({ state: 'pending' });

    tracker.apply(
      'job-1',
      detail({
        status: MediaOperationStatus.Completed,
        processedUnits: '2',
        bulkItems: [refusal],
        bulk: { retried: 1 } as never,
      }),
    );
    expect(tracker.stateOf('b')).toEqual({ state: 'failed', reasonKey: 'frameleaf_bulk_reason_failed' });
    expect(removed).toEqual([['a']]);
  });

  it('keeps the loader on items waiting for their automatic retry', () => {
    tracker.track('delete', 'job-1', ['a', 'b']);

    tracker.apply(
      'job-1',
      detail({
        status: MediaOperationStatus.Queued,
        processedUnits: '2',
        bulkRetryPending: ['b'],
        bulk: { retried: 1 } as never,
      }),
    );

    expect(tracker.stateOf('b')).toEqual({ state: 'pending' });
    expect(removed).toEqual([['a']]);
  });

  it('clears the loader without a failure mark for items a cancelled job never reached', () => {
    tracker.track('delete', 'job-1', ['a', 'b']);

    tracker.apply('job-1', detail({ status: MediaOperationStatus.Cancelled, processedUnits: '1' }));

    expect(removed).toEqual([['a']]);
    expect(tracker.stateOf('b')).toBeUndefined();
  });

  it('polls the job while it runs and stops once it has finished', async () => {
    fetch.mockResolvedValueOnce(detail({ processedUnits: '1' }));
    fetch.mockResolvedValueOnce(detail({ status: MediaOperationStatus.Completed, processedUnits: '2' }));
    tracker.track('delete', 'job-1', ['a', 'b']);

    await vi.advanceTimersByTimeAsync(1000);
    expect(removed).toEqual([['a']]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(removed).toEqual([['a'], ['b']]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith('job-1');
  });

  it('keeps the loaders through a lost connection and asks again', async () => {
    fetch.mockRejectedValueOnce(new Error('offline'));
    fetch.mockResolvedValueOnce(detail({ status: MediaOperationStatus.Completed, processedUnits: '1' }));
    tracker.track('delete', 'job-1', ['a']);

    await vi.advanceTimersByTimeAsync(1000);
    expect(tracker.stateOf('a')).toEqual({ state: 'pending' });

    await vi.advanceTimersByTimeAsync(1000);
    expect(removed).toEqual([['a']]);
  });
});
