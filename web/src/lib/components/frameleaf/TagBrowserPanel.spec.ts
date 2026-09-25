import type { TagResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TagBrowserPanel from './TagBrowserPanel.svelte';

const navigation = vi.hoisted(() => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/navigation', () => navigation);

const sdk = vi.hoisted(() => ({
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  searchAssets: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock('@immich/sdk', async (importOriginal) => ({ ...(await importOriginal<object>()), ...sdk }));
vi.mock('$lib/utils', () => ({ getAssetUrls: ({ id }: { id: string }) => ({ thumbnail: `/thumb/${id}` }) }));

const tag = (partial: Partial<TagResponseDto> & { id: string; name: string }): TagResponseDto =>
  ({
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    value: partial.name,
    ...partial,
  }) as TagResponseDto;

const tags = [
  tag({ id: 'trips', name: 'trips', color: '#5794f7' }),
  tag({ id: 'rockies', name: 'rockies-2026', parentId: 'trips', value: 'trips/rockies-2026', color: '#5794f7' }),
  tag({ id: 'lakes', name: 'lakes', parentId: 'rockies', value: 'trips/rockies-2026/lakes', color: '#0ea5a0' }),
  tag({ id: 'family', name: 'family', color: '#d9639b' }),
  tag({ id: 'empty', name: 'empty' }),
];
// A hidden (archived or Locked) item tagged "lakes" is never counted by the server, so it adds nothing here.
const statistics = [
  { id: 'trips', count: 1, total: 4 },
  { id: 'rockies', count: 2, total: 3 },
  { id: 'lakes', count: 1, total: 1 },
  { id: 'family', count: 5, total: 5 },
];

const renderPanel = (path = '') => render(TagBrowserPanel, { tags, statistics, path });
const tree = () => screen.getByRole('tree', { name: 'Tags' });
const row = (name: string) =>
  within(tree())
    .getAllByRole('treeitem')
    .find((item) => item.querySelector(':scope > .dv-tree-row .dv-tree-name')?.textContent === name)!;

/** FL-46 TG-1..TG-12 (Tags.jsx:25-494). */
describe('TagBrowserPanel', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdk.searchAssets.mockResolvedValue({ assets: { items: [], total: 0 } });
  });

  it('shows the count line, Find a tag, Expand all and New tag in the header (TG-2, TG-7, TG-8)', () => {
    renderPanel();
    expect(screen.getByRole('heading', { level: 1, name: 'Tags' })).toBeInTheDocument();
    expect(screen.getByText('5 tags · organise with nested tags such as trips / rockies-2026')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Find a tag' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New tag' })).toBeInTheDocument();
  });

  it('draws a tree of top-level tags, busiest first, with totals and colour dots (TG-1, TG-3)', () => {
    renderPanel();
    const items = within(tree()).getAllByRole('treeitem');
    expect(items.map((item) => item.querySelector('.dv-tree-name')?.textContent)).toEqual(['family', 'trips', 'empty']);
    expect(row('trips')).toHaveAttribute('aria-expanded', 'false');
    expect(row('trips').querySelector(':scope > .dv-tree-row small')).toHaveTextContent('4');
    expect(row('empty').querySelector(':scope > .dv-tree-row small')).toHaveTextContent('0');
    expect(row('family').querySelector<HTMLElement>('.dv-tag-dot')!.style.getPropertyValue('--dv-swatch')).toBe(
      '#d9639b',
    );
    // one tab stop
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it('opens a deep link with every ancestor expanded and the tag chosen', () => {
    renderPanel('trips/rockies-2026/lakes');
    expect(row('trips')).toHaveAttribute('aria-expanded', 'true');
    expect(row('rockies-2026')).toHaveAttribute('aria-expanded', 'true');
    expect(row('lakes')).toHaveAttribute('aria-selected', 'true');
    expect(row('lakes')).toHaveAttribute('aria-level', '3');
  });

  it('walks the tree with the keyboard and chooses a tag with Enter (TG-1)', async () => {
    renderPanel();
    const trips = row('trips');
    trips.focus();
    await fireEvent.keyDown(trips, { key: 'ArrowRight' });
    expect(row('trips')).toHaveAttribute('aria-expanded', 'true');
    await fireEvent.keyDown(row('trips'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('rockies-2026'));
    await fireEvent.keyDown(row('rockies-2026'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(row('trips'));
    await fireEvent.keyDown(row('trips'), { key: 'End' });
    expect(document.activeElement).toBe(row('empty'));
    await fireEvent.keyDown(row('empty'), { key: 'Enter' });
    expect(navigation.goto).toHaveBeenCalledWith('/tags?path=empty', { keepFocus: true, noScroll: true });
  });

  it('finds a tag by name and opens the branches above it (TG-4)', async () => {
    renderPanel();
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a tag' }), { target: { value: 'LAK' } });
    await waitFor(() => expect(row('lakes')).toBeDefined());
    expect(row('lakes')).toHaveClass('match');
    expect(row('trips')).not.toHaveClass('match');
  });

  it('expands and collapses every branch (TG-5)', async () => {
    renderPanel();
    await fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(within(tree()).getAllByRole('treeitem')).toHaveLength(5);
    await fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(within(tree()).getAllByRole('treeitem')).toHaveLength(3);
  });

  it('shows the most used tags as chips on the overview (TG-6)', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: 'Choose a tag' })).toBeInTheDocument();
    const chips = within(screen.getByRole('region', { name: 'Tag overview' }))
      .getAllByRole('button')
      .map((chip) => chip.textContent?.replaceAll(/\s+/g, ' ').trim());
    expect(chips).toEqual(['family 5', 'trips 4', 'trips / rockies-2026 3', 'trips / rockies-2026 / lakes 1']);
  });

  it('shows the chosen tag with its breadcrumb, counts, actions, preview and subtags (TG-7, TG-11, TG-12)', async () => {
    renderPanel('trips/rockies-2026');
    const detail = screen.getByRole('region', { name: 'Tag rockies-2026' });
    const crumbs = within(detail).getByRole('navigation', { name: 'Tag path' });
    expect(within(crumbs).getByRole('button', { name: 'Tags' })).toBeInTheDocument();
    expect(within(crumbs).getByRole('button', { name: 'trips' })).toBeInTheDocument();
    expect(within(crumbs).getByText('rockies-2026')).toHaveAttribute('aria-current', 'page');
    expect(within(detail).getByRole('heading', { name: 'rockies-2026' }).nextElementSibling).toHaveTextContent(
      '2 items · 3 including subtags',
    );
    expect(within(detail).getByRole('button', { name: 'Rename' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Change colour' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'More tag actions' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Show all 3 items' })).toBeEnabled();
    expect(
      within(detail).getByText('No items carry this tag yet. Add it from the viewer or a selection.'),
    ).toBeInTheDocument();
    expect(sdk.searchAssets).toHaveBeenCalledWith({
      metadataSearchDto: { tagIds: ['rockies'], visibility: 'timeline', size: 6 },
    });
    await fireEvent.click(within(detail).getByRole('button', { name: /lakes/ }));
    expect(navigation.goto).toHaveBeenCalledWith('/tags?path=trips%2Frockies-2026%2Flakes', {
      keepFocus: true,
      noScroll: true,
    });
  });

  it('disables Show all for a tag without items', () => {
    renderPanel('empty');
    expect(screen.getByRole('button', { name: 'Show all 0 items' })).toBeDisabled();
  });

  it('names the colours in the colour menu and saves the chosen colour (TG-9)', async () => {
    sdk.updateTag.mockResolvedValue(tags[0]);
    renderPanel('trips');
    await fireEvent.click(screen.getByRole('button', { name: 'Change colour' }));
    const menu = screen.getByRole('menu', { name: 'Change colour' });
    const options = within(menu).getAllByRole('menuitemcheckbox');
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      'Grey',
      'Green',
      'Teal',
      'Blue',
      'Purple',
      'Pink',
      'Amber',
      'Red',
    ]);
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Pink' }));
    await waitFor(() =>
      expect(sdk.updateTag).toHaveBeenCalledWith({ id: 'trips', tagUpdateDto: { color: '#d9639b' } }),
    );
    await waitFor(() => expect(screen.getByText('Colour changed to Pink.')).toBeInTheDocument());
  });

  it('moves a nested tag to the top level, and offers it only for a nested tag (TG-8)', async () => {
    sdk.updateTag.mockResolvedValue({ ...tags[1], parentId: undefined, value: 'rockies-2026' });
    const { unmount } = renderPanel('trips');
    await fireEvent.click(screen.getByRole('button', { name: 'More tag actions' }));
    expect(screen.getByRole('menuitem', { name: 'Move to top level' })).toHaveAttribute('aria-disabled', 'true');
    unmount();

    renderPanel('trips/rockies-2026');
    await fireEvent.click(screen.getByRole('button', { name: 'More tag actions' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Move to top level' }));
    await waitFor(() =>
      expect(sdk.updateTag).toHaveBeenCalledWith({ id: 'rockies', tagUpdateDto: { parentId: null } }),
    );
    await waitFor(() =>
      expect(navigation.goto).toHaveBeenCalledWith('/tags?path=rockies-2026', { keepFocus: true, noScroll: true }),
    );
  });

  it('creates a subtag from "New subtag" with its parent and colour (TG-10)', async () => {
    sdk.createTag.mockResolvedValue(
      tag({ id: 'new', name: 'Banff', parentId: 'rockies', value: 'trips/rockies-2026/Banff' }),
    );
    renderPanel('trips/rockies-2026');
    await fireEvent.click(screen.getByRole('button', { name: 'More tag actions' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'New subtag' }));
    const dialog = screen.getByRole('dialog', { name: 'New subtag' });
    expect(within(dialog).getByRole('combobox', { name: 'Parent tag' })).toHaveValue('rockies');
    await fireEvent.input(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: ' Banff ' } });
    await fireEvent.click(within(dialog).getByRole('radio', { name: 'Teal' }));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(sdk.createTag).toHaveBeenCalledWith({
        tagCreateDto: { name: 'Banff', parentId: 'rockies', color: '#0ea5a0' },
      }),
    );
    await waitFor(() => expect(screen.getByText('Tag Banff created.')).toBeInTheDocument());
  });

  it('refuses a name with a slash or one a sibling already has', async () => {
    renderPanel();
    await fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
    const dialog = screen.getByRole('dialog', { name: 'New tag' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await fireEvent.input(name, { target: { value: 'a/b' } });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Give the tag a name without slashes.');
    await fireEvent.input(name, { target: { value: 'FAMILY' } });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('A tag named FAMILY already exists here.'),
    );
    expect(sdk.createTag).not.toHaveBeenCalled();
  });

  it('renames a tag and follows its new address', async () => {
    sdk.updateTag.mockResolvedValue({ ...tags[3], name: 'kin', value: 'kin' });
    renderPanel('family');
    await fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename tag' });
    await fireEvent.input(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'kin' } });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sdk.updateTag).toHaveBeenCalledWith({ id: 'family', tagUpdateDto: { name: 'kin' } }));
    await waitFor(() =>
      expect(navigation.goto).toHaveBeenCalledWith('/tags?path=kin', { keepFocus: true, noScroll: true }),
    );
  });

  it('confirms a delete with the path, subtags and items, as a danger action (TG-11)', async () => {
    sdk.deleteTag.mockResolvedValue(undefined);
    renderPanel('trips');
    await fireEvent.click(screen.getByRole('button', { name: 'More tag actions' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete tag' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete tag' });
    expect(dialog).toHaveTextContent(
      'Delete trips and its 1 subtag? 4 items will lose this tag but stay in your library.',
    );
    expect(within(dialog).getByText('trips').tagName).toBe('STRONG');
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    expect(confirm).toHaveClass('danger');
    await fireEvent.click(confirm);
    await waitFor(() => expect(sdk.deleteTag).toHaveBeenCalledWith({ id: 'trips' }));
    await waitFor(() => expect(navigation.goto).toHaveBeenCalledWith('/tags', { noScroll: true }));
  });

  it('says so when a deleted tag has no items', async () => {
    renderPanel('empty');
    await fireEvent.click(screen.getByRole('button', { name: 'More tag actions' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete tag' }));
    expect(screen.getByRole('dialog', { name: 'Delete tag' })).toHaveTextContent(
      'Delete empty? No items use this tag.',
    );
  });

  it('shows the empty state without tags', () => {
    render(TagBrowserPanel, { tags: [], statistics: [], path: '' });
    expect(screen.getByText('No tags yet')).toBeInTheDocument();
    expect(screen.getByText('0 tags · organise with nested tags such as trips / rockies-2026')).toBeInTheDocument();
  });
});
