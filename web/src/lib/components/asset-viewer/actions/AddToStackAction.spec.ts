import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { AssetAction } from '$lib/constants';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import AddToStackAction from './AddToStackAction.svelte';

const mocks = vi.hoisted(() => ({ pick: vi.fn(), current: true, error: vi.fn() }));
vi.mock('$lib/utils/file-uploader', () => ({ openFileUploadDialog: mocks.pick }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { captureSession: () => () => mocks.current } }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: mocks.error }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.current = true;
});

it('keeps the invoked primary when the viewer changes while selecting files', async () => {
  const [first, next] = assetFactory.buildList(2);
  const picked = deferredPromise<string[]>();
  mocks.pick.mockReturnValue(picked.promise);
  const created = { id: 'new-stack', primaryAssetId: first.id, assets: [first] };
  sdkMock.createStack.mockResolvedValue(created);
  const onAction = vi.fn();
  const view = render(AddToStackAction, { asset: first, stack: null, onAction, text: 'Upload to stack' });
  await fireEvent.click(screen.getByRole('menuitem'));
  await view.rerender({ asset: next, stack: null, onAction, text: 'Upload to stack' });
  picked.resolve(['uploaded']);
  await waitFor(() => expect(onAction).toHaveBeenCalled());
  expect(sdkMock.createStack).toHaveBeenCalledWith({ stackCreateDto: { assetIds: [first.id, 'uploaded'] } });
  expect(onAction).toHaveBeenCalledWith({ type: AssetAction.STACK, stack: created });
});

it('does nothing when the file picker is cancelled', async () => {
  mocks.pick.mockResolvedValue([]);
  render(AddToStackAction, { asset: assetFactory.build(), stack: null, onAction: vi.fn(), text: 'Upload to stack' });
  await fireEvent.click(screen.getByRole('menuitem'));
  expect(sdkMock.createStack).not.toHaveBeenCalled();
});

it('uses the existing stack primary and does not publish after its session retires', async () => {
  const [primary, current] = assetFactory.buildList(2);
  const stack = { id: 'stack', primaryAssetId: primary.id, assets: [primary, current] };
  const created = deferredPromise<typeof stack>();
  mocks.pick.mockResolvedValue(['uploaded']);
  sdkMock.createStack.mockReturnValue(created.promise);
  const onAction = vi.fn();
  render(AddToStackAction, { asset: current, stack, onAction, text: 'Upload to stack' });
  await fireEvent.click(screen.getByRole('menuitem'));
  await waitFor(() => expect(sdkMock.createStack).toHaveBeenCalled());
  expect(sdkMock.createStack).toHaveBeenCalledWith({ stackCreateDto: { assetIds: [primary.id, 'uploaded'] } });
  mocks.current = false;
  created.resolve(stack);
  await created.promise;
  await tick();
  await tick();
  expect(onAction).not.toHaveBeenCalled();
});

it.each(['picker', 'stack'])('owns a rejected %s request without publishing a stack', async (where) => {
  const error = new Error('request failed');
  mocks.pick.mockResolvedValue(['uploaded']);
  if (where === 'picker') {
    mocks.pick.mockRejectedValue(error);
  } else {
    sdkMock.createStack.mockRejectedValue(error);
  }
  const onAction = vi.fn();
  render(AddToStackAction, { asset: assetFactory.build(), stack: null, onAction, text: 'Upload to stack' });
  await fireEvent.click(screen.getByRole('menuitem'));
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(error, expect.any(String)));
  expect(onAction).not.toHaveBeenCalled();
});
