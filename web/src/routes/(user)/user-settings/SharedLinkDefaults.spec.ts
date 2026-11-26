import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import SharedLinkDefaults from './SharedLinkDefaults.svelte';

const choice = vi.hoisted(() => ({
  draft: {} as Record<string, unknown>,
  baseline: {} as Record<string, unknown>,
  dirty: false,
  stale: false,
  loading: false,
  saving: false,
  error: null,
  notice: null,
  set: vi.fn(),
  follow: vi.fn(),
  cancel: vi.fn(),
  save: vi.fn(),
  loadLatest: vi.fn(),
}));
const server = vi.hoisted(() => ({ value: { sharedLinkDefaultExpiryDays: null as number | null } }));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), beforeNavigate: vi.fn(), goto: vi.fn() }));
vi.mock('$lib/frameleaf/own-preferences-draft', () => ({ createOwnPreferencesDraft: () => choice }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { preferences: {}, user: {} } }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({ serverConfigManager: server }));

const select = () => screen.getByRole('combobox', { name: en.frameleaf_link_expiry_label });

describe('SharedLinkDefaults (FL-922)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    choice.draft = { 'sharedLinks.defaultExpiryDays': null };
    server.value.sharedLinkDefaultExpiryDays = null;
  });

  it('starts on Never when neither the person nor the server set a default, and takes a choice', async () => {
    render(SharedLinkDefaults);

    expect(select()).toHaveValue('none');
    expect(screen.getByRole('option', { name: 'Never' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '1 year' })).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_link_expiry_help_never)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_link_expiry_server_never)).toBeInTheDocument();

    await fireEvent.change(select(), { target: { value: '7' } });
    expect(choice.set).toHaveBeenCalledWith('sharedLinks.defaultExpiryDays', 7);
  });

  it('says what the server sets when the person has no choice of their own', () => {
    server.value.sharedLinkDefaultExpiryDays = 30;
    render(SharedLinkDefaults);

    expect(screen.getByRole('option', { name: 'This server’s default (30 days)' })).toBeInTheDocument();
    expect(screen.getByText(/follow this server’s default and close 30 days after you make them/)).toBeInTheDocument();
    expect(screen.getByText(/This server sets new links to close after 30 days\./)).toBeInTheDocument();
  });

  it('shows the person’s own choice, a value the list does not offer included, and can go back to no choice', async () => {
    choice.draft = { 'sharedLinks.defaultExpiryDays': 14 };
    render(SharedLinkDefaults);

    expect(select()).toHaveValue('14');
    expect(screen.getByText(/Each new link closes 14 days after you make it/)).toBeInTheDocument();
    await fireEvent.change(select(), { target: { value: 'none' } });
    expect(choice.set).toHaveBeenCalledWith('sharedLinks.defaultExpiryDays', null);
  });
});
