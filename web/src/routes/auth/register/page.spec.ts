import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { createSetup, flowSteps, saveLocalSetup } from '$lib/frameleaf/first-run-setup';
import { authManager } from '$lib/managers/auth-manager.svelte';
import en from '../../../../../i18n/en.json';
import Page from './+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { loadServerConfig: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: false, load: vi.fn().mockResolvedValue(undefined) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  addMessages('dev', en);
  sdkMock.signUpAdmin.mockResolvedValue({} as never);
  sdkMock.login.mockResolvedValue({ isAdmin: true } as never);
  sdkMock.getFrameleafSetupStorage.mockResolvedValue({
    path: '/data',
    writable: true,
    freeBytes: 2e12,
    totalBytes: 4e12,
  });
  sdkMock.updateFrameleafSetup.mockResolvedValue({} as never);
});

describe('new server setup (FL-176)', () => {
  it('opens on the welcome stage', () => {
    render(Page);
    expect(screen.getByRole('button', { name: /Continue setup/ })).toBeInTheDocument();
  });

  it('creates the admin with the sign-up API, signs in and moves on to the library', async () => {
    const state = createSetup('new');
    const account = flowSteps('new').findIndex((entry) => entry.id === 'account');
    saveLocalSetup({ ...state, step: account, reached: account, choices: { ...state.choices, signIn: 'local' } });
    render(Page);

    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_name), { target: { value: 'Ada' } });
    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_email), { target: { value: 'ada@example.test' } });
    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_password), { target: { value: 'Correct-Horse-9' } });
    await fireEvent.input(screen.getByLabelText(en.frameleaf_auth_confirm_password), {
      target: { value: 'Correct-Horse-9' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    await waitFor(() =>
      expect(sdkMock.signUpAdmin).toHaveBeenCalledWith({
        signUpDto: { email: 'ada@example.test', password: 'Correct-Horse-9', name: 'Ada' },
      }),
    );
    expect(sdkMock.login).toHaveBeenCalledWith({
      loginCredentialDto: { email: 'ada@example.test', password: 'Correct-Horse-9' },
    });
    // The new-server flow is saved straight away at the library step, before the session loads (which
    // redraws the page) and before the debounced progress save (FL-176 N2).
    await waitFor(() => expect(sdkMock.getFrameleafSetupStorage).toHaveBeenCalled());
    expect(sdkMock.updateFrameleafSetup).toHaveBeenNthCalledWith(1, {
      frameleafSetupUpdateDto: expect.objectContaining({
        flow: 'new',
        progress: expect.objectContaining({ step: 'library' }),
      }),
    });
    const firstSave = sdkMock.updateFrameleafSetup.mock.invocationCallOrder[0];
    expect(firstSave).toBeLessThan(vi.mocked(authManager.load).mock.invocationCallOrder[0]);
    expect(firstSave).toBeLessThan(sdkMock.getFrameleafSetupStorage.mock.invocationCallOrder[0]);
    expect(await screen.findByRole('heading', { name: en.frameleaf_setup_library_title })).toBeInTheDocument();
    expect(await screen.findByText('Writable, 2.0 TB free')).toBeInTheDocument();
    await waitFor(() => expect(sdkMock.updateFrameleafSetup).toHaveBeenCalled());
    const saved = JSON.stringify(sdkMock.updateFrameleafSetup.mock.calls);
    expect(saved).not.toContain('Correct-Horse-9');
    expect(saved).toContain('"flow":"new"');
  });
});
