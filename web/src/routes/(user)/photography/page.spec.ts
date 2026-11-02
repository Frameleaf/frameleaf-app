import { toastManager } from '@frameleaf/ui';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import type { PageData } from './$types';
import PhotographyPage from './+page.svelte';

const app = vi.hoisted(() => ({
  goto: vi.fn().mockResolvedValue(undefined),
  workspace: undefined as undefined | { onRemoveFromTopBar?: () => void },
}));

vi.mock('$app/navigation', () => ({ goto: app.goto }));
vi.mock(
  '$lib/components/layouts/UserPageLayout.svelte',
  async () => import('@test-data/mocks/UserPageLayout.mock.svelte'),
);
// The workspace has its own spec; here it only shows that it is the one on the page.
vi.mock('$lib/components/frameleaf/PhotographyWorkspace.svelte', () => ({
  default: (_anchor: unknown, props: { onRemoveFromTopBar?: () => void }) => {
    app.workspace = props;
  },
}));

const data = { meta: { title: 'Clients' } } as unknown as PageData;
const withClients = (enabled: boolean) => preferencesFactory.build({ clients: { enabled } });

describe('Clients page (opt-in, owner October 28)', () => {
  beforeAll(() => addMessages('dev', en));

  beforeEach(() => {
    vi.clearAllMocks();
    app.workspace = undefined;
    authManager.setUser(userAdminFactory.build());
  });

  afterEach(() => authManager.reset());

  it('shows the introduction while Clients is off, and starting it turns the preference on', async () => {
    authManager.setPreferences(withClients(false));
    sdkMock.updateMyPreferences.mockResolvedValue(withClients(true));
    render(PhotographyPage, { data });

    expect(screen.getByRole('heading', { name: 'Clients' })).toBeInTheDocument();
    expect(app.workspace).toBeUndefined();
    await fireEvent.click(screen.getByRole('button', { name: 'Start using Clients' }));

    expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
      userPreferencesUpdateDto: { clients: { enabled: true } },
    });
    await waitFor(() => expect(app.workspace).toBeDefined());
    expect(authManager.preferences.clients?.enabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Start using Clients' })).toBeNull();
  });

  it('reads a preference without Clients as off', () => {
    const preferences = preferencesFactory.build();
    delete (preferences as { clients?: unknown }).clients;
    authManager.setPreferences(preferences);
    render(PhotographyPage, { data });

    expect(screen.getByRole('button', { name: 'Start using Clients' })).toBeInTheDocument();
  });

  it('keeps the introduction when the preference cannot be saved', async () => {
    authManager.setPreferences(withClients(false));
    sdkMock.updateMyPreferences.mockRejectedValue(new Error('offline'));
    render(PhotographyPage, { data });

    await fireEvent.click(screen.getByRole('button', { name: 'Start using Clients' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start using Clients' })).toBeEnabled());
    expect(app.workspace).toBeUndefined();
  });

  it('removes Clients from the top bar: preference off, back to Library, and says what was kept', async () => {
    const toast = vi.spyOn(toastManager, 'primary').mockImplementation(() => {});
    authManager.setPreferences(withClients(true));
    sdkMock.updateMyPreferences.mockResolvedValue(withClients(false));
    render(PhotographyPage, { data });

    expect(app.workspace?.onRemoveFromTopBar).toBeTypeOf('function');
    app.workspace?.onRemoveFromTopBar?.();

    await waitFor(() => expect(app.goto).toHaveBeenCalledWith('/photos'));
    expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
      userPreferencesUpdateDto: { clients: { enabled: false } },
    });
    expect(authManager.preferences.clients?.enabled).toBe(false);
    expect(toast).toHaveBeenCalledWith('Clients is back under Tools. Your shoots and galleries are kept.');
  });
});
