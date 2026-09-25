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
});
