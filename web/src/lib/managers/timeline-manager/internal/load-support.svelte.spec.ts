import { TimelineOrderedSort } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import type { TimelineMonth } from '../timeline-month.svelte';
import { clearOrderedPageCursors, loadOrderedPage } from './load-support.svelte';

const month = () => ({ getFirstAsset: vi.fn(), addOrderedAssets: vi.fn() }) as unknown as TimelineMonth;
const response = (startCursor: string, endCursor: string) => ({ id: ['asset'], startCursor, endCursor }) as never;

describe('ordered page cursors', () => {
  beforeEach(() => vi.clearAllMocks());

  it('seeks forward and backward from adjacent pages and falls back to offsets for random access', async () => {
    const months = Array.from({ length: 5 }, month);
    const options = { orderedBy: TimelineOrderedSort.Filename };
    const signal = new AbortController().signal;
    sdkMock.getTimelineOrdered.mockResolvedValueOnce(response('a', 'b'));
    await loadOrderedPage(months[0], months, options, signal);
    expect(sdkMock.getTimelineOrdered).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 0 }), { signal });
    sdkMock.getTimelineOrdered.mockResolvedValueOnce(response('c', 'd'));
    await loadOrderedPage(months[1], months, options, signal);
    expect(sdkMock.getTimelineOrdered).toHaveBeenLastCalledWith(expect.objectContaining({ after: 'b' }), { signal });
    expect(sdkMock.getTimelineOrdered.mock.calls.at(-1)![0]).not.toHaveProperty('skip');
    sdkMock.getTimelineOrdered.mockResolvedValueOnce(response('g', 'h'));
    await loadOrderedPage(months[4], months, options, signal);
    expect(sdkMock.getTimelineOrdered).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 2000 }), { signal });
    sdkMock.getTimelineOrdered.mockResolvedValueOnce(response('e', 'f'));
    await loadOrderedPage(months[3], months, options, signal);
    expect(sdkMock.getTimelineOrdered).toHaveBeenLastCalledWith(expect.objectContaining({ before: 'g' }), { signal });
    clearOrderedPageCursors(months);
    await loadOrderedPage(months[2], months, options, signal);
    expect(sdkMock.getTimelineOrdered).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 1000 }), { signal });
  });

  it('discards cursors on refresh and never caches a cancelled request', async () => {
    const months = [month(), month()];
    const options = { orderedBy: TimelineOrderedSort.Rating };
    const controller = new AbortController();
    sdkMock.getTimelineOrdered.mockImplementationOnce(async () => {
      controller.abort();
      return response('a', 'b');
    });
    await loadOrderedPage(months[0], months, options, controller.signal);
    expect(months[0].addOrderedAssets).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    await loadOrderedPage(months[1], months, options, signal);
    expect(sdkMock.getTimelineOrdered).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 500 }), { signal });
    sdkMock.getTimelineOrdered.mockResolvedValueOnce(response('a', 'b'));
    await loadOrderedPage(months[0], months, options, signal);
    const refreshed = [month(), month()];
    await loadOrderedPage(
      refreshed[1],
      refreshed,
      { orderedBy: TimelineOrderedSort.Filename, isFavorite: true },
      signal,
    );
    expect(sdkMock.getTimelineOrdered).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 500, sort: 'filename', isFavorite: true }),
      { signal },
    );
  });
});
