import { sdkMock } from '$lib/__mocks__/sdk.mock';
import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import { RESTORE_FETCH_LIMIT, WebsocketSupport } from './websocket-support.svelte';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());

vi.mock('$lib/stores/websocket', () => ({
  websocketEvents: {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  },
}));

const makeManager = () => ({
  upsertAssetsFromLiveEvent: vi.fn(),
  removeAssets: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  invalidateLiveProjection: vi.fn(),
});

const connect = (manager: ReturnType<typeof makeManager>) => {
  const support = new WebsocketSupport(manager as unknown as TimelineManager);
  support.connectWebsocketEvents();
  return support;
};

describe('WebsocketSupport restores (FL-47)', () => {
  beforeEach(() => {
    handlers.clear();
    sdkMock.getAssetInfo.mockReset();
  });

  it('puts items restored elsewhere back into the timeline', async () => {
    const manager = makeManager();
    const support = connect(manager);
    const restored = assetFactory.build({ isTrashed: false });
    sdkMock.getAssetInfo.mockResolvedValue(restored);

    handlers.get('on_asset_restore')!([restored.id]);

    await vi.waitFor(() => expect(manager.upsertAssetsFromLiveEvent).toHaveBeenCalledTimes(1));
    expect(manager.upsertAssetsFromLiveEvent.mock.calls[0][0].map(({ id }: { id: string }) => id)).toEqual([
      restored.id,
    ]);
    support.disconnectWebsocketEvents();
    expect(handlers.has('on_asset_restore')).toBe(false);
  });

  it('skips items this session cannot read or that went back to the trash', async () => {
    const manager = makeManager();
    connect(manager);
    const trashedAgain = assetFactory.build({ isTrashed: true });
    sdkMock.getAssetInfo.mockImplementation(({ id }) =>
      id === trashedAgain.id ? Promise.resolve(trashedAgain) : Promise.reject(new Error('Locked')),
    );

    handlers.get('on_asset_restore')!([trashedAgain.id, 'locked-item']);

    await vi.waitFor(() => expect(sdkMock.getAssetInfo).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(manager.upsertAssetsFromLiveEvent).not.toHaveBeenCalled();
  });

  it('reloads the timeline for a large restore instead of reading each item', async () => {
    const manager = makeManager();
    connect(manager);

    handlers.get('on_asset_restore')!(Array.from({ length: RESTORE_FETCH_LIMIT + 1 }, (_, index) => `id-${index}`));

    await vi.waitFor(() => expect(manager.refresh).toHaveBeenCalledTimes(1));
    expect(sdkMock.getAssetInfo).not.toHaveBeenCalled();
  });

  it('C2 RED: reconciles a complete local sequence and rejects an older asynchronous response', async () => {
    vi.useFakeTimers();
    const manager = makeManager();
    const support = connect(manager);
    const asset = assetFactory.build({ isTrashed: false });
    const old = deferred<typeof asset>();
    sdkMock.getAssetInfo.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ...asset, isTrashed: true });
    const bundle = (sequence: string) => ({
      streamEpoch: 'actual-stream',
      sequence,
      effectId: `effect-${sequence}`,
      assetIds: [asset.id],
      revokedOperationIds: [],
    });
    try {
      expect(handlers.has('AssetLocalEffectsV1')).toBe(true);
      handlers.get('AssetLocalEffectsV1')!(bundle('1'));
      handlers.get('AssetLocalEffectsV1')!(bundle('2'));
      await vi.advanceTimersByTimeAsync(2500);
      old.resolve(asset);
      await vi.advanceTimersByTimeAsync(2500);
      handlers.get('AssetLocalEffectsV1')!(bundle('1'));
      await vi.advanceTimersByTimeAsync(2500);
      expect(sdkMock.getAssetInfo).toHaveBeenCalledTimes(2);
      expect(manager.upsertAssetsFromLiveEvent).not.toHaveBeenCalled();
      expect(manager.removeAssets).toHaveBeenCalledWith([asset.id]);
    } finally {
      support.disconnectWebsocketEvents();
      vi.useRealTimers();
    }
  });

  it('C2 RED: does not apply an older restore response after a newer Trash', async () => {
    vi.useFakeTimers();
    const manager = makeManager();
    const support = connect(manager);
    const restored = assetFactory.build({ isTrashed: false });
    const response = deferred<typeof restored>();
    sdkMock.getAssetInfo.mockReturnValue(response.promise);
    try {
      handlers.get('on_asset_restore')!([restored.id]);
      expect(sdkMock.getAssetInfo).toHaveBeenCalledTimes(1);
      handlers.get('on_asset_trash')!([restored.id]);
      expect(manager.removeAssets).toHaveBeenCalledWith([restored.id]);

      response.resolve(restored);
      await vi.advanceTimersByTimeAsync(2500);

      expect(manager.upsertAssetsFromLiveEvent).not.toHaveBeenCalled();
    } finally {
      support.disconnectWebsocketEvents();
      vi.useRealTimers();
    }
  });

  it('C2 RED: a newer restore wins over an older Trash pending in the same batch', async () => {
    vi.useFakeTimers();
    const manager = makeManager();
    const visible = new Set<string>();
    manager.upsertAssetsFromLiveEvent.mockImplementation((assets: { id: string }[]) => {
      for (const asset of assets) {
        visible.add(asset.id);
      }
    });
    manager.removeAssets.mockImplementation((ids: string[]) => {
      for (const id of ids) {
        visible.delete(id);
      }
    });
    const support = connect(manager);
    const restored = assetFactory.build({ isTrashed: false });
    sdkMock.getAssetInfo.mockResolvedValue(restored);
    try {
      // Start the throttle window so both changes reach the actual pending-batch apply.
      handlers.get('on_asset_trash')!(['unrelated']);
      handlers.get('on_asset_trash')!([restored.id]);
      handlers.get('on_asset_restore')!([restored.id]);

      await vi.advanceTimersByTimeAsync(2500);

      expect(manager.upsertAssetsFromLiveEvent).toHaveBeenCalledTimes(1);
      expect(visible.has(restored.id)).toBe(true);
    } finally {
      support.disconnectWebsocketEvents();
      vi.useRealTimers();
    }
  });
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
};
