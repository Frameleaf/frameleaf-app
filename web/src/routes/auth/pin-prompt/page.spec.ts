import { lockAuthSession, resetPinCode, setupPinCode, unlockAuthSession } from '@immich/sdk';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
import { sessionAccess, setSessionLockPending } from '$lib/frameleaf/session-access.svelte';
import { requestSessionLock } from '$lib/frameleaf/session-lock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import en from '../../../../../i18n/en.json';
import Page from './+page.svelte';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  lockAuthSession: vi.fn(),
  resetPinCode: vi.fn(),
  setupPinCode: vi.fn(),
  unlockAuthSession: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn(), goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$lib/managers/event-manager.svelte', () => ({ eventManager: { emit: vi.fn(), on: () => () => {} } }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/auth/pin-prompt'), params: {} } }));
vi.mock('$lib/managers/AssetCacheManager.svelte', () => ({
  assetCacheManager: { invalidate: vi.fn(), revoke: vi.fn() },
}));
vi.mock('$lib/utils/session-privacy', () => ({ clearSessionMedia: vi.fn() }));
vi.mock('$lib/utils/navigation', () => ({ isAssetViewerRoute: () => false, navigate: vi.fn() }));

const data = { hasPinCode: true, hasPassword: true, continueUrl: '/locked?from=test' };
const enter = async (digits: string) =>
  fireEvent.input(screen.getByLabelText<HTMLInputElement>(/Enter your PIN|Create a PIN|Confirm your PIN/), {
    target: { value: digits },
  });

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  setSessionLockPending(false);
  vi.mocked(unlockAuthSession).mockResolvedValue(undefined as never);
  vi.mocked(lockAuthSession).mockResolvedValue(undefined as never);
  vi.mocked(invalidateAll).mockResolvedValue(undefined as never);
  vi.mocked(setupPinCode).mockResolvedValue(undefined as never);
  vi.mocked(resetPinCode).mockResolvedValue(undefined as never);
});

describe('PIN prompt', () => {
  const deferredUnlock = () => {
    let resolve!: () => void;
    vi.mocked(unlockAuthSession).mockImplementationOnce(
      () => new Promise((done) => (resolve = () => done(undefined as never))),
    );
    return () => act(async () => resolve());
  };

  it('holds Cancel until a late unlock is locked and route data is refreshed', async () => {
    let confirmLock!: () => void;
    let confirmRefresh!: () => void;
    vi.mocked(lockAuthSession).mockImplementationOnce(
      () => new Promise((done) => (confirmLock = () => done(undefined as never))),
    );
    vi.mocked(invalidateAll).mockImplementationOnce(
      () => new Promise((done) => (confirmRefresh = () => done(undefined as never))),
    );
    const resolve = deferredUnlock();
    render(Page, { data } as never);
    await enter('123456');
    await waitFor(() => expect(unlockAuthSession).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!);
    expect(goto).not.toHaveBeenCalled();
    expect(sessionAccess.lockPending).toBe(true);
    expect(lockAuthSession).not.toHaveBeenCalled();
    await resolve();
    await waitFor(() => expect(lockAuthSession).toHaveBeenCalledOnce());
    expect(goto).not.toHaveBeenCalled();
    expect(invalidateAll).not.toHaveBeenCalled();
    await act(async () => confirmLock());
    await waitFor(() => expect(invalidateAll).toHaveBeenCalledOnce());
    expect(goto).not.toHaveBeenCalled();
    await act(async () => confirmRefresh());
    await waitFor(() => expect(goto).toHaveBeenCalledWith('/photos'));
    expect(vi.mocked(lockAuthSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(invalidateAll).mock.invocationCallOrder[0],
    );
    expect(eventManager.emit).toHaveBeenCalledWith('SessionLocked');
    expect(goto).not.toHaveBeenCalledWith(data.continueUrl);
  });

  it('waits for a pending unlock before opening Reset PIN and ignores its stale result', async () => {
    let confirmLock!: () => void;
    vi.mocked(lockAuthSession).mockImplementationOnce(
      () => new Promise((done) => (confirmLock = () => done(undefined as never))),
    );
    const resolve = deferredUnlock();
    render(Page, { data } as never);
    await enter('123456');
    await waitFor(() => expect(unlockAuthSession).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole('button', { name: 'Reset PIN' }));
    expect(screen.queryByLabelText('Account password')).toBeNull();
    expect(resetPinCode).not.toHaveBeenCalled();
    await resolve();
    await waitFor(() => expect(lockAuthSession).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText('Account password')).toBeNull();
    await act(async () => confirmLock());
    expect(invalidateAll).toHaveBeenCalledOnce();
    expect(goto).not.toHaveBeenCalledWith(data.continueUrl);
    await screen.findByLabelText('Account password');
    await fireEvent.input(screen.getByLabelText('Account password'), { target: { value: 'secret-password' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Reset PIN' }));
    await waitFor(() => expect(resetPinCode).toHaveBeenCalledOnce());
  });

  it('honors Cancel after Reset PIN was requested during an unlock', async () => {
    const resolve = deferredUnlock();
    render(Page, { data } as never);
    await enter('123456');
    await fireEvent.click(screen.getByRole('button', { name: 'Reset PIN' }));
    await fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!);
    expect(goto).not.toHaveBeenCalled();
    await resolve();
    await waitFor(() => expect(goto).toHaveBeenCalledWith('/photos'));
    expect(lockAuthSession).toHaveBeenCalledOnce();
    expect(invalidateAll).toHaveBeenCalledOnce();
    expect(resetPinCode).not.toHaveBeenCalled();
  });

  it('holds route navigation during unlock until the server lock is confirmed', async () => {
    const resolve = deferredUnlock();
    render(Page, { data } as never);
    await enter('123456');
    const preventNavigation = vi.fn();
    const guard = vi.mocked(beforeNavigate).mock.calls.at(-1)![0];
    guard({ cancel: preventNavigation, to: { url: new URL('/albums', location.origin) } } as never);
    expect(preventNavigation).toHaveBeenCalledOnce();
    expect(goto).not.toHaveBeenCalled();
    await resolve();
    await waitFor(() => expect(goto).toHaveBeenCalledWith(new URL('/albums', location.origin)));
    expect(lockAuthSession).toHaveBeenCalledOnce();
    expect(invalidateAll).toHaveBeenCalledOnce();
  });

  it('ignores an unlock response after the prompt unmounts', async () => {
    const resolve = deferredUnlock();
    const view = render(Page, { data } as never);
    await enter('123456');
    await waitFor(() => expect(unlockAuthSession).toHaveBeenCalledOnce());
    view.unmount();
    await resolve();
    await waitFor(() => expect(lockAuthSession).toHaveBeenCalledOnce());
    expect(invalidateAll).toHaveBeenCalledOnce();
    expect(goto).not.toHaveBeenCalled();
  });

  it('keeps the shared privacy barrier after unmount and a failed late lock', async () => {
    vi.mocked(lockAuthSession).mockRejectedValueOnce(new Error('offline'));
    const resolve = deferredUnlock();
    const view = render(Page, { data } as never);
    await enter('123456');
    view.unmount();
    expect(sessionAccess.lockPending).toBe(true);
    expect(sessionStorage.getItem('frameleaf:session-lock-pending')).toBe('true');
    await resolve();
    await waitFor(() => expect(lockAuthSession).toHaveBeenCalledOnce());
    expect(sessionAccess.lockPending).toBe(true);
    expect(sessionStorage.getItem('frameleaf:session-lock-pending')).toBe('true');
    await requestSessionLock();
    expect(lockAuthSession).toHaveBeenCalledTimes(2);
    expect(sessionAccess.lockPending).toBe(false);
  });

  it('keeps navigation blocked when the compensating lock fails, then retries it', async () => {
    vi.mocked(lockAuthSession).mockRejectedValueOnce(new Error('offline'));
    const resolve = deferredUnlock();
    render(Page, { data } as never);
    await enter('123456');
    await fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!);
    await resolve();
    await screen.findByRole('button', { name: 'Retry lock' });
    expect(goto).not.toHaveBeenCalled();
    expect(invalidateAll).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry lock' }));
    await waitFor(() => expect(goto).toHaveBeenCalledWith('/photos'));
    expect(lockAuthSession).toHaveBeenCalledTimes(2);
    expect(invalidateAll).toHaveBeenCalledOnce();
  });

  it('keeps a confirmed Wrong PIN (HTTP 400) in the prompt without a compensating lock', async () => {
    const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
    vi.mocked(unlockAuthSession).mockImplementationOnce((request) =>
      sdk.unlockAuthSession(request, {
        fetch: async () => Response.json({ message: 'Wrong PIN code' }, { status: 400 }),
      }),
    );
    render(Page, { data } as never);
    await enter('000000');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_locked_dialog_wrong_pin));
    const input = screen.getByLabelText<HTMLInputElement>('Enter your PIN');
    expect(input.value).toBe('');
    expect(input).toHaveFocus();
    expect(input.getAttribute('aria-describedby')).toContain('pin-prompt-error');
    expect(lockAuthSession).not.toHaveBeenCalled();
    expect(sessionAccess.lockPending).toBe(false);
    expect(screen.queryByRole('button', { name: 'Retry lock' })).toBeNull();
  });

  it('labels the keypad through translations', () => {
    render(Page, { data } as never);
    expect(screen.getByRole('button', { name: 'Digit 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Digit 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_pin_delete_digit })).toBeInTheDocument();
  });

  it('relocks after an ambiguous unlock failure, then verifies a retry before navigating', async () => {
    vi.mocked(unlockAuthSession).mockRejectedValueOnce(new Error('response lost'));
    render(Page, { data } as never);
    await enter('123456');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_locked_dialog_unlock_failed));
    expect(lockAuthSession).toHaveBeenCalledOnce();
    expect(screen.getByLabelText<HTMLInputElement>('Enter your PIN').value).toBe('');
    expect(goto).not.toHaveBeenCalled();

    await enter('654321');
    await waitFor(() => expect(goto).toHaveBeenCalledWith(data.continueUrl));
    expect(unlockAuthSession).toHaveBeenNthCalledWith(
      2,
      { sessionUnlockDto: { pinCode: '654321' } },
      { signal: expect.any(AbortSignal) },
    );
    expect(eventManager.emit).toHaveBeenCalledWith('SessionAccessChanged', { isElevated: true });
  });

  it('requires matching entries before creating a PIN', async () => {
    render(Page, { data: { ...data, hasPinCode: false } } as never);
    await enter('123456');
    expect(screen.getByRole('heading', { name: 'Confirm your PIN' })).toBeInTheDocument();
    await enter('654321');
    expect(screen.getByRole('alert')).toHaveTextContent("The PINs don't match");
    expect(setupPinCode).not.toHaveBeenCalled();
    await enter('112233');
    await enter('112233');
    await waitFor(() =>
      expect(setupPinCode).toHaveBeenCalledExactlyOnceWith({ pinCodeSetupDto: { pinCode: '112233' } }),
    );
    expect(screen.getByRole('heading', { name: 'Enter your PIN' })).toBeInTheDocument();
  });

  it('resets a forgotten PIN only after submitting the account password', async () => {
    render(Page, { data } as never);
    await fireEvent.click(screen.getByRole('button', { name: 'Reset PIN' }));
    expect(resetPinCode).not.toHaveBeenCalled();
    await fireEvent.input(screen.getByLabelText('Account password'), { target: { value: 'secret-password' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Reset PIN' }));
    await waitFor(() =>
      expect(resetPinCode).toHaveBeenCalledExactlyOnceWith({ pinCodeResetDto: { password: 'secret-password' } }),
    );
    expect(screen.getByRole('heading', { name: 'Create a PIN' })).toBeInTheDocument();
  });

  it('does not offer an unusable password reset to an account without a password', () => {
    render(Page, { data: { ...data, hasPassword: false } } as never);
    expect(screen.queryByRole('button', { name: 'Reset PIN' })).toBeNull();
    expect(screen.getByText('Ask your server administrator to reset a forgotten PIN.')).toBeInTheDocument();
  });
});
