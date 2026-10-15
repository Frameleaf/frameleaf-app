import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { assetViewerManager as manager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';

beforeEach(() => {
  vi.resetAllMocks();
  manager.showAssetViewer(false);
  authManager.reset();
});

it('keeps the latest requested asset when responses arrive in reverse order', async () => {
  const old = assetFactory.build();
  const current = assetFactory.build();
  const deferred = deferredPromise<typeof old>();
  sdkMock.getAssetInfo.mockReturnValueOnce(deferred.promise).mockResolvedValueOnce(current);
  const loading = manager.setAssetId(old.id);
  await manager.setAssetId(current.id);
  deferred.resolve(old);
  await loading;
  expect(manager.asset?.id).toBe(current.id);
});

it.each(['close', 'replace', 'session'] as const)('discards a pending viewer load after %s', async (change) => {
  const old = assetFactory.build();
  const replacement = assetFactory.build();
  manager.setAsset(replacement);
  const deferred = deferredPromise<typeof old>();
  sdkMock.getAssetInfo.mockReturnValueOnce(deferred.promise);
  const loading = manager.setAssetId(old.id);
  if (change === 'close') {
    manager.showAssetViewer(false);
  } else if (change === 'replace') {
    manager.setAsset(replacement);
  } else {
    authManager.reset();
  }
  deferred.resolve(old);
  await loading;
  expect(manager.asset?.id).toBe(replacement.id);
  expect(manager.isViewing).toBe(change !== 'close');
});
