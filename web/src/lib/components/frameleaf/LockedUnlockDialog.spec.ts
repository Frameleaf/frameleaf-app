import { getAuthStatus, lockAuthSession, unlockAuthSession } from '@immich/sdk';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { describe, expect, it, vi } from 'vitest';
import { sessionAccess, setSessionLockPending } from '$lib/frameleaf/session-access.svelte';
import { requestSessionLock } from '$lib/frameleaf/session-lock';
// FL-34: the auth manager owns the sign-out navigation for a deleted session
import '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { revokeSessionView } from '$lib/utils/session-privacy';
import { watchSessionPrivacy } from '$lib/utils/session-privacy-guard';
import en from '../../../../../i18n/en.json';
import LockedUnlockDialog from './LockedUnlockDialog.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAuthStatus: vi.fn(),
  unlockAuthSession: vi.fn(),
  lockAuthSession: vi.fn(),
}));

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn().mockResolvedValue(undefined) }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/photos'), params: {} } }));
vi.mock('$lib/managers/AssetCacheManager.svelte', () => ({
  assetCacheManager: { invalidate: vi.fn(), revoke: vi.fn() },
}));
vi.mock('$lib/utils/session-privacy', () => ({ clearSessionMedia: vi.fn(), revokeSessionView: vi.fn() }));
vi.mock('$lib/utils/navigation', () => ({ isAssetViewerRoute: () => false, navigate: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  setSessionLockPending(false);
  vi.mocked(lockAuthSession).mockResolvedValue(undefined as never);
  addMessages('dev', en);
});

describe('LockedUnlockDialog', () => {
  it('keeps the dialog open after the SDK Wrong PIN 400 and allows a second attempt', async () => {
    const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
    vi.mocked(getAuthStatus).mockResolvedValue({ pinCode: true, isElevated: false, password: true } as never);
    vi.mocked(unlockAuthSession)
      .mockImplementationOnce((request) =>
        sdk.unlockAuthSession(request, {
          fetch: async () => Response.json({ message: 'Wrong PIN code' }, { status: 400 }),
        }),
      )
      .mockResolvedValueOnce(undefined as never);
    const onUnlocked = vi.fn();
    render(LockedUnlockDialog, { open: true, onUnlocked });
    const input = await screen.findByLabelText<HTMLInputElement>(en.frameleaf_locked_dialog_pin_label);
    await fireEvent.input(input, { target: { value: '000000' } });

    // translated, not the server's English message; focus and description return to the PIN
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.frameleaf_locked_dialog_wrong_pin);
    expect(input.value).toBe('');
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(lockAuthSession).not.toHaveBeenCalled();
    expect(revokeSessionView).not.toHaveBeenCalled();
    expect(sessionAccess.lockPending).toBe(false);
    expect(onUnlocked).not.toHaveBeenCalled();

    await fireEvent.input(input, { target: { value: '123456' } });
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(unlockAuthSession).toHaveBeenCalledTimes(2);
    expect(lockAuthSession).not.toHaveBeenCalled();
  });

  it.each([500, 401])('compensates SDK HTTP %s and retains the shield when the lock fails', async (status) => {
    const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
    vi.mocked(getAuthStatus).mockResolvedValue({ pinCode: true, isElevated: false, password: true } as never);
    vi.mocked(unlockAuthSession).mockImplementationOnce((request) =>
      sdk.unlockAuthSession(request, {
        fetch: async () => Response.json({ message: 'Uncertain session state' }, { status }),
      }),
    );
    vi.mocked(lockAuthSession).mockRejectedValueOnce(new TypeError('offline'));
    const onUnlocked = vi.fn();
    const view = render(LockedUnlockDialog, { open: true, onUnlocked });
    const input = await screen.findByLabelText<HTMLInputElement>(en.frameleaf_locked_dialog_pin_label);
    await fireEvent.input(input, { target: { value: '123456' } });
    await screen.findByRole('alert');
    expect(lockAuthSession).toHaveBeenCalledOnce();
    expect(sessionAccess.lockPending).toBe(true);
    view.unmount();
    expect(sessionAccess.lockPending).toBe(true);
    expect(onUnlocked).not.toHaveBeenCalled();
    await requestSessionLock();
    expect(sessionAccess.lockPending).toBe(false);
  });

  it('unlocks in place once six digits are entered and reports the elevated session', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ pinCode: true, isElevated: false, password: true } as never);
    vi.mocked(unlockAuthSession).mockResolvedValue(undefined as never);
    const onUnlocked = vi.fn();
    render(LockedUnlockDialog, { open: true, onUnlocked });

    const input = await screen.findByLabelText<HTMLInputElement>(en.frameleaf_locked_dialog_pin_label);
    await fireEvent.input(input, { target: { value: '123456' } });

    await waitFor(() => {
      expect(unlockAuthSession).toHaveBeenCalledWith(
        { sessionUnlockDto: { pinCode: '123456' } },
        { signal: expect.any(AbortSignal) },
      );
      expect(onUnlocked).toHaveBeenCalledOnce();
    });
  });

  it.each(['Cancel', 'close', 'unmount', 'local lock', 'remote lock'])(
    'waits for the real SDK unlock on %s and rejects late elevation',
    async (action) => {
      vi.mocked(getAuthStatus).mockResolvedValue({ pinCode: true, isElevated: false, password: true } as never);
      let resolveUnlock!: () => void;
      let resolveLock!: () => void;
      vi.mocked(unlockAuthSession).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveUnlock = () => resolve(undefined as never);
          }),
      );
      vi.mocked(lockAuthSession).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLock = () => resolve(undefined as never);
          }),
      );
      const guard = action === 'remote lock' ? watchSessionPrivacy(() => true) : undefined;
      const onUnlocked = vi.fn();
      const view = render(LockedUnlockDialog, { open: true, onUnlocked });
      const input = await screen.findByLabelText<HTMLInputElement>(en.frameleaf_locked_dialog_pin_label);
      await fireEvent.input(input, { target: { value: '123456' } });
      switch (action) {
        case 'unmount': {
          view.unmount();
          break;
        }
        case 'remote lock': {
          // FL-34: another tab's or the server's lock arrives as `SessionLockedRemote`
          eventManager.emit('SessionLockedRemote');
          break;
        }
        case 'local lock': {
          void requestSessionLock();
          break;
        }
        default: {
          await fireEvent.click(
            screen.getByRole('button', { name: action === 'close' ? en.frameleaf_locked_dialog_close : 'Cancel' }),
          );
        }
      }
      expect(sessionAccess.lockPending).toBe(true);
      expect(lockAuthSession).not.toHaveBeenCalled();
      await act(async () => resolveUnlock());
      await waitFor(() => expect(lockAuthSession).toHaveBeenCalledOnce());
      expect(sessionAccess.lockPending).toBe(true);
      expect(onUnlocked).not.toHaveBeenCalled();
      await act(async () => resolveLock());
      await waitFor(() => expect(sessionAccess.lockPending).toBe(false));
      expect(onUnlocked).not.toHaveBeenCalled();
      guard?.dispose();
    },
  );

  it.each(['Cancel', 'unmount'])(
    'keeps ambiguous elevation concealed after a rejected SDK response and failed relock on %s',
    async (dismissal) => {
      vi.mocked(getAuthStatus).mockResolvedValue({ pinCode: true, isElevated: false, password: true } as never);
      let rejectUnlock!: () => void;
      vi.mocked(unlockAuthSession).mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectUnlock = () => reject(new TypeError('response lost after server commit'));
          }),
      );
      vi.mocked(lockAuthSession).mockRejectedValueOnce(new TypeError('offline'));
      const onUnlocked = vi.fn();
      const view = render(LockedUnlockDialog, { open: true, onUnlocked });
      const input = await screen.findByLabelText<HTMLInputElement>(en.frameleaf_locked_dialog_pin_label);
      await fireEvent.input(input, { target: { value: '123456' } });
      await act(async () => rejectUnlock());
      await waitFor(() => expect(lockAuthSession).toHaveBeenCalledOnce());
      await screen.findByRole('alert');
      expect(input.value).toBe('');
      expect(sessionAccess.lockPending).toBe(true);
      expect(sessionStorage.getItem('frameleaf:session-lock-pending')).toBe('true');
      if (dismissal === 'unmount') {
        view.unmount();
      } else {
        await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      }
      expect(sessionAccess.lockPending).toBe(true);
      expect(onUnlocked).not.toHaveBeenCalled();
      await requestSessionLock();
      expect(lockAuthSession).toHaveBeenCalledTimes(2);
      expect(sessionAccess.lockPending).toBe(false);
      expect(onUnlocked).not.toHaveBeenCalled();
    },
  );

  it('compensates a rejected unlock before retiring the document', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ pinCode: true, isElevated: false, password: true } as never);
    vi.mocked(unlockAuthSession).mockRejectedValueOnce(new TypeError('response lost'));
    const onUnlocked = vi.fn();
    render(LockedUnlockDialog, { open: true, onUnlocked });
    const input = await screen.findByLabelText<HTMLInputElement>(en.frameleaf_locked_dialog_pin_label);
    await fireEvent.input(input, { target: { value: '123456' } });
    await waitFor(() => expect(revokeSessionView).toHaveBeenCalledWith('/photos'));
    expect(lockAuthSession).toHaveBeenCalledOnce();
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('rejects a late SDK success after authentication deletion before the status check settles', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ pinCode: true, isElevated: false, password: true } as never);
    const guard = watchSessionPrivacy(() => true);
    let finish!: () => void;
    vi.mocked(unlockAuthSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined as never);
        }),
    );
    const onUnlocked = vi.fn();
    render(LockedUnlockDialog, { open: true, onUnlocked });
    const input = await screen.findByLabelText<HTMLInputElement>(en.frameleaf_locked_dialog_pin_label);
    await fireEvent.input(input, { target: { value: '123456' } });
    eventManager.emit('SessionDelete');
    expect(revokeSessionView).toHaveBeenCalledWith('/auth/logout');
    expect(lockAuthSession).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(lockAuthSession).toHaveBeenCalledOnce());
    expect(onUnlocked).not.toHaveBeenCalled();
    guard.dispose();
  });

  it('sends a session without a PIN to PIN settings instead of asking for digits', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ pinCode: false, isElevated: false, password: true } as never);
    render(LockedUnlockDialog, { open: true, onUnlocked: vi.fn() });

    expect(await screen.findByText(en.frameleaf_locked_dialog_no_pin)).toBeInTheDocument();
    expect(screen.queryByLabelText(en.frameleaf_locked_dialog_pin_label)).toBeNull();
    expect(screen.getByRole('link', { name: en.frameleaf_locked_dialog_pin_settings })).toHaveAttribute(
      'href',
      '/user-settings',
    );
  });

  it('tells a network failure apart from a revoked session and offers a retry', async () => {
    vi.mocked(getAuthStatus)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ pinCode: true, isElevated: false, password: true } as never);
    render(LockedUnlockDialog, { open: true, onUnlocked: vi.fn() });
    expect(await screen.findByText(en.frameleaf_locked_dialog_offline)).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_locked_dialog_unavailable)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: en.retry }));
    expect(await screen.findByLabelText(en.frameleaf_locked_dialog_pin_label)).toBeInTheDocument();
  });

  it('reports a revoked session (401) as no longer available', async () => {
    const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
    vi.mocked(getAuthStatus).mockImplementationOnce(() =>
      sdk.getAuthStatus({ fetch: async () => Response.json({ message: 'Invalid user token' }, { status: 401 }) }),
    );
    render(LockedUnlockDialog, { open: true, onUnlocked: vi.fn() });
    expect(await screen.findByText(en.frameleaf_locked_dialog_unavailable)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.retry })).toBeNull();
  });
});
