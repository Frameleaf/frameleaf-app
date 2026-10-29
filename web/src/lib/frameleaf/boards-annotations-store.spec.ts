import { AssetAnnotationKind, type AssetAnnotationItem } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import {
  acquireAnnotations,
  releaseAnnotations,
  resetAnnotationsRegistry,
} from '$lib/frameleaf/boards-annotations-store.svelte';

const item = (id: string): AssetAnnotationItem => ({
  id,
  kind: AssetAnnotationKind.Text,
  geometry: { x: 0.1, y: 0.1 },
  text: id,
});
const deferred = <T = never>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const conflict = () => Object.assign(new Error('conflict'), { status: 409 });
const document = (sourceRevision: string, ids: string[]) =>
  ({
    version: 1,
    sourceRevision,
    sourceChanged: false,
    canEdit: true,
    items: ids.map((id) => item(id)),
    updatedAt: null,
  }) as never;
const read = (sourceRevision = 'rev-1', ids = ['a']) =>
  sdkMock.getAssetAnnotations.mockResolvedValue(document(sourceRevision, ids));
const saves = () => sdkMock.replaceAssetAnnotations.mock.calls.map(([call]) => call.assetAnnotationsUpdateDto);
const ids = (items: AssetAnnotationItem[]) => items.map(({ id }) => id);

const open = async (assetId: string) => {
  const state = acquireAnnotations(assetId);
  await state.load();
  return state;
};

describe('Boards annotations save state', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetAnnotationsRegistry();
    read();
    sdkMock.replaceAssetAnnotations.mockImplementation(({ assetAnnotationsUpdateDto }) =>
      Promise.resolve({ sourceRevision: assetAnnotationsUpdateDto.sourceRevision } as never),
    );
  });

  it('is one state per picture, shared by every view of it', async () => {
    const panel = await open('asset-1');
    const viewer = acquireAnnotations('asset-1');
    expect(viewer).toBe(panel);
    expect(acquireAnnotations('asset-2')).not.toBe(panel);
  });

  it('sends one save at a time, each with the latest change when it starts', async () => {
    const state = await open('asset-1');
    const first = deferred();
    sdkMock.replaceAssetAnnotations.mockReturnValueOnce(first.promise);
    state.change([item('a'), item('b')]);
    const a = state.flush();
    await vi.waitFor(() => expect(saves()).toHaveLength(1));
    state.change([item('a'), item('b'), item('c')]);
    const b = state.flush();
    await Promise.resolve();
    expect(saves()).toHaveLength(1);
    first.resolve({ sourceRevision: 'rev-1' } as never);
    await Promise.all([a, b]);
    expect(saves().map(({ items }) => ids(items))).toEqual([
      ['a', 'b'],
      ['a', 'b', 'c'],
    ]);
  });

  it('never sends an older list again after a newer change saved', async () => {
    const state = await open('asset-1');
    const first = deferred();
    sdkMock.replaceAssetAnnotations.mockReturnValueOnce(first.promise);
    state.change([item('a'), item('b')]);
    const a = state.flush();
    await vi.waitFor(() => expect(saves()).toHaveLength(1));
    state.change([item('b')]);
    const b = state.flush();
    first.reject(new Error('offline'));
    await Promise.all([a, b]);
    expect(ids(saves()[1].items)).toEqual(['b']);
    expect(state.saveFailed).toBe(false);
    await state.flush();
    expect(saves()).toHaveLength(2);
  });

  it('keeps a failed change for Retry', async () => {
    const state = await open('asset-1');
    sdkMock.replaceAssetAnnotations.mockRejectedValueOnce(new Error('offline'));
    state.change([item('a'), item('b')]);
    await state.flush();
    expect(state.saveFailed).toBe(true);
    state.retry();
    await state.flush();
    expect(ids(saves()[1].items)).toEqual(['a', 'b']);
    expect(state.saveFailed).toBe(false);
  });

  it('keeps an unsaved change when the panel moves to another picture, and shows it again with Retry', async () => {
    const a = await open('asset-a');
    sdkMock.replaceAssetAnnotations.mockRejectedValueOnce(new Error('offline'));
    a.change([item('a'), item('edit')]);
    await releaseAnnotations(a);

    // another picture: its own state, nothing of A's on it
    read('rev-b', ['b']);
    const b = await open('asset-b');
    expect(ids(b.items)).toEqual(['b']);
    expect(b.saveFailed).toBe(false);
    await releaseAnnotations(b);

    // back to A: the server still has the old document, but the unsaved change is shown, with Retry
    read('rev-1', ['a']);
    const again = await open('asset-a');
    expect(again).toBe(a);
    expect(again.saveFailed).toBe(true);
    expect(ids(again.items)).toEqual(['a', 'edit']);
    again.retry();
    await again.flush();
    expect(saves().at(-1)).toMatchObject({ sourceRevision: 'rev-1' });
    expect(ids(saves().at(-1)!.items)).toEqual(['a', 'edit']);
    expect(again.saveFailed).toBe(false);
    // only ever sent for A
    expect(sdkMock.replaceAssetAnnotations.mock.calls.every(([call]) => call.id === 'asset-a')).toBe(true);
  });

  it('leaves the registry once saved and no longer shown', async () => {
    const state = await open('asset-1');
    state.change([item('b')]);
    await releaseAnnotations(state);
    expect(acquireAnnotations('asset-1')).not.toBe(state);
  });

  it('reads a reopened picture only after the save from closing it has landed', async () => {
    const state = await open('asset-1');
    const saving = deferred();
    sdkMock.replaceAssetAnnotations.mockReturnValueOnce(saving.promise);
    state.change([item('a'), item('b')]);
    const closed = releaseAnnotations(state);
    const reopened = acquireAnnotations('asset-1');
    const loading = reopened.load();
    await vi.waitFor(() => expect(saves()).toHaveLength(1));
    expect(sdkMock.getAssetAnnotations).toHaveBeenCalledTimes(1);
    read('rev-1', ['a', 'b']);
    saving.resolve({ sourceRevision: 'rev-1' } as never);
    await Promise.all([closed, loading]);
    expect(sdkMock.getAssetAnnotations).toHaveBeenCalledTimes(2);
    expect(ids(reopened.items)).toEqual(['a', 'b']);
  });

  it('reads again and says so when the picture changed, instead of retrying stale positions', async () => {
    const state = await open('asset-1');
    const generation = state.generation;
    sdkMock.replaceAssetAnnotations.mockRejectedValueOnce(conflict());
    read('rev-2', ['a', 'c']);
    state.change([item('a'), item('b')]);
    await state.flush();
    expect(state).toMatchObject({ reloaded: true, saveFailed: false });
    expect(ids(state.items)).toEqual(['a', 'c']);
    expect(state.generation).toBe(generation + 1);
    await state.flush();
    expect(saves()).toHaveLength(1);
    state.change([item('c')]);
    expect(state.reloaded).toBe(false);
    await state.flush();
    expect(saves().at(-1)?.sourceRevision).toBe('rev-2');
  });

  it('never sends an edit made while the reload after a 409 is on its way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const state = await open('asset-1');
      sdkMock.replaceAssetAnnotations.mockRejectedValueOnce(conflict());
      const reload = deferred();
      sdkMock.getAssetAnnotations.mockReturnValueOnce(reload.promise);
      state.change([item('a'), item('b')]);
      const saving = state.flush();
      await vi.waitFor(() => expect(sdkMock.getAssetAnnotations).toHaveBeenCalledTimes(2));

      // the person keeps editing the old positions while the reload is in flight
      state.change([item('a'), item('b'), item('stale')]);
      reload.resolve(document('rev-2', ['a']));
      await saving;
      await vi.advanceTimersByTimeAsync(2000);
      await state.flush();

      expect(saves()).toHaveLength(1);
      expect(ids(state.items)).toEqual(['a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a registered unsaved change once the picture has changed, and says so', async () => {
    const state = await open('asset-1');
    sdkMock.replaceAssetAnnotations.mockRejectedValueOnce(new Error('offline'));
    state.change([item('a'), item('edit')]);
    await releaseAnnotations(state);
    read('rev-2', ['a']);
    const again = await open('asset-1');
    expect(again).toMatchObject({ saveFailed: false, reloaded: true });
    expect(ids(again.items)).toEqual(['a']);
    await again.flush();
    expect(saves()).toHaveLength(1);
  });

  it('carries the revision a save returns to the change made on top of it', async () => {
    // deleting stale annotations returns the picture's current revision
    read('rev-1', ['a']);
    const state = await open('asset-1');
    const deleting = deferred();
    sdkMock.replaceAssetAnnotations.mockReturnValueOnce(deleting.promise);
    state.change([]);
    const first = state.flush();
    await vi.waitFor(() => expect(saves()).toHaveLength(1));
    state.change([item('new')]);
    deleting.resolve({ sourceRevision: 'rev-2' } as never);
    await first;
    await state.flush();
    expect(saves().map(({ sourceRevision }) => sourceRevision)).toEqual(['rev-1', 'rev-2']);
  });
});
