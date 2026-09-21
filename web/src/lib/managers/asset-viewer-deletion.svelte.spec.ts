import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
import { assetFactory } from '@test-data/factories/asset-factory';
import { assetViewerManager } from './asset-viewer-manager.svelte';
import { eventManager } from './event-manager.svelte';

const socket = vi.hoisted(() => ({ listeners: new Map<string, (id: string) => void>() }));
vi.mock('$lib/stores/websocket', () => ({
  websocketEvents: {
    on: (name: string, listener: (id: string) => void) => {
      socket.listeners.set(name, listener);
      return () => socket.listeners.delete(name);
    },
  },
}));
vi.mock('@immich/sdk', async (original) => ({ ...(await original<object>()), getAssetInfo: vi.fn() }));

it('keeps an unaffected open asset and clears only the deleted asset', () => {
  const asset = assetFactory.build();
  assetViewerManager.setAsset(asset);
  socket.listeners.get('on_asset_delete')!('unrelated');
  expect(assetViewerManager.asset?.id).toBe(asset.id);
  expect(assetViewerManager.isViewing).toBe(true);
  socket.listeners.get('on_asset_delete')!(asset.id);
  expect(assetViewerManager.asset).toBeUndefined();
  expect(assetViewerManager.isViewing).toBe(false);
});

it('rejects an ignored-abort response for a deleted pending asset without closing the current asset', async () => {
  const current = assetFactory.build();
  const deleted = assetFactory.build();
  assetViewerManager.setAsset(current);
  let responseResolve!: (value: AssetResponseDto | PromiseLike<AssetResponseDto>) => void;
  const response = {
    promise: new Promise<AssetResponseDto>((resolve) => {
      responseResolve = resolve;
    }),
    resolve: (value: AssetResponseDto) => responseResolve(value),
  };
  vi.mocked(getAssetInfo).mockReturnValueOnce(response.promise);
  const pending = assetViewerManager.setAssetId(deleted.id);
  socket.listeners.get('on_asset_delete')!(deleted.id);
  expect(vi.mocked(getAssetInfo).mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
  response.resolve(deleted);
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(assetViewerManager.asset?.id).toBe(current.id);
});

it('allows explicit Undo to load a trashed asset again after the deletion action', async () => {
  const asset = assetFactory.build();
  assetViewerManager.setAsset(asset);
  eventManager.emit('AssetsDelete', [asset.id]);
  expect(assetViewerManager.asset).toBeUndefined();
  vi.mocked(getAssetInfo).mockResolvedValueOnce(asset);
  await assetViewerManager.setAssetId(asset.id);
  expect(assetViewerManager.asset?.id).toBe(asset.id);
});
