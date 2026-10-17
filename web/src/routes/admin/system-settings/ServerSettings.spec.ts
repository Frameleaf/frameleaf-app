import { LoginPageMessageFormat, type AdminConfigDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../i18n/en.json';
import ServerSettings from './ServerSettings.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const flags = vi.hoisted(() => ({ configFile: false }));
const about = vi.hoisted(() => vi.fn());
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: flags } }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  getAboutInfo: about,
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
}));
// The cleaning itself is tested with a browser-like DOM in welcome-message.spec.ts; here it stands in.
vi.mock('$lib/frameleaf/welcome-message', () => ({
  cleanWelcomeHtml: (html: string) => html.replaceAll(/<img[^>]*>|<script[\s\S]*?<\/script>/gi, ''),
}));
const config = (lanDiscovery: boolean, server: Partial<AdminConfigDto['server']> = {}) =>
  ({
    server: {
      name: '',
      loginPageMessage: '',
      loginPageMessageFormat: LoginPageMessageFormat.Plain,
      timeZone: '',
      externalDomain: '',
      publicUsers: true,
      lanDiscovery,
      ...server,
    },
  }) as AdminConfigDto;
const open = (saved: AdminConfigDto) => {
  const store = new SystemConfigDraftStore(
    { config: saved, revision: 'r1' },
    { defaults: config(true), load: vi.fn(), save: vi.fn() },
  );
  draft.store = store;
  render(ServerSettings);
  return store;
};

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  flags.configFile = false;
  about.mockReset().mockRejectedValue(new Error('offline'));
});

it('shows what people will see as the name and welcome are typed (ADMIN-P7)', async () => {
  open(config(true));
  const preview = screen.getByRole('complementary', { name: 'What people will see' });

  // Unnamed, the phone app lists "This server", and the sign-in page has no message.
  expect(within(preview).getByText('This server')).toBeInTheDocument();
  expect(within(preview).getByText('No welcome message')).toBeInTheDocument();

  await fireEvent.input(screen.getByRole('textbox', { name: 'Server name' }), { target: { value: 'Rivera photos' } });
  await fireEvent.input(screen.getByRole('textbox', { name: 'Welcome message' }), {
    target: { value: 'Hello, family.' },
  });
  expect(within(preview).getByText('Rivera photos')).toBeInTheDocument();
  expect(within(preview).getByText('Hello, family.')).toBeInTheDocument();
});

describe('time zone (FL-426)', () => {
  it("starts as the computer's own zone, named, and saves a chosen one", async () => {
    about.mockResolvedValue({ systemTimeZone: 'America/Edmonton' });
    const store = open(config(true));
    const zone = screen.getByRole('combobox', { name: 'Time zone' });
    expect(zone).toHaveValue('');
    expect(
      await within(zone).findByRole('option', { name: /^Same as this computer: Edmonton \(/ }),
    ).toBeInTheDocument();

    await fireEvent.change(zone, { target: { value: 'Europe/London' } });
    expect(store.draft.server.timeZone).toBe('Europe/London');
    expect(store.changes).toEqual([{ path: 'server.timeZone', before: '', after: 'Europe/London' }]);
  });

  it("still offers the computer's own zone when the server does not name it", () => {
    open(config(true));
    const zone = screen.getByRole('combobox', { name: 'Time zone' });
    expect(within(zone).getByRole('option', { name: 'Same as this computer' })).toBeInTheDocument();
  });

  it('shows a saved zone the list leaves out as chosen', () => {
    open(config(true, { timeZone: 'Etc/GMT+5' }));
    expect(screen.getByRole('combobox', { name: 'Time zone' })).toHaveValue('Etc/GMT+5');
  });
});

describe('welcome message: plain text or web formatting (FL-426)', () => {
  const message =
    'Hello, <b>family</b>.<img src="https://tracker.example/x.png" onerror="alert(1)"><script>alert(2)</script>';

  it('shows plain text exactly as typed, tags and all', () => {
    open(config(true, { loginPageMessage: message }));
    const preview = screen.getByRole('complementary', { name: 'What people will see' });
    expect(within(preview).getByText(message)).toBeInTheDocument();
    expect(preview.querySelector('b')).toBeNull();
  });

  it('shows web formatting cleaned, without scripts, handlers or remote pictures', async () => {
    const store = open(config(true, { loginPageMessage: message }));
    const choice = screen.getByRole('group', { name: 'Welcome message is', hidden: true });
    await fireEvent.click(within(choice).getByRole('button', { name: 'Web formatting', hidden: true }));
    expect(store.draft.server.loginPageMessageFormat).toBe(LoginPageMessageFormat.Html);

    const preview = screen.getByRole('complementary', { name: 'What people will see' });
    expect(preview.querySelector('b')).toHaveTextContent('family');
    expect(preview.querySelector('img, script, [onerror]')).toBeNull();
    expect(preview).not.toHaveTextContent('alert');
  });
});

it('edits LAN discovery in the shared draft, saves it against the revision and restores the enabled default', async () => {
  const save = vi.fn().mockResolvedValue({ config: config(false), revision: 'r2' });
  const store = new SystemConfigDraftStore(
    { config: config(true), revision: 'r1' },
    { defaults: config(true), load: vi.fn(), save },
  );
  draft.store = store;
  render(ServerSettings);
  const toggle = screen.getByRole('switch', { name: 'Let phones on your Wi-Fi find this server' });
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

it('keeps the actual controls disabled when configuration is managed by a file', async () => {
  flags.configFile = true;
  const store = open(config(true));
  const toggle = screen.getByRole('switch', { name: 'Let phones on your Wi-Fi find this server' });
  expect(toggle).toBeDisabled();
  await fireEvent.click(toggle);
  expect(store.draft.server.lanDiscovery).toBe(true);
  expect(screen.getByRole('combobox', { name: 'Time zone' })).toBeDisabled();
});
