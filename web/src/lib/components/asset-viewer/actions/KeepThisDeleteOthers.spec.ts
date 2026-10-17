import { modalManager } from '@frameleaf/ui';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ViewerStackStrip from '$lib/components/frameleaf/ViewerStackStrip.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../../i18n/en.json';
import KeepThisDeleteOthers from './KeepThisDeleteOthers.svelte';

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  vi.clearAllMocks();
  authManager.setUser(userAdminFactory.build({ id: 'owner' }));
  authManager.setPreferences(preferencesFactory.build());
  sdkMock.deleteAssets.mockResolvedValue(undefined as never);
  sdkMock.deleteStacks.mockResolvedValue(undefined as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  authManager.reset();
});

const selection = (id: string) => {
  const asset = assetFactory.build({ id, ownerId: 'owner' });
  const other = assetFactory.build({ id: `${id}-other`, ownerId: 'owner' });
  return { asset, stack: { id: `${id}-stack`, primaryAssetId: id, assets: [asset, other] } };
};

// VIEWER-P3: "Keep this, remove the rest" lives in the viewer's ⋯ menu only; the stack card offers no
// stack decisions (ViewerStackStrip.spec checks that), so the ownership checks run on the menu action.
it('offers no keep action on the stack card', () => {
  const view = render(ViewerStackStrip, { ...selection('card'), onSelect: vi.fn(), onPreview: vi.fn() });
  expect(view.queryByRole('button', { name: en.frameleaf_viewer_menu_keep_this })).not.toBeInTheDocument();
  expect(view.queryByRole('button', { name: en.keep_this_delete_others })).not.toBeInTheDocument();
});

describe('menu keep action', () => {
  const setup = async () => {
    const pending = deferredPromise<boolean>();
    vi.spyOn(modalManager, 'showDialog').mockReturnValue(
      pending.promise as ReturnType<typeof sdkMock.removeAssetFromStack>,
    );
    const original = selection('original');
    const callbacks = { onAction: vi.fn() };
    const view = render(KeepThisDeleteOthers, { ...original, ...callbacks });
    await fireEvent.click(view.getByRole('menuitem', { name: en.frameleaf_viewer_menu_keep_this }));
    return { pending, original, callbacks, view };
  };

  it('keeps the target chosen before the confirmation opened', async () => {
    const { pending, callbacks, view } = await setup();
    await view.rerender({ ...selection('replacement'), ...callbacks });
    pending.resolve(true);
    await waitFor(() => expect(sdkMock.deleteStacks).toHaveBeenCalled());
    expect(sdkMock.deleteAssets).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: ['original-other'] } });
    expect(sdkMock.deleteStacks).toHaveBeenCalledWith({ bulkIdsDto: { ids: ['original-stack'] } });
  });

  it('does not start deletion for a confirmation from a previous session', async () => {
    const { pending } = await setup();
    authManager.reset();
    pending.resolve(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdkMock.deleteAssets).not.toHaveBeenCalled();
  });

  it('stops the second mutation after a session change during deletion', async () => {
    const { pending } = await setup();
    const deletion = deferredPromise<void>();
    sdkMock.deleteAssets.mockReturnValueOnce(deletion.promise as ReturnType<typeof sdkMock.deleteAssets>);
    pending.resolve(true);
    await waitFor(() => expect(sdkMock.deleteAssets).toHaveBeenCalled());
    authManager.reset();
    deletion.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdkMock.deleteStacks).not.toHaveBeenCalled();
  });
});
