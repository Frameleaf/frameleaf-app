import type { AdminConfigDto } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../i18n/en.json';
import ServerSettings from './ServerSettings.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const flags = vi.hoisted(() => ({ configFile: false }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: flags } }));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
}));
const config = (lanDiscovery: boolean) =>
  ({
    server: { name: '', loginPageMessage: '', externalDomain: '', publicUsers: true, lanDiscovery },
  }) as AdminConfigDto;

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  flags.configFile = false;
});

it('edits LAN discovery in the shared draft, saves it against the revision and restores the enabled default', async () => {
  const save = vi.fn().mockResolvedValue({ config: config(false), revision: 'r2' });
  const store = new SystemConfigDraftStore(
    { config: config(true), revision: 'r1' },
    { defaults: config(true), load: vi.fn(), save },
  );
  draft.store = store;
  render(ServerSettings);
  const toggle = screen.getByRole('switch', { name: 'Local network discovery' });
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  await fireEvent.click(toggle);
  expect(store.draft.server.lanDiscovery).toBe(false);
  expect(store.baseline.server.lanDiscovery).toBe(true);
  expect(store.changes).toEqual([{ path: 'server.lanDiscovery', before: true, after: false }]);
  await store.save();
  expect(save).toHaveBeenCalledWith({ expectedRevision: 'r1', config: config(false) });
  store.resetSection(['server']);
  expect(store.draft.server.lanDiscovery).toBe(true);
});

it('keeps the actual control disabled when configuration is managed by a file', async () => {
  flags.configFile = true;
  const store = new SystemConfigDraftStore(
    { config: config(true), revision: 'r1' },
    { defaults: config(true), load: vi.fn(), save: vi.fn() },
  );
  draft.store = store;
  render(ServerSettings);
  const toggle = screen.getByRole('switch', { name: 'Local network discovery' });
  expect(toggle).toBeDisabled();
  await fireEvent.click(toggle);
  expect(store.draft.server.lanDiscovery).toBe(true);
});
