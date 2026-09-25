import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AccountMenu from './AccountMenu.svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/photos') } }));

/** S-23 / S-24: the account menu's Locked switch and destructive Sign out (SystemPanels.jsx:77-135). */
describe('AccountMenu', () => {
  beforeEach(() => authManager.setUser(userAdminFactory.build()));
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
});
