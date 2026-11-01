import { checkPasswordLink, redeemPasswordLink } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import en from '../../../../../i18n/en.json';
import { takeAuthNotice } from '../auth-notice';
import Page from './+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  checkPasswordLink: vi.fn(),
  redeemPasswordLink: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  history.replaceState(null, '', '/auth/choose-password#the-token');
});

describe('choose a password with an emailed link (FL-538)', () => {
  it('checks the link, keeps the token out of the address, and signs in with the chosen password', async () => {
    vi.mocked(checkPasswordLink).mockResolvedValue({ name: 'Alex', email: 'alex@example.test' });
    vi.mocked(redeemPasswordLink).mockResolvedValue(undefined as never);
    render(Page);

    expect(await screen.findByDisplayValue('alex@example.test')).toBeInTheDocument();
    expect(checkPasswordLink).toHaveBeenCalledWith({ passwordLinkCheckDto: { token: 'the-token' } });
    expect(location.hash).toBe('');

    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_new_password), {
      target: { value: 'a-new-password' },
    });
    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_confirm_new_password), {
      target: { value: 'a-new-password' },
    });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_auth_choose_password_save }));

    await waitFor(() =>
      expect(redeemPasswordLink).toHaveBeenCalledWith({
        passwordLinkRedeemDto: { token: 'the-token', newPassword: 'a-new-password' },
      }),
    );
    expect(goto).toHaveBeenCalledWith('/auth/login');
    expect(takeAuthNotice()).toEqual({ kind: 'password-changed', email: 'alex@example.test' });
  });

  it('says plainly when a link has expired or was already used', async () => {
    vi.mocked(checkPasswordLink).mockRejectedValue(new Error('gone'));
    render(Page);
    expect(await screen.findByText(en.frameleaf_auth_choose_password_expired_title)).toBeInTheDocument();
    expect(screen.queryByLabelText(en.frameleaf_auth_new_password)).not.toBeInTheDocument();
  });
});
