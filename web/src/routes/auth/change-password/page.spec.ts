import { changePassword, updateMyUser } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goto, invalidateAll } from '$app/navigation';
import en from '../../../../../i18n/en.json';
import { takeAuthNotice } from '../auth-notice';
import Page from './+page.svelte';

const { location } = vi.hoisted(() => ({ location: { protocol: 'https:' } }));

vi.mock('$app/state', () => ({ page: { url: location } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  changePassword: vi.fn(),
  updateMyUser: vi.fn(),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { email: 'user@nas' } } }));

beforeEach(() => {
  vi.clearAllMocks();
  location.protocol = 'https:';
  addMessages('dev', en);
  vi.mocked(changePassword).mockResolvedValue({} as never);
  vi.mocked(updateMyUser).mockResolvedValue({} as never);
});

describe('forced password change', () => {
  it('treats the strength meter as advisory and lets the server decide', async () => {
    location.protocol = 'http:';
    render(Page, {
      data: { local: false, statusUnavailable: false, destination: '/photos', meta: { title: 'Change password' } },
    });
    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_new_password), {
      target: { value: 'new-password' },
    });
    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_confirm_new_password), {
      target: { value: 'new-password' },
    });
    const save = screen.getByRole('button', { name: en.frameleaf_auth_save_and_sign_in });
    expect(save).toBeEnabled();
    expect(screen.queryByText(/without encryption/)).toBeNull();
    await fireEvent.click(save);
    await waitFor(() => expect(updateMyUser).toHaveBeenCalledWith({ userUpdateMeDto: { password: 'new-password' } }));
    expect(goto).toHaveBeenCalledWith('/auth/logout');
    // the sign-in page that follows says why, and fills the email in
    expect(takeAuthNotice()).toEqual({ kind: 'password-changed', email: 'user@nas' });
  });

  it('waits for a matching confirmation', async () => {
    render(Page, {
      data: { local: false, statusUnavailable: false, destination: '/photos', meta: { title: 'Change password' } },
    });
    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_new_password), { target: { value: 'abc' } });
    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_confirm_new_password), { target: { value: 'abd' } });
    expect(screen.getByRole('button', { name: en.frameleaf_auth_save_and_sign_in })).toBeDisabled();
    expect(screen.getByText(en.frameleaf_auth_passwords_mismatch_hint)).toBeInTheDocument();
  });
});

it.each(['http:', 'https:'])('sets the paired owner’s first password over %s and continues', async (protocol) => {
  location.protocol = protocol;
  render(Page, {
    data: { local: true, statusUnavailable: false, destination: '/albums', meta: { title: 'Set a local password' } },
  });
  const passwordField = screen.getByLabelText(en.frameleaf_auth_new_password);
  const save = screen.getByRole('button', { name: en.frameleaf_auth_local_password_continue });
  if (protocol === 'http:') {
    const warning = screen.getByRole('note');
    expect(warning).toHaveTextContent('Your password will be sent without encryption');
    expect(warning).toHaveTextContent('Continue only on a trusted local network');
    expect(warning.compareDocumentPosition(passwordField)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(save).toHaveAccessibleDescription(en.frameleaf_auth_local_password_http_warning);
  } else {
    expect(screen.queryByRole('note')).toBeNull();
  }
  await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_new_password), {
    target: { value: 'new-password' },
  });
  await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_confirm_new_password), {
    target: { value: 'new-password' },
  });
  await fireEvent.click(save);
  await waitFor(() =>
    expect(changePassword).toHaveBeenCalledWith({
      changePasswordDto: { password: '', newPassword: 'new-password', invalidateSessions: true },
    }),
  );
  expect(goto).toHaveBeenCalledWith('/albums', { invalidateAll: true });
  expect(updateMyUser).not.toHaveBeenCalled();
});

it('lets the signed-in owner retry an unavailable setup check', async () => {
  render(Page, {
    data: {
      local: true,
      statusUnavailable: true,
      destination: '/albums',
      meta: { title: 'Set a local password' },
    },
  });
  expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_auth_local_password_status_unavailable);
  expect(screen.queryByLabelText(en.frameleaf_auth_new_password)).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: en.retry }));
  expect(invalidateAll).toHaveBeenCalledOnce();
});
