import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { userAdminFactory } from '$lib/../test-data/factories/user-factory';
import AccountPinDialog from '$lib/components/frameleaf/AccountPinDialog.svelte';
import { handleUpdateUserAdmin } from '$lib/services/user-admin.service';
import en from '../../../../../i18n/en.json';

vi.mock('$lib/services/user-admin.service', () => ({
  handleUpdateUserAdmin: vi.fn().mockResolvedValue(true),
}));

const user = userAdminFactory.build({ name: 'Grace Hopper' });

const fill = async (label: string, digits: string) => {
  await fireEvent.input(screen.getByLabelText(label), { target: { value: digits } });
};

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('AccountPinDialog', () => {
  it('sends a six-digit PIN to the admin update endpoint', async () => {
    render(AccountPinDialog, { user, mode: 'set', onClose: vi.fn() });

    await fill(en.frameleaf_users_pin_label, '123456');
    await fill(en.frameleaf_users_pin_confirm_label, '123456');
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_users_pin_set }));

    expect(handleUpdateUserAdmin).toHaveBeenCalledWith(user, { pinCode: '123456' });
  });

  it('refuses to submit while the two codes differ', async () => {
    render(AccountPinDialog, { user, mode: 'set', onClose: vi.fn() });

    await fill(en.frameleaf_users_pin_label, '123456');
    await fill(en.frameleaf_users_pin_confirm_label, '654321');

    expect(screen.getByRole('button', { name: en.frameleaf_users_pin_set }).hasAttribute('disabled')).toBe(true);
    expect(handleUpdateUserAdmin).not.toHaveBeenCalled();
  });

  it('refuses to submit a partial code', async () => {
    render(AccountPinDialog, { user, mode: 'set', onClose: vi.fn() });

    await fill(en.frameleaf_users_pin_label, '1234');
    await fill(en.frameleaf_users_pin_confirm_label, '1234');

    expect(screen.getByRole('button', { name: en.frameleaf_users_pin_set }).hasAttribute('disabled')).toBe(true);
  });

  it('clears a PIN by sending null, with no PIN entry at all', async () => {
    const onClose = vi.fn();
    render(AccountPinDialog, { user, mode: 'clear', onClose });

    expect(screen.queryByLabelText(en.frameleaf_users_pin_label)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_users_pin_reset }));

    expect(handleUpdateUserAdmin).toHaveBeenCalledWith(user, { pinCode: null });
  });

  it('does not keep the entered digits once the dialog is dismissed', async () => {
    render(AccountPinDialog, { user, mode: 'set', onClose: vi.fn() });

    const input = screen.getByLabelText<HTMLInputElement>(en.frameleaf_users_pin_label);
    await fill(en.frameleaf_users_pin_label, '123456');
    await fireEvent.click(screen.getByRole('button', { name: en.cancel }));

    expect(input.value).toBe('');
    expect(handleUpdateUserAdmin).not.toHaveBeenCalled();
  });

  it("is named after the template's action: Set PIN, Change PIN or Reset PIN", () => {
    const { unmount } = render(AccountPinDialog, { user, mode: 'set', onClose: vi.fn() });
    expect(screen.getByRole('dialog', { name: en.frameleaf_users_pin_set })).toBeInTheDocument();
    unmount();

    const second = render(AccountPinDialog, { user, mode: 'set', hasPin: true, onClose: vi.fn() });
    expect(screen.getByRole('dialog', { name: en.frameleaf_users_pin_change })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_users_pin_change })).toBeInTheDocument();
    second.unmount();

    render(AccountPinDialog, { user, mode: 'clear', hasPin: true, onClose: vi.fn() });
    expect(screen.getByRole('dialog', { name: en.frameleaf_users_pin_reset })).toBeInTheDocument();
  });
});
