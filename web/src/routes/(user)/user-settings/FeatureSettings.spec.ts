import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import FeatureSettings from './FeatureSettings.svelte';

const tools = vi.hoisted(() => ({
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
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), beforeNavigate: vi.fn(), goto: vi.fn() }));
vi.mock('$lib/frameleaf/own-preferences-draft', () => ({ createOwnPreferencesDraft: () => tools }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { preferences: {}, user: {} } }));
// FL-522: "Your smart albums" reads the person's albums; none here.
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  getMySmartAlbums: vi.fn().mockResolvedValue({ enabled: false, albums: [] }),
}));

const values = (overrides: Record<string, unknown> = {}) => ({
  'folders.enabled': true,
  'folders.sidebarWeb': true,
  'memories.enabled': true,
  'memories.sidebarWeb': false,
  'memories.duration': 5,
  'people.enabled': false,
  'people.sidebarWeb': true,
  'people.minimumFaces': 3,
  'ratings.enabled': true,
  'sharedLinks.enabled': true,
  'sharedLinks.sidebarWeb': false,
  'tags.enabled': true,
  'tags.sidebarWeb': true,
  'cast.gCastEnabled': false,
  'cast.adminDisabled': false,
  'recentlyAdded.sidebarWeb': false,
  ...overrides,
});

describe('FeatureSettings: Tools & sidebar (ACCOUNT-P4)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tools.draft = values();
    tools.baseline = values();
  });

  it('says back the sidebar the switches make: tools in it and turned on, between the fixed items', () => {
    render(FeatureSettings);

    const preview = screen.getByRole('complementary', { name: 'Your sidebar' });
    const items = within(preview)
      .getAllByRole('listitem')
      .map((item) => item.textContent?.trim());
    // People is in the sidebar but turned off, so it is not there
    expect(items).toEqual(['Photos', 'Explore', 'Map', 'Folders', 'Tags', 'Favorites', 'Albums', 'Trash']);
    expect(within(preview).getByText('You added Folders and Tags. The grey ones are always there.')).toBeVisible();
  });

  it('puts the Memories options under the Memories row while it is on, and none for People while it is off', async () => {
    render(FeatureSettings);

    expect(screen.getByText('Memories options')).toBeInTheDocument();
    expect(screen.queryByText('People options')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: '8 seconds' }));
    expect(tools.set).toHaveBeenCalledWith('memories.duration', 8);
  });
});
