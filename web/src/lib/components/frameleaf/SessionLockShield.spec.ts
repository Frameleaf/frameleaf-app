import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
import en from '../../../../../i18n/en.json';
import SessionLockShieldTestHarness from './SessionLockShieldTestHarness.svelte';

beforeEach(() => {
  addMessages('dev', en);
  HTMLDialogElement.prototype.showModal = function () {
    // eslint-disable-next-line unicorn/no-this-outside-of-class
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    // eslint-disable-next-line unicorn/no-this-outside-of-class
    this.removeAttribute('open');
  };
});
afterEach(() => {
  sessionAccess.retryLock = undefined;
});

describe('SessionLockShield', () => {
  it('hides cached media and retains it for a successful lock, with a reachable retry action', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    sessionAccess.retryLock = retry;
    const view = render(SessionLockShieldTestHarness, { active: true });

    const cached = screen.getByTestId('cached-private-media');
    expect(cached.parentElement).toHaveAttribute('inert');
    expect(cached.parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(cached.parentElement).toHaveClass('session-lock-content-hidden');
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveAttribute('open'));
    expect(screen.getByRole('dialog')).toHaveTextContent(en.frameleaf_locked_hidden);
    await fireEvent.click(screen.getByRole('button', { name: en.retry }));
    expect(retry).toHaveBeenCalledOnce();

    await view.rerender({ active: false });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cached.parentElement).not.toHaveClass('session-lock-content-hidden');
    expect(cached).toBeInTheDocument();
  });
});
