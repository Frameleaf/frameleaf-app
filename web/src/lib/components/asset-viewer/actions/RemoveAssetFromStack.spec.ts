import type { StackResponseDto } from '@frameleaf/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RemoveAssetFromStack from '$lib/components/asset-viewer/actions/RemoveAssetFromStack.svelte';
import { AssetAction } from '$lib/constants';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import en from '../../../../../../i18n/en.json';

vi.mock('$lib/utils/handle-error');

/** FL-35 / FL-83: removing one item from a stack, the viewer's other stack decision. */
describe('RemoveAssetFromStack', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => vi.resetAllMocks());

  it('removes only the viewed item and reports the smaller stack', async () => {
    const [primary, current, other] = assetFactory.buildList(3);
    const stack: StackResponseDto = { id: 'stack-1', primaryAssetId: primary.id, assets: [primary, current, other] };
    const onAction = vi.fn();
    sdkMock.removeAssetFromStack.mockResolvedValue(undefined as never);

    render(RemoveAssetFromStack, { asset: current, stack, onAction });
    await userEvent.click(screen.getByText(en.viewer_remove_from_stack));

    expect(sdkMock.removeAssetFromStack).toHaveBeenCalledWith({ id: 'stack-1', assetId: current.id });
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        type: AssetAction.REMOVE_ASSET_FROM_STACK,
        stack: { ...stack, assets: [primary, other] },
        asset: current,
      }),
    );
  });
  it('reports the original stack when the selection changes during removal', async () => {
    const [primary, current, replacement] = assetFactory.buildList(3);
    const stack: StackResponseDto = { id: 'original-stack', primaryAssetId: primary.id, assets: [primary, current] };
    const onAction = vi.fn();
    const pending = deferredPromise<void>();
    sdkMock.removeAssetFromStack.mockReturnValue(pending.promise as ReturnType<typeof sdkMock.removeAssetFromStack>);
    const view = render(RemoveAssetFromStack, { asset: current, stack, onAction });
    await userEvent.click(screen.getByText(en.viewer_remove_from_stack));
    await view.rerender({
      asset: replacement,
      stack: { ...stack, id: 'replacement-stack', assets: [replacement] },
      onAction,
    });
    pending.resolve();
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        type: AssetAction.REMOVE_ASSET_FROM_STACK,
        stack: { ...stack, assets: [primary] },
        asset: current,
      }),
    );
  });

  it('does not publish the old stack into another session', async () => {
    const asset = assetFactory.build();
    const stack: StackResponseDto = { id: 'stack', primaryAssetId: asset.id, assets: [asset] };
    const onAction = vi.fn();
    const pending = deferredPromise<void>();
    sdkMock.removeAssetFromStack.mockReturnValue(pending.promise as ReturnType<typeof sdkMock.removeAssetFromStack>);
    render(RemoveAssetFromStack, { asset, stack, onAction });
    await userEvent.click(screen.getByText(en.viewer_remove_from_stack));
    authManager.reset();
    pending.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAction).not.toHaveBeenCalled();
  });

  it('reports a failed removal and keeps the stack unchanged', async () => {
    const [primary, current] = assetFactory.buildList(2);
    const stack: StackResponseDto = { id: 'stack', primaryAssetId: primary.id, assets: [primary, current] };
    const onAction = vi.fn();
    const failure = new Error('offline');
    sdkMock.removeAssetFromStack.mockRejectedValue(failure);
    render(RemoveAssetFromStack, { asset: current, stack, onAction });
    await userEvent.click(screen.getByText(en.viewer_remove_from_stack));
    await waitFor(() => expect(handleError).toHaveBeenCalledWith(failure, en.errors.failed_to_unstack_assets));
    expect(onAction).not.toHaveBeenCalled();
  });
});
