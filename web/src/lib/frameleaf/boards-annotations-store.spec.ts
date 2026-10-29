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
});
