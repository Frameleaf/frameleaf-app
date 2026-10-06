import { CloudLinkState } from '@frameleaf/sdk';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AccountMenu from './AccountMenu.svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/photos') } }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { frameleafCloud: false, supporter: false } },
}));

/** S-23 / S-24: the account menu's Locked switch and destructive Sign out (SystemPanels.jsx:77-135). */
describe('AccountMenu', () => {
  beforeEach(() => {
    authManager.setUser(userAdminFactory.build({ isAdmin: true }));
    sdkMock.getCloudStatus.mockResolvedValue({ state: CloudLinkState.Unlinked, account: null } as never);
  });
  afterEach(() => {
    cleanup();
    authManager.reset();
  });

  const open = async (isElevated: boolean) => {
    render(AccountMenu, { isElevated, isSessionLoading: false, onUnlock: vi.fn(), onLock: vi.fn() });
    await fireEvent.click(screen.getAllByRole('button')[0]);
  };

  it('draws the Locked item as a switch that follows the session', async () => {
    await open(true);
    const locked = screen.getByRole('menuitemcheckbox');
    expect(locked).toHaveAttribute('aria-checked', 'true');
    expect(locked.querySelector('.fl-switch')).not.toBeNull();
  });

  it('draws Sign out as the danger item', async () => {
    await open(false);
    expect(screen.getByRole('menuitem', { name: 'sign_out' })).toHaveClass('danger');
  });

  it('skips the loading Locked control when wrapping focus and restores the trigger on Escape', async () => {
    render(AccountMenu, { isElevated: false, isSessionLoading: true, onUnlock: vi.fn(), onLock: vi.fn() });
    const trigger = screen.getAllByRole('button')[0];
    trigger.focus();
    await fireEvent.click(trigger);
    expect(screen.getByRole('menuitemcheckbox')).toBeDisabled();

    const first = screen.getAllByRole('menuitem')[0];
    const last = screen.getByRole('menuitem', { name: 'sign_out' });
    first.focus();
    await fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(last).toHaveFocus();
    await fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(first).toHaveFocus();
    await fireEvent.keyDown(first, { key: 'End' });
    expect(last).toHaveFocus();
    await fireEvent.keyDown(last, { key: 'Home' });
    expect(first).toHaveFocus();
    await fireEvent.keyDown(first, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('offers Support Frameleaf and, for an administrator, the Frameleaf Cloud link state and AI credit (FL-157)', async () => {
    sdkMock.getCloudStatus.mockResolvedValue({
      state: CloudLinkState.Linked,
      account: { id: 'a', label: 'owner@example.test' },
    } as never);
    sdkMock.getCloudMlStatus.mockResolvedValue({ wallet: { availableUsd: 18.42 } } as never);
    await open(false);

    expect(screen.getByRole('menuitem', { name: /buy/ })).toHaveAttribute('href', '/buy');
    const cloud = screen.getByRole('menuitem', { name: /frameleaf_settings_area_cloud/ });
    expect(cloud.getAttribute('href')).toContain('area=cloud');
    await waitFor(() => expect(cloud).toHaveTextContent('$18.42'));
  });
});
