import type { StackResponseDto } from '@frameleaf/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import SetStackPrimaryAsset from '$lib/components/asset-viewer/actions/SetStackPrimaryAsset.svelte';
import { AssetAction } from '$lib/constants';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import en from '../../../../../../i18n/en.json';

vi.mock('$lib/utils/handle-error');

describe('SetStackPrimaryAsset', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => vi.resetAllMocks());

  const setup = () => {
    const [primary, current] = assetFactory.buildList(2);
    const stack: StackResponseDto = { id: 'stack', primaryAssetId: primary.id, assets: [primary, current] };
    return { current, stack, onAction: vi.fn() };
  };

  it('reports the updated stack', async () => {
    const { current, stack, onAction } = setup();
    const updated = { ...stack, primaryAssetId: current.id };
    sdkMock.updateStack.mockResolvedValue(updated);
    render(SetStackPrimaryAsset, { asset: current, stack, onAction });
    await userEvent.click(screen.getByText(en.set_stack_primary_asset));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({ type: AssetAction.SET_STACK_PRIMARY_ASSET, stack: updated }),
    );
  });

  it('reports a failure in the session that asked', async () => {
    const { current, stack, onAction } = setup();
    const failure = new Error('offline');
    sdkMock.updateStack.mockRejectedValue(failure);
    render(SetStackPrimaryAsset, { asset: current, stack, onAction });
    await userEvent.click(screen.getByText(en.set_stack_primary_asset));
    await waitFor(() => expect(handleError).toHaveBeenCalledWith(failure, en.errors.something_went_wrong));
    expect(onAction).not.toHaveBeenCalled();
  });

  it('ignores the answer or failure of a request from an earlier session', async () => {
    const { current, stack, onAction } = setup();
    const pending = deferredPromise<StackResponseDto>();
    sdkMock.updateStack.mockReturnValue(pending.promise as ReturnType<typeof sdkMock.updateStack>);
    render(SetStackPrimaryAsset, { asset: current, stack, onAction });
    await userEvent.click(screen.getByText(en.set_stack_primary_asset));
    authManager.reset();
    pending.reject(new Error('sign-in required'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handleError).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });
});
