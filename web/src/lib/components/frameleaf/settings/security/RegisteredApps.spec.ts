import { TokenEndpointAuthMethod } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RegisteredApps from '$lib/components/frameleaf/settings/security/RegisteredApps.svelte';
import { handleError } from '$lib/utils/handle-error';
import en from '../../../../../../../i18n/en.json';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const app = (name: string, activeUsers: number, verified = false) => ({
  client: {
    id: `${name}-id`,
    name,
    verified,
    maker: verified ? 'Anthropic' : null,
    knownApp: verified ? 'claude' : null,
    returnTo: 'claude.ai',
  },
  selfRegistered: true,
  createdAt: '2026-11-04T10:00:00.000Z',
  activeUsers,
});

beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.isHttpError.mockImplementation((error) => typeof error === 'object' && !!error && 'status' in error);
  addMessages('dev', en);
});

describe('RegisteredApps (FL-860)', () => {
  it('registers the exact Make callback and shows the non-secret client ID', async () => {
    sdkMock.getOAuthAppClients.mockResolvedValue([]);
    sdkMock.createOAuthAppClient.mockResolvedValue({
      clientId: 'client-1',
      name: 'Make',
      redirectUris: ['https://www.make.com/oauth/cb/app'],
      tokenEndpointAuthMethod: TokenEndpointAuthMethod.None,
    });
    render(RegisteredApps);
    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_connect_setup_app }));
    await fireEvent.input(screen.getByRole('textbox', { name: en.frameleaf_apps_allow_details_back }), {
      target: { value: 'https://www.make.com/oauth/cb/app' },
    });
    await fireEvent.click(screen.getByRole('button', { name: en.create }));
    expect(await screen.findByText('client-1')).toBeInTheDocument();
    expect(sdkMock.createOAuthAppClient).toHaveBeenCalledWith({
      oAuthAppCreateClientDto: { name: 'Make', preset: 'make', redirectUris: ['https://www.make.com/oauth/cb/app'] },
    });
    expect(screen.getByText('https://www.make.com/oauth/cb/app')).toBeInTheDocument();
  });

  it('keeps the callback editable when registration is rejected', async () => {
    sdkMock.getOAuthAppClients.mockResolvedValue([]);
    sdkMock.createOAuthAppClient.mockRejectedValueOnce({ status: 400 });
    render(RegisteredApps);
    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_connect_setup_app }));
    await fireEvent.input(screen.getByRole('textbox', { name: en.frameleaf_apps_allow_details_back }), {
      target: { value: 'http://unsafe.example/callback' },
    });
    await fireEvent.click(screen.getByRole('button', { name: en.create }));
    await waitFor(() => expect(handleError).toHaveBeenCalledWith({ status: 400 }, en.frameleaf_connect_setup_failed));
    expect(screen.getByRole('textbox', { name: en.frameleaf_apps_allow_details_back })).toHaveValue(
      'http://unsafe.example/callback',
    );
    expect(screen.queryByText(en.frameleaf_connect_client_ready)).not.toBeInTheDocument();
  });

  it('offers administrator setup with an explicit callback and platform preset', async () => {
    sdkMock.getOAuthAppClients.mockResolvedValue([]);
    render(RegisteredApps);
    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_connect_setup_app }));
    expect(screen.getByRole('combobox', { name: en.name })).toHaveValue('make');
    expect(screen.getByRole('textbox', { name: en.frameleaf_apps_allow_details_back })).toHaveValue('');
    expect(screen.getByText(en.frameleaf_connect_callback_help)).toBeInTheDocument();
  });

  it('lists registered apps with who allows them', async () => {
    sdkMock.getOAuthAppClients.mockResolvedValue([app('Claude', 2, true), app('Photo Helper', 0)]);
    render(RegisteredApps);

    expect(await screen.findByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('2 people allow it')).toBeInTheDocument();
    expect(screen.getByText('Nobody allows it')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_apps_details_unverified)).toBeInTheDocument();
  });

  it('says when no app is registered', async () => {
    sdkMock.getOAuthAppClients.mockResolvedValue([]);
    render(RegisteredApps);

    expect(await screen.findByText(en.frameleaf_apps_admin_none)).toBeInTheDocument();
  });

  it('reports a removal that failed', async () => {
    sdkMock.getOAuthAppClients.mockResolvedValue([app('Photo Helper', 1)]);
    sdkMock.deleteOAuthAppClient.mockRejectedValueOnce({ status: 500 });
    render(RegisteredApps);

    await fireEvent.click(await screen.findByRole('button', { name: 'Remove Photo Helper?' }));
    await fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: en.frameleaf_apps_admin_remove }),
    );

    await waitFor(() => expect(handleError).toHaveBeenCalledTimes(1));
  });

  it('does not report a removal when the app is already gone (404)', async () => {
    sdkMock.getOAuthAppClients.mockResolvedValue([app('Photo Helper', 1)]);
    sdkMock.deleteOAuthAppClient.mockRejectedValueOnce({ status: 404 });
    render(RegisteredApps);

    await fireEvent.click(await screen.findByRole('button', { name: 'Remove Photo Helper?' }));
    await fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: en.frameleaf_apps_admin_remove }),
    );

    await waitFor(() => expect(sdkMock.getOAuthAppClients).toHaveBeenCalledTimes(2));
    expect(handleError).not.toHaveBeenCalled();
  });

  it('Remove asks first, removes the app and reloads the list', async () => {
    sdkMock.getOAuthAppClients.mockResolvedValueOnce([app('Photo Helper', 1)]).mockResolvedValueOnce([]);
    sdkMock.deleteOAuthAppClient.mockResolvedValue(undefined as never);
    render(RegisteredApps);

    await fireEvent.click(await screen.findByRole('button', { name: 'Remove Photo Helper?' }));
    const dialog = await screen.findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: en.frameleaf_apps_admin_remove }));

    await waitFor(() => expect(sdkMock.deleteOAuthAppClient).toHaveBeenCalledWith({ id: 'Photo Helper-id' }));
    expect(await screen.findByText('Photo Helper was removed.')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_apps_admin_none)).toBeInTheDocument();
  });
});
