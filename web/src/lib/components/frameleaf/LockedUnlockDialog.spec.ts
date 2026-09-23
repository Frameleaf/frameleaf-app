import { getAuthStatus, unlockAuthSession } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import LockedUnlockDialog from './LockedUnlockDialog.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAuthStatus: vi.fn(),
  unlockAuthSession: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('LockedUnlockDialog', () => {
  it('unlocks in place once six digits are entered and reports the elevated session', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ pinCode: true, isElevated: false, password: true } as never);
    vi.mocked(unlockAuthSession).mockResolvedValue(undefined as never);
    const onUnlocked = vi.fn();
    render(LockedUnlockDialog, { open: true, onUnlocked });

    const input = await screen.findByLabelText<HTMLInputElement>(en.frameleaf_locked_dialog_pin_label);
    await fireEvent.input(input, { target: { value: '123456' } });

    await waitFor(() => {
      expect(unlockAuthSession).toHaveBeenCalledWith({ sessionUnlockDto: { pinCode: '123456' } });
      expect(onUnlocked).toHaveBeenCalledOnce();
    });
  });

  it('clears a rejected code and shows the error without leaving the dialog', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ pinCode: true, isElevated: false, password: true } as never);
    vi.mocked(unlockAuthSession).mockRejectedValue(new Error('nope'));
    const onUnlocked = vi.fn();
    render(LockedUnlockDialog, { open: true, onUnlocked });

    const input = await screen.findByLabelText<HTMLInputElement>(en.frameleaf_locked_dialog_pin_label);
    await fireEvent.input(input, { target: { value: '000000' } });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(input.value).toBe('');
    expect(onUnlocked).not.toHaveBeenCalled();
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
});
