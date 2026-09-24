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
  sessionAccess.lockStatus = 'idle';
  sessionAccess.isElevated = false;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
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

  it('disables Retry while the lock runs and reports a failure inside the shield', async () => {
    sessionAccess.retryLock = vi.fn().mockResolvedValue(undefined);
    sessionAccess.lockStatus = 'locking';
    render(SessionLockShieldTestHarness, { active: true });
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveAttribute('open'));
    expect(screen.getByRole('button', { name: en.retry })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(en.frameleaf_session_lock_locking);

    sessionAccess.lockStatus = 'failed';
    await waitFor(() => expect(screen.getByRole('button', { name: en.retry })).toBeEnabled());
    expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_session_lock_failed);
  });

  it('conceals only this tab while it is hidden and unlocked, without a lock', async () => {
    sessionAccess.isElevated = true;
    const retry = vi.fn();
    sessionAccess.retryLock = retry;
    render(SessionLockShieldTestHarness, { active: false });

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(document.documentElement).toHaveClass('session-concealed'));
    expect(sessionAccess.lockPending).toBe(false);
    expect(retry).not.toHaveBeenCalled();

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(document.documentElement).not.toHaveClass('session-concealed'));
    expect(screen.getByTestId('cached-private-media')).toBeInTheDocument();
  });

  it('does not conceal a hidden tab that holds nothing unlocked', async () => {
    render(SessionLockShieldTestHarness, { active: false });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(document.documentElement).not.toHaveClass('session-concealed');
  });
});
