import { AssetAnnotationKind, type AssetAnnotationItem } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { BoardsAnnotationsState } from '$lib/frameleaf/boards-annotations-store.svelte';

const item = (id: string): AssetAnnotationItem => ({
  id,
  kind: AssetAnnotationKind.Text,
  geometry: { x: 0.1, y: 0.1 },
  text: id,
});
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((yes, no) => {
    resolve = () => yes(undefined as never);
    reject = no;
  });
  return { promise, resolve, reject };
};
const sentIds = (call: number) =>
  sdkMock.replaceAssetAnnotations.mock.calls[call][0].assetAnnotationsUpdateDto.items.map(({ id }) => id);

describe('BoardsAnnotationsState saving', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const read = (sourceRevision = 'rev-1', ids = ['a']) =>
    sdkMock.getAssetAnnotations.mockResolvedValue({
      version: 1,
      sourceRevision,
      sourceChanged: false,
      canEdit: true,
      items: ids.map((id) => item(id)),
      updatedAt: null,
    } as never);
  const ready = () => {
    const state = new BoardsAnnotationsState('asset-1');
    state.canEdit = true;
    return state;
  };

  it('sends one save at a time, the newest change last', async () => {
    const first = deferred();
    sdkMock.replaceAssetAnnotations.mockReturnValueOnce(first.promise).mockResolvedValue({} as never);
    const state = ready();
    state.change([item('a')]);
    const a = state.flush();
    // the first save is on its way before the next change
    await vi.waitFor(() => expect(sdkMock.replaceAssetAnnotations).toHaveBeenCalledTimes(1));
    state.change([item('a'), item('b')]);
    const b = state.flush();
    await Promise.resolve();
    // the newer save waits for the older one
    expect(sdkMock.replaceAssetAnnotations).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.all([a, b]);
    expect(sdkMock.replaceAssetAnnotations).toHaveBeenCalledTimes(2);
    expect(sentIds(1)).toEqual(['a', 'b']);
  });

  it('never brings an older list back through Retry when it fails after a newer change', async () => {
    const first = deferred();
    sdkMock.replaceAssetAnnotations.mockReturnValueOnce(first.promise).mockResolvedValue({} as never);
    const state = ready();
    state.change([item('a')]);
    const a = state.flush();
    // the first save is on its way before the next change
    await vi.waitFor(() => expect(sdkMock.replaceAssetAnnotations).toHaveBeenCalledTimes(1));
    state.change([item('a'), item('b')]);
    const b = state.flush();
    first.reject(new Error('offline'));
    await Promise.all([a, b]);
    // the newer list was saved after the failure, so nothing old is waiting
    expect(sentIds(1)).toEqual(['a', 'b']);
    expect(state.saveFailed).toBe(false);
    await state.flush();
    expect(sdkMock.replaceAssetAnnotations).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed change for Retry', async () => {
    sdkMock.replaceAssetAnnotations.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({} as never);
    const state = ready();
    state.change([item('a')]);
    await state.flush();
    expect(state.saveFailed).toBe(true);
    state.retry();
    await state.flush();
    expect(sentIds(1)).toEqual(['a']);
    expect(state.saveFailed).toBe(false);
  });

  it('sends the revision it read and keeps the one each save returns', async () => {
    read('rev-1');
    sdkMock.replaceAssetAnnotations
      .mockResolvedValueOnce({ sourceRevision: 'rev-1' } as never)
      .mockResolvedValueOnce({ sourceRevision: 'rev-1' } as never);
    const state = new BoardsAnnotationsState('asset-rev');
    await state.load();
    state.change([item('a'), item('b')]);
    await state.flush();
    state.change([item('b')]);
    await state.flush();
    for (const call of sdkMock.replaceAssetAnnotations.mock.calls) {
      expect(call[0].assetAnnotationsUpdateDto.sourceRevision).toBe('rev-1');
    }
  });

  it('reads again and says so when the picture changed, instead of retrying stale positions', async () => {
    read('rev-1', ['a']);
    const state = new BoardsAnnotationsState('asset-conflict');
    await state.load();
    const generation = state.generation;
    sdkMock.replaceAssetAnnotations.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
    read('rev-2', ['a', 'c']);
    state.change([item('a'), item('b')]);
    await state.flush();
    expect(state.reloaded).toBe(true);
    expect(state.saveFailed).toBe(false);
    expect(state.items.map(({ id }) => id)).toEqual(['a', 'c']);
    expect(state.generation).toBe(generation + 1);
    // nothing stale is left to send, and the next change uses the new revision
    await state.flush();
    expect(sdkMock.replaceAssetAnnotations).toHaveBeenCalledTimes(1);
    sdkMock.replaceAssetAnnotations.mockResolvedValue({ sourceRevision: 'rev-2' } as never);
    state.change([item('c')]);
    expect(state.reloaded).toBe(false);
    await state.flush();
    expect(sdkMock.replaceAssetAnnotations.mock.lastCall?.[0].assetAnnotationsUpdateDto.sourceRevision).toBe('rev-2');
  });

  it('reads a reopened picture only after the save from closing it has landed', async () => {
    read('rev-1');
    const saving = deferred();
    sdkMock.replaceAssetAnnotations.mockReturnValueOnce(saving.promise);
    const first = new BoardsAnnotationsState('asset-reopen');
    await first.load();
    first.change([item('a'), item('b')]);
    const closed = first.close();

    const second = new BoardsAnnotationsState('asset-reopen');
    const loading = second.load();
    await vi.waitFor(() => expect(sdkMock.replaceAssetAnnotations).toHaveBeenCalledTimes(1));
    expect(sdkMock.getAssetAnnotations).toHaveBeenCalledTimes(1);
    // closing again before the first close landed still waits for it
    const third = new BoardsAnnotationsState('asset-reopen');
    void second.close();
    const loadingThird = third.load();

    read('rev-1', ['a', 'b']);
    saving.resolve();
    await Promise.all([closed, loading, loadingThird]);
    expect(sdkMock.getAssetAnnotations).toHaveBeenCalledTimes(3);
    expect(third.items.map(({ id }) => id)).toEqual(['a', 'b']);
  });
});
