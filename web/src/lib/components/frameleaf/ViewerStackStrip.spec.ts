import type { StackResponseDto } from '@frameleaf/sdk';
import { modalManager, toastManager } from '@frameleaf/ui';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ViewerStackStrip from '$lib/components/frameleaf/ViewerStackStrip.svelte';
import { AssetAction } from '$lib/constants';
import { assetFactory } from '@test-data/factories/asset-factory';
import en from '../../../../../i18n/en.json';

/**
 * FL-35 / FL-83: the viewer's stack strip, with the template's two inline decisions — "set as
 * stack primary" (`updateStack`) and "keep this, delete the others" (`keepThisDeleteOthers`).
 * Both are the owner's only.
 */

const auth = vi.hoisted(() => ({ user: { id: 'owner' }, authenticated: true }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));

const setup = (ownerId = 'owner') => {
  const primary = assetFactory.build({ ownerId });
  const current = assetFactory.build({ ownerId });
  const other = assetFactory.build({ ownerId });
  const stack: StackResponseDto = { id: 'stack-1', primaryAssetId: primary.id, assets: [primary, current, other] };
  const onAction = vi.fn();
  render(ViewerStackStrip, { stack, asset: current, onAction, onSelect: vi.fn(), onPreview: vi.fn() });
  return { stack, primary, current, other, onAction };
};

describe('ViewerStackStrip', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(toastManager, 'primary').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('makes the viewed item the stack primary', async () => {
    const { current, stack, onAction } = setup();
    const updated = { ...stack, primaryAssetId: current.id };
    sdkMock.updateStack.mockResolvedValue(updated);

    await userEvent.click(screen.getByRole('button', { name: en.set_stack_primary_asset }));

    expect(sdkMock.updateStack).toHaveBeenCalledWith({ id: 'stack-1', stackUpdateDto: { primaryAssetId: current.id } });
    expect(onAction).toHaveBeenCalledWith({ type: AssetAction.SET_STACK_PRIMARY_ASSET, stack: updated });
  });

  it('keeps the viewed item and deletes the others after confirmation', async () => {
    const { current, primary, other, onAction } = setup();
    vi.spyOn(modalManager, 'showDialog').mockResolvedValue(true);
    sdkMock.deleteAssets.mockResolvedValue(undefined as never);
    sdkMock.deleteStacks.mockResolvedValue(undefined as never);

    await userEvent.click(screen.getByRole('button', { name: en.keep_this_delete_others }));

    await waitFor(() => expect(sdkMock.deleteStacks).toHaveBeenCalledWith({ bulkIdsDto: { ids: ['stack-1'] } }));
    expect(sdkMock.deleteAssets).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: [primary.id, other.id] } });
    expect(onAction).toHaveBeenCalledWith({
      type: AssetAction.UNSTACK,
      assets: [expect.objectContaining({ id: current.id })],
    });
  });

  it('deletes nothing when the confirmation is declined', async () => {
    const { onAction } = setup();
    vi.spyOn(modalManager, 'showDialog').mockResolvedValue(false);

    await userEvent.click(screen.getByRole('button', { name: en.keep_this_delete_others }));

    expect(sdkMock.deleteAssets).not.toHaveBeenCalled();
    expect(sdkMock.deleteStacks).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('offers neither decision to someone who does not own the item', () => {
    setup('someone-else');
    expect(screen.queryByRole('button', { name: en.set_stack_primary_asset })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.keep_this_delete_others })).not.toBeInTheDocument();
  });
});
