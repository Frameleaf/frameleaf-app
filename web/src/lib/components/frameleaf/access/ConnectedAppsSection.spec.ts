import type { OAuthAppGrantDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ConnectedAppsSection from '$lib/components/frameleaf/access/ConnectedAppsSection.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import en from '../../../../../../i18n/en.json';

const grant = (overrides: Partial<OAuthAppGrantDto> = {}): OAuthAppGrantDto => ({
  id: 'grant-1',
  client: {
    id: 'client-1',
    name: 'Claude',
    verified: true,
    maker: 'Anthropic',
    knownApp: 'claude',
    returnTo: 'claude.ai',
  },
  scopes: ['library:read', 'people:read'],
  createdAt: '2026-11-04T10:00:00.000Z',
  lastUsedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  lastUsedVia: 'relay',
  ...overrides,
});

const plan = (remoteAccess: boolean, publicUrl: string | null = 'https://taylor-home.frameleaf.cloud') => {
  vi.spyOn(featureFlagsManager, 'value', 'get').mockReturnValue({ remoteAccess } as never);
  vi.spyOn(serverConfigManager, 'value', 'get').mockReturnValue({
    externalDomain: '',
    frameleaf: { publicUrl },
  } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  plan(true);
});

describe('ConnectedAppsSection (FL-860)', () => {
  it('lists your apps with what they can do, when they were used and how they connected', async () => {
    sdkMock.getOAuthAppGrants.mockResolvedValue([grant()]);
    render(ConnectedAppsSection);

    expect(await screen.findByText('Sees your photos and knows who’s who')).toBeInTheDocument();
    expect(screen.getAllByText('Claude').length).toBeGreaterThan(0);
    expect(screen.getByText('Sees your photos and knows who’s who')).toBeInTheDocument();
    expect(screen.getByText(/Through remote access · allowed/)).toBeInTheDocument();
    expect(screen.getByText(/1 app can use your library/)).toBeInTheDocument();
  });

  it('says when nothing is connected and offers to connect an assistant', async () => {
    sdkMock.getOAuthAppGrants.mockResolvedValue([]);
    render(ConnectedAppsSection);

    expect(await screen.findByText(en.frameleaf_apps_hero_none)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_apps_connect_assistant })).toBeInTheDocument();
  });

  it('says when the list couldn’t be loaded and tries again', async () => {
    sdkMock.getOAuthAppGrants.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([grant()]);
    render(ConnectedAppsSection);

    expect(await screen.findByText(en.frameleaf_apps_hero_error)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_apps_try_again }));
    expect(await screen.findByText(/1 app can use your library/)).toBeInTheDocument();
  });

  it('warns about an app unused for 90 days', async () => {
    sdkMock.getOAuthAppGrants.mockResolvedValue([
      grant({ lastUsedAt: new Date(Date.now() - 100 * 86_400_000).toISOString() }),
    ]);
    render(ConnectedAppsSection);

    expect(await screen.findByText(/Claude hasn’t been used for 3 months/)).toBeInTheDocument();
  });

  it('Remove asks first, revokes the grant and takes it off the list', async () => {
    sdkMock.getOAuthAppGrants.mockResolvedValue([grant()]);
    sdkMock.revokeOAuthAppGrant.mockResolvedValue(undefined as never);
    render(ConnectedAppsSection);

    await fireEvent.click(await screen.findByRole('button', { name: 'Remove Claude’s access' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/stops being able to use your library straight away/)).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: en.frameleaf_apps_remove_access }));

    await waitFor(() => expect(sdkMock.revokeOAuthAppGrant).toHaveBeenCalledWith({ id: 'grant-1' }));
    expect(await screen.findByText('Claude can no longer use your library.')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_apps_hero_none)).toBeInTheDocument();
  });

  it('with remote access, shows the remote assistant address and the Claude steps', async () => {
    sdkMock.getOAuthAppGrants.mockResolvedValue([]);
    render(ConnectedAppsSection);

    expect(await screen.findByText('https://taylor-home.frameleaf.cloud/api/mcp')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_apps_setup_claude_1_title)).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_apps_setup_needs_remote_title)).not.toBeInTheDocument();
  });

  it('without a plan, shows only the home address and no Claude or ChatGPT steps', async () => {
    plan(false, null);
    sdkMock.getOAuthAppGrants.mockResolvedValue([]);
    render(ConnectedAppsSection);

    expect(await screen.findByText(en.frameleaf_apps_setup_needs_remote_title)).toBeInTheDocument();
    expect(screen.getByText(`${location.origin}/api/mcp`)).toBeInTheDocument();
    expect(screen.queryByText(/frameleaf\.cloud/)).not.toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_apps_setup_claude_1_title)).not.toBeInTheDocument();
    expect(screen.getByText(/Claude can’t reach a server that’s on your home network only/)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_apps_setup_local }));
    expect(screen.getByText(en.frameleaf_apps_setup_local_1_title)).toBeInTheDocument();
  });

  it('a plan whose remote address is not published yet still shows the home address only', async () => {
    plan(true, null);
    sdkMock.getOAuthAppGrants.mockResolvedValue([]);
    render(ConnectedAppsSection);

    expect(await screen.findByText(en.frameleaf_apps_setup_needs_remote_title)).toBeInTheDocument();
  });
});
