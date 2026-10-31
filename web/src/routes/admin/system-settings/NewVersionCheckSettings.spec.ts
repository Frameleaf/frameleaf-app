import {
  checkVersionNow,
  getVersionCheck,
  ReleaseChannel,
  ReleaseType,
  VersionCheckFrequency,
  type AdminConfigDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import { websocketStore } from '$lib/stores/websocket';
import en from '../../../../../i18n/en.json';
import NewVersionCheckSettings from './NewVersionCheckSettings.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));

vi.mock('@frameleaf/sdk', async (original) => ({
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
  ({
    newVersionCheck: { enabled, channel: ReleaseChannel.Stable, frequency: VersionCheckFrequency.Daily },
  }) as unknown as AdminConfigDto;

const newStore = (enabled: boolean) =>
  new SystemConfigDraftStore(
    { config: config(enabled), revision: 'r1' },
    { defaults: config(false), load: vi.fn(), save: vi.fn() },
  );
const status = () => within(screen.getByRole('region', { name: 'Update status' }));

describe('Updates (FL-368; the check is FL-80 S-4)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.mocked(checkVersionNow).mockReset();
    vi.mocked(getVersionCheck).mockReset();
    vi.mocked(getVersionCheck).mockResolvedValue({ checkedAt: null, releaseVersion: null });
    websocketStore.serverVersion.set({ major: 3, minor: 2, patch: 0, prerelease: null } as never);
  });

  it('opens on the installed version and says when the server is not looking', async () => {
    draft.store = newStore(false);
    render(NewVersionCheckSettings);

    expect(await status().findByRole('heading', { name: "You're running Frameleaf 3.2.0" })).toBeInTheDocument();
    expect(status().getByText(/Frameleaf is not looking for newer versions/)).toBeInTheDocument();
  });

  it('makes the switch and the frequency one choice that writes the two saved values', async () => {
    const store = newStore(false);
    draft.store = store;
    render(NewVersionCheckSettings);

    const look = within(screen.getByRole('group', { name: 'Look for updates' }));
    expect(look.getByRole('button', { name: 'Never', pressed: true })).toBeInTheDocument();

    await fireEvent.click(look.getByRole('button', { name: 'Every week' }));
    expect(store.draft.newVersionCheck).toMatchObject({ enabled: true, frequency: VersionCheckFrequency.Weekly });

    await fireEvent.click(look.getByRole('button', { name: 'Never' }));
    expect(store.draft.newVersionCheck).toMatchObject({ enabled: false, frequency: VersionCheckFrequency.Weekly });
  });

  it('says where a new version is heard about, as the prototype does (FL-421)', () => {
    draft.store = newStore(true);
    render(NewVersionCheckSettings);

    expect(screen.getByText(en.frameleaf_server_updates_hear)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.frameleaf_settings_area_notifications })).toHaveAttribute(
      'href',
      '/user-settings?area=notifications&section=signals',
    );
  });

  it('says the server is up to date from what it last recorded', async () => {
    draft.store = newStore(true);
    vi.mocked(getVersionCheck).mockResolvedValue({ checkedAt: new Date().toISOString(), releaseVersion: 'v3.2.0' });
    render(NewVersionCheckSettings);

    expect(await status().findByRole('heading', { name: 'Frameleaf 3.2.0 is up to date' })).toBeInTheDocument();
  });

  it('checks now and links the release notes of a newer version', async () => {
    draft.store = newStore(true);
    vi.mocked(checkVersionNow).mockResolvedValue({
      isAvailable: true,
      checkedAt: new Date().toISOString(),
      serverVersion: { major: 3, minor: 2, patch: 0, prerelease: null },
      releaseVersion: { major: 3, minor: 3, patch: 0, prerelease: null },
      type: ReleaseType.Minor,
    } as never);
    render(NewVersionCheckSettings);

    await fireEvent.click(screen.getByRole('button', { name: 'Check now' }));

    expect(await status().findByRole('heading', { name: 'Frameleaf 3.3.0 is available' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /What is new/ })).toHaveAttribute(
      'href',
      'https://github.com/Frameleaf/frameleaf-app/releases?q=frameleaf-v3.3.0&expanded=true',
    );
    expect(screen.getByRole('link', { name: /Before you update/ })).toHaveAttribute(
      'href',
      '/user-settings?area=backups',
    );
  });

  it('says plainly when the check got no answer, and lets it be tried again', async () => {
    draft.store = newStore(true);
    vi.mocked(checkVersionNow).mockRejectedValue(new Error('offline'));
    render(NewVersionCheckSettings);

    await fireEvent.click(screen.getByRole('button', { name: 'Check now' }));

    expect(await status().findByRole('heading', { name: "Couldn't check for updates" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled();
  });

  it('keeps early versions behind Advanced, off unless asked for', async () => {
    const store = newStore(true);
    draft.store = store;
    render(NewVersionCheckSettings);

    const early = within(screen.getByRole('group', { name: 'Get early versions' }));
    expect(early.getByRole('button', { name: 'Off (recommended)', pressed: true })).toBeInTheDocument();
    await fireEvent.click(early.getByRole('button', { name: 'On' }));
    expect(store.draft.newVersionCheck.channel).toBe(ReleaseChannel.ReleaseCandidate);
  });
});
