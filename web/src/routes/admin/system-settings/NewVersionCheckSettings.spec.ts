import { checkVersionNow, getVersionCheck, ReleaseChannel, ReleaseType, type AdminConfigDto } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../i18n/en.json';
import NewVersionCheckSettings from './NewVersionCheckSettings.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  checkVersionNow: vi.fn(),
  getVersionCheck: vi.fn(),
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
  getSystemConfigDraft: () => draft.store,
}));

const config = (enabled: boolean) =>
  ({ newVersionCheck: { enabled, channel: ReleaseChannel.Stable } }) as unknown as AdminConfigDto;

const newStore = (enabled: boolean) =>
  new SystemConfigDraftStore(
    { config: config(enabled), revision: 'r1' },
    { defaults: config(false), load: vi.fn(), save: vi.fn() },
  );

describe('Versions & compatibility (FL-80 S-4)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.mocked(checkVersionNow).mockReset();
    vi.mocked(getVersionCheck).mockReset();
    vi.mocked(getVersionCheck).mockResolvedValue({ checkedAt: null, releaseVersion: null });
  });

  it('edits the saved check setting in the draft', async () => {
    const store = newStore(false);
    draft.store = store;
    render(NewVersionCheckSettings);

    expect(await screen.findByText('Checks off')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('switch', { name: /Check for updates/ }));
    expect(store.draft.newVersionCheck.enabled).toBe(true);
  });

  it('checks now and links the release notes of a newer version', async () => {
    draft.store = newStore(true);
    vi.mocked(checkVersionNow).mockResolvedValue({
      isAvailable: true,
      checkedAt: new Date().toISOString(),
      serverVersion: { major: 3, minor: 2, patch: 0, prerelease: null },
      releaseVersion: { major: 3, minor: 3, patch: 0, prerelease: 2, prereleaseName: 'beta.2' },
      type: ReleaseType.Preminor,
    });
    render(NewVersionCheckSettings);

    await fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));

    expect(await screen.findByText(/Frameleaf v3\.3\.0-beta\.2 is available/)).toBeInTheDocument();
    expect(screen.getByText('Update available')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute(
      'href',
      'https://github.com/Frameleaf/frameleaf-app/releases?q=frameleaf-v3.3.0-beta.2&expanded=true',
    );
  });

  it('says plainly when update information is unavailable, and offers Try again', async () => {
    draft.store = newStore(true);
    vi.mocked(checkVersionNow).mockRejectedValue(new Error('offline'));
    render(NewVersionCheckSettings);

    await fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));

    expect(await screen.findByText('Update information is unavailable. Try again later.')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });
});
