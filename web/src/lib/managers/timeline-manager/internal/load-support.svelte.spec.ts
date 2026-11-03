import { TimelineOrderedSort } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import type { TimelineMonth } from '../timeline-month.svelte';
import { clearOrderedPageCursors, loadOrderedPage } from './load-support.svelte';

const month = () =>
  ({
    getFirstAsset: vi.fn(),
    addOrderedAssets: vi.fn(),
    timelineManager: { projectionGeneration: 0, months: [] },
  }) as unknown as TimelineMonth;
const bind = (months: TimelineMonth[]) => {
  for (const item of months) {
    Object.assign(item.timelineManager, { months });
  }
  return months;
};
const response = (startCursor: string, endCursor: string) => ({ id: ['asset'], startCursor, endCursor }) as never;

describe('ordered page cursors', () => {
  beforeEach(() => vi.clearAllMocks());

  it('seeks forward and backward from adjacent pages and falls back to offsets for random access', async () => {
    const months = bind(Array.from({ length: 5 }, month));
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
    const months = bind([month(), month()]);
    const options = { orderedBy: TimelineOrderedSort.Rating };
    const controller = new AbortController();
    sdkMock.getTimelineOrdered.mockImplementationOnce(async () => {
      controller.abort();
      return response('a', 'b');
    });
    await expect(loadOrderedPage(months[0], months, options, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(months[0].addOrderedAssets).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    await loadOrderedPage(months[1], months, options, signal);
    expect(sdkMock.getTimelineOrdered).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 500 }), { signal });
    sdkMock.getTimelineOrdered.mockResolvedValueOnce(response('a', 'b'));
    await loadOrderedPage(months[0], months, options, signal);
    const refreshed = bind([month(), month()]);
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

  it('asks again after a live change, and gives way (cancelled, not loaded) once the page is gone', async () => {
    const months = bind([month()]);
    const manager = months[0].timelineManager as unknown as { projectionGeneration: number; months: TimelineMonth[] };
    const options = { orderedBy: TimelineOrderedSort.Filename };
    const signal = new AbortController().signal;
    sdkMock.getTimelineOrdered
      .mockImplementationOnce(async () => {
        manager.projectionGeneration++;
        return response('stale', 'stale');
      })
      .mockResolvedValueOnce(response('a', 'b'));
    await loadOrderedPage(months[0], months, options, signal);
    expect(sdkMock.getTimelineOrdered).toHaveBeenCalledTimes(2);
    expect(months[0].addOrderedAssets).toHaveBeenCalledTimes(1);
    expect(months[0].addOrderedAssets).toHaveBeenCalledWith(response('a', 'b'));

    // A live change that also cleared the page boundaries: the retry seeks by offset, not the old cursor.
    const paged = bind([month(), month()]);
    const pagedManager = paged[1].timelineManager as unknown as { projectionGeneration: number };
    sdkMock.getTimelineOrdered.mockResolvedValueOnce(response('a', 'b'));
    await loadOrderedPage(paged[0], paged, options, signal);
    sdkMock.getTimelineOrdered
      .mockImplementationOnce(async () => {
        pagedManager.projectionGeneration++;
        clearOrderedPageCursors(paged);
        return response('stale', 'stale');
      })
      .mockResolvedValueOnce(response('c', 'd'));
    await loadOrderedPage(paged[1], paged, options, signal);
    expect(sdkMock.getTimelineOrdered.mock.calls.at(-2)![0]).toMatchObject({ after: 'b' });
    expect(sdkMock.getTimelineOrdered).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 500 }), { signal });

    const replaced = bind([month()]);
    sdkMock.getTimelineOrdered.mockImplementationOnce(async () => {
      Object.assign(replaced[0].timelineManager, { months: [] });
      return response('c', 'd');
    });
    await expect(loadOrderedPage(replaced[0], replaced, options, signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(replaced[0].addOrderedAssets).not.toHaveBeenCalled();
  });
});
