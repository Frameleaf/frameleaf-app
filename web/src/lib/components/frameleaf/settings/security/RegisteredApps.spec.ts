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
  addMessages('dev', en);
});

describe('RegisteredApps (FL-860)', () => {
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
    sdkMock.isHttpError.mockImplementation((error) => typeof error === 'object' && !!error && 'status' in error);
    render(RegisteredApps);

    await fireEvent.click(await screen.findByRole('button', { name: 'Remove Photo Helper?' }));
    await fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: en.frameleaf_apps_admin_remove }),
    );

    await waitFor(() => expect(handleError).toHaveBeenCalledTimes(1));
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
