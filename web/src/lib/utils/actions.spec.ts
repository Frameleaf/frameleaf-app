import { toastManager } from '@frameleaf/ui';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { handleError } from '$lib/utils/handle-error';
import { toTimelineAsset } from '$lib/utils/timeline-util';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import { deleteAssets } from './actions';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it('awaits an asynchronous undo callback and owns its rejection', async () => {
  sdkMock.deleteAssets.mockResolvedValue(undefined as never);
  sdkMock.restoreAssets.mockResolvedValue({ count: 1 });
  const toast = vi.spyOn(toastManager, 'primary').mockImplementation(() => {});
  const restored = deferredPromise<void>();
  const callback = vi.fn(() => restored.promise);
  const asset = toTimelineAsset(assetFactory.build());
  await deleteAssets(false, vi.fn(), [asset], callback);
  const content = toast.mock.calls[0][0] as { button: { onclick: () => Promise<void> } };
  const undo = content.button.onclick();
  await vi.waitFor(() => expect(callback).toHaveBeenCalledWith([asset]));
  const error = new Error('viewer lookup failed');
  restored.reject(error);
  await undo;
  expect(handleError).toHaveBeenCalledWith(error, expect.any(String));
  expect(sdkMock.restoreAssets).toHaveBeenCalledWith({ bulkIdsDto: { ids: [asset.id] } });
});
