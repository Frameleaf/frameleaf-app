import type { StackResponseDto } from '@frameleaf/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RemoveAssetFromStack from '$lib/components/asset-viewer/actions/RemoveAssetFromStack.svelte';
import { AssetAction } from '$lib/constants';
import { assetFactory } from '@test-data/factories/asset-factory';
import en from '../../../../../../i18n/en.json';

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
});
