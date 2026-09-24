import { signUpAdmin } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import en from '../../../../../i18n/en.json';
import Page from './+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('@immich/sdk', async (original) => ({ ...(await original<object>()), signUpAdmin: vi.fn() }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { loadServerConfig: vi.fn().mockResolvedValue(undefined) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  vi.mocked(signUpAdmin).mockResolvedValue({} as never);
});

const fill = async (email: string, password: string, confirm = password) => {
  await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_name), { target: { value: 'Admin' } });
  await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_email), { target: { value: email } });
  await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_password), { target: { value: password } });
  await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_confirm_password), { target: { value: confirm } });
  await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_auth_create_account }));
};

describe('admin registration', () => {
  it('leaves the address and the password strength to the server', async () => {
    render(Page);
    await fill('admin@localhost', 'password');
    await waitFor(() =>
      expect(signUpAdmin).toHaveBeenCalledWith({
        signUpDto: { email: 'admin@localhost', password: 'password', name: 'Admin' },
      }),
    );
    expect(goto).toHaveBeenCalledWith('/auth/login');
  });

  it('still requires the confirmation to match', async () => {
    render(Page);
    await fill('admin@example.test', 'password', 'passw0rd');
    expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_auth_passwords_mismatch);
    expect(signUpAdmin).not.toHaveBeenCalled();
  });
});
