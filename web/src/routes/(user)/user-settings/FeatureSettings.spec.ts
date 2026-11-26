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
const occasions = vi.hoisted(() => ({ getMemoryOccasions: vi.fn() }));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), beforeNavigate: vi.fn(), goto: vi.fn() }));
vi.mock('$lib/frameleaf/own-preferences-draft', () => ({ createOwnPreferencesDraft: () => tools }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { preferences: {}, user: {} } }));
// FL-522: "Your smart albums" reads the person's albums; none here.
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  getMySmartAlbums: vi.fn().mockResolvedValue({ enabled: false, albums: [] }),
  // FL-880: cast until the SDK is regenerated with this endpoint
  getMemoryOccasions: occasions.getMemoryOccasions,
}));

const values = (overrides: Record<string, unknown> = {}) => ({
  'folders.enabled': true,
  'folders.sidebarWeb': true,
  'memories.enabled': true,
  'memories.sidebarWeb': false,
  'memories.duration': 5,
  'memories.occasions': true,
  'memories.occasionRegion': 'auto',
  'people.enabled': false,
  'people.sidebarWeb': true,
  'people.minimumFaces': 3,
  'people.includeArchived': false,
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
    occasions.getMemoryOccasions.mockResolvedValue({ hasParent: true });
    tools.draft = values();
    tools.baseline = values();
  });

  describe("Mother's Day and Father's Day (FL-880)", () => {
    const dates = () => screen.getByRole('combobox', { name: "Use the Mother's Day and Father's Day dates for" });

    it('shows the switch and the dates for the region, and saves another region', async () => {
      render(FeatureSettings);
      await fireEvent.click(screen.getByText('Memories options'));

      expect(screen.getByRole('switch', { name: "Mother's Day and Father's Day" })).toBeChecked();
      expect(
        screen.getByText('A memory of your mother or father on the day, from the people you have added as family.'),
      ).toBeInTheDocument();
      expect(dates()).toHaveValue('us-ca');
      expect(
        screen.getByText("Mother's Day: second Sunday of May. Father's Day: third Sunday of June."),
      ).toBeInTheDocument();
      expect(within(dates()).getAllByRole('option')).toHaveLength(8);

      await fireEvent.change(dates(), { target: { value: 'uk-ie' } });
      expect(tools.set).toHaveBeenCalledWith('memories.occasionRegion', 'uk-ie');
    });

    it('shows the days of a chosen region', async () => {
      tools.draft = values({ 'memories.occasionRegion': 'uk-ie' });
      render(FeatureSettings);
      await fireEvent.click(screen.getByText('Memories options'));

      expect(dates()).toHaveValue('uk-ie');
      expect(
        screen.getByText(
          "Mother's Day: Mothering Sunday, three weeks before Easter Sunday. Father's Day: third Sunday of June.",
        ),
      ).toBeInTheDocument();
    });

    it('hides the dates while the switch is off', async () => {
      tools.draft = values({ 'memories.occasions': false });
      render(FeatureSettings);
      await fireEvent.click(screen.getByText('Memories options'));

      expect(screen.getByRole('switch', { name: "Mother's Day and Father's Day" })).not.toBeChecked();
      expect(screen.queryByRole('combobox', { name: "Use the Mother's Day and Father's Day dates for" })).toBeNull();
    });

    it('holds the switch off with nobody added as a mother or father', async () => {
      occasions.getMemoryOccasions.mockResolvedValue({ hasParent: false });
      render(FeatureSettings);
      await fireEvent.click(screen.getByText('Memories options'));

      expect(
        await screen.findByText("Needs a mother or father. Add one under Family on a person's page."),
      ).toBeVisible();
      const held = screen.getByRole('switch', { name: "Mother's Day and Father's Day" });
      expect(held).toBeDisabled();
      expect(held).not.toBeChecked();
      expect(screen.queryByRole('combobox', { name: "Use the Mother's Day and Father's Day dates for" })).toBeNull();
    });
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

  it('offers to include archived photos in People, off unless chosen (FL-795)', async () => {
    tools.draft = values({ 'people.enabled': true });
    render(FeatureSettings);

    await fireEvent.click(screen.getByText('People options'));
    const archived = screen.getByRole('switch', { name: 'Include archived photos' });
    expect(archived).not.toBeChecked();
    expect(screen.getByText('Show archived photos on person pages and count them in People.')).toBeInTheDocument();
    await fireEvent.click(archived);
    expect(tools.set).toHaveBeenCalledWith('people.includeArchived', true);
  });
});
