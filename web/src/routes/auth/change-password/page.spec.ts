import { updateMyUser } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import en from '../../../../../i18n/en.json';
import Page from './+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('@immich/sdk', async (original) => ({ ...(await original<object>()), updateMyUser: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { email: 'user@nas' } } }));

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  vi.mocked(updateMyUser).mockResolvedValue({} as never);
});

describe('forced password change', () => {
  it('treats the strength meter as advisory and lets the server decide', async () => {
    render(Page);
    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_new_password), {
      target: { value: 'new-password' },
    });
    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_confirm_new_password), {
      target: { value: 'new-password' },
    });
    const save = screen.getByRole('button', { name: en.frameleaf_auth_save_and_continue });
    expect(save).toBeEnabled();
    await fireEvent.click(save);
    await waitFor(() => expect(updateMyUser).toHaveBeenCalledWith({ userUpdateMeDto: { password: 'new-password' } }));
    expect(goto).toHaveBeenCalledWith('/auth/logout');
  });

  it('waits for a matching confirmation', async () => {
    render(Page);
    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_new_password), { target: { value: 'abc' } });
    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_confirm_new_password), { target: { value: 'abd' } });
    expect(screen.getByRole('button', { name: en.frameleaf_auth_save_and_continue })).toBeDisabled();
    expect(screen.getByText(en.frameleaf_auth_passwords_mismatch_hint)).toBeInTheDocument();
  });
});
