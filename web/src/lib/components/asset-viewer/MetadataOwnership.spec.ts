import { modalManager } from '@frameleaf/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import DetailPanelDate from './DetailPanelDate.svelte';
import DetailPanelDescription from './DetailPanelDescription.svelte';
import DetailPanelLocation from './DetailPanelLocation.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
const failure = { status: 503, data: { statusCode: 503, message: 'unavailable' } };
const owned = () =>
  assetFactory.build({ ownerId: 'owner', exifInfo: { description: '', latitude: 10, longitude: 20 } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  vi.resetAllMocks();
  authManager.setUser(userAdminFactory.build({ id: 'owner' }));
  authManager.setPreferences(preferencesFactory.build());
});
afterEach(() => vi.restoreAllMocks());

it.each(['current', 'replace', 'return', 'close', 'session'])(
  'keeps location dialog completion with its view: %s',
  async (change) => {
    const asset = owned();
    const pending = deferredPromise<typeof asset>();
    vi.spyOn(modalManager, 'show').mockReturnValueOnce(pending.promise);
    const onAssetRefresh = vi.fn();
    const view = render(DetailPanelLocation, { asset, isOwner: true, onAssetRefresh });
    await fireEvent.click(view.getByTitle('edit_location'));
    expect(modalManager.show).toHaveBeenCalled();
    if (change === 'replace' || change === 'return') await view.rerender({ asset: owned() });
    if (change === 'return') await view.rerender({ asset });
    if (change === 'close') view.unmount();
    if (change === 'session') authManager.reset();
    pending.resolve(asset);
    await settle();
    expect(onAssetRefresh).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
  },
);

it.each(['current', 'replace', 'return', 'close', 'session'])(
  'keeps description save failures with their view: %s',
  async (change) => {
    const asset = owned();
    const pending = deferredPromise<typeof asset>();
    sdkMock.updateAsset.mockReturnValueOnce(pending.promise);
    const view = render(DetailPanelDescription, { asset, isOwner: true });
    const input = view.getByTestId('autogrow-textarea');
    await fireEvent.input(input, { target: { value: 'A lake' } });
    await fireEvent.focusOut(input);
    expect(sdkMock.updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { description: 'A lake' } });
    if (change === 'replace' || change === 'return') await view.rerender({ asset: owned() });
    if (change === 'return') await view.rerender({ asset });
    if (change === 'close') view.unmount();
    if (change === 'session') authManager.reset();
    pending.reject(failure);
    await settle();
    expect(handleError).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
    expect(screen.queryByRole('alert') !== null).toBe(change === 'current');
  },
);

it.each(['current', 'replace', 'return', 'session'])(
  'keeps date dialog failure callbacks with their view: %s',
  async (change) => {
    const asset = owned();
    const pending = deferredPromise<boolean>();
    const dialog = vi.spyOn(modalManager, 'show').mockReturnValueOnce(pending.promise);
    const view = render(DetailPanelDate, { asset });
    await fireEvent.click(view.getByTestId('detail-panel-edit-date-button'));
    const options = dialog.mock.calls[0][1] as { onError: (error: unknown) => void };
    if (change === 'replace' || change === 'return') await view.rerender({ asset: owned() });
    if (change === 'return') await view.rerender({ asset });
    if (change === 'session') authManager.reset();
    options.onError(failure);
    pending.resolve(false);
    await settle();
    expect(screen.queryByRole('alert') !== null).toBe(change === 'current');
  },
);

it.each(['current', 'replace', 'session'])('keeps description reload with its view: %s', async (change) => {
  const asset = owned();
  const pending = deferredPromise<typeof asset>();
  sdkMock.updateAsset.mockRejectedValueOnce({ status: 404, data: { statusCode: 404, message: 'gone' } });
  sdkMock.getAssetInfo.mockReturnValueOnce(pending.promise);
  const onAssetRefresh = vi.fn();
  const view = render(DetailPanelDescription, { asset, isOwner: true, onAssetRefresh });
  const input = view.getByTestId('autogrow-textarea');
  await fireEvent.input(input, { target: { value: 'A lake' } });
  await fireEvent.focusOut(input);
  await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_info_reload' }));
  await waitFor(() => expect(sdkMock.getAssetInfo).toHaveBeenCalledWith({ id: asset.id }));
  if (change === 'replace') await view.rerender({ asset: owned() });
  if (change === 'session') authManager.reset();
  pending.resolve(asset);
  await settle();
  expect(onAssetRefresh).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
});

it.each(['retry', 'reload'])('keeps location %s results with their view', async (action) => {
  const asset = owned();
  const pending = deferredPromise<typeof asset>();
  const dialog = vi.spyOn(modalManager, 'show').mockResolvedValueOnce(null);
  const onAssetRefresh = vi.fn();
  const view = render(DetailPanelLocation, { asset, isOwner: true, onAssetRefresh });
  await fireEvent.click(view.getByTitle('edit_location'));
  const options = dialog.mock.calls[0][1] as {
    onError: (error: unknown, change: { latitude: number; longitude: number }) => void;
  };
  options.onError(action === 'retry' ? failure : { status: 404 }, { latitude: 11, longitude: 22 });
  if (action === 'retry') sdkMock.updateAsset.mockReturnValueOnce(pending.promise);
  else sdkMock.getAssetInfo.mockReturnValueOnce(pending.promise);
  await fireEvent.click(await screen.findByRole('button', { name: `frameleaf_info_${action}` }));
  if (action === 'retry')
    expect(sdkMock.updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { latitude: 11, longitude: 22 } });
  else expect(sdkMock.getAssetInfo).toHaveBeenCalledWith({ id: asset.id });
  await view.rerender({ asset: owned() });
  pending.resolve(asset);
  await settle();
  expect(onAssetRefresh).not.toHaveBeenCalled();
});

it('ignores a date reload after the displayed photo changes', async () => {
  const asset = owned();
  const pending = deferredPromise<typeof asset>();
  const dialog = vi.spyOn(modalManager, 'show').mockResolvedValueOnce(false);
  const onAssetRefresh = vi.fn();
  const view = render(DetailPanelDate, { asset, onAssetRefresh });
  await fireEvent.click(view.getByTestId('detail-panel-edit-date-button'));
  const options = dialog.mock.calls[0][1] as { onError: (error: unknown) => void };
  options.onError({ status: 404 });
  sdkMock.getAssetInfo.mockReturnValueOnce(pending.promise);
  await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_info_reload' }));
  expect(sdkMock.getAssetInfo).toHaveBeenCalledWith({ id: asset.id });
  await view.rerender({ asset: owned() });
  pending.resolve(asset);
  await settle();
  expect(onAssetRefresh).not.toHaveBeenCalled();
});
