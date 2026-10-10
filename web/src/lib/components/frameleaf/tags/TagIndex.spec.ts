import type { TagResponseDto, TagStatisticsResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { get } from 'svelte/store';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { defaultTagsIndexView, resetTagListExpansion, tagsIndexView } from '$lib/components/frameleaf/tags/tags-view';
import { buildTagTree } from '$lib/frameleaf/tag-tree';
import TagIndex from './TagIndex.svelte';

const navigation = vi.hoisted(() => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/navigation', () => navigation);
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { authenticated: true, user: { id: 'me' } } }));
vi.mock('$lib/utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAssetMediaUrl: ({ id, size }: { id: string; size: string }) => `/media/${id}/${size}`,
}));

const tag = (partial: Partial<TagResponseDto> & { id: string; name: string }): TagResponseDto =>
  ({
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    value: partial.name,
    ...partial,
  }) as TagResponseDto;

const stat = (
  id: string,
  count: number,
  total: number,
  extra: Partial<TagStatisticsResponseDto> = {},
): TagStatisticsResponseDto => ({
  id,
  count,
  total,
  coverAssetIds: [`${id}-1`, `${id}-2`, `${id}-3`, `${id}-4`],
  startDate: '2024-01-05T00:00:00.000Z',
  endDate: '2026-08-23T00:00:00.000Z',
  ...extra,
});

const tags = [
  tag({ id: 'travel', name: 'Travel', color: '#5794f7' }),
  tag({ id: 'canada', name: 'Canada', parentId: 'travel', value: 'Travel/Canada', color: '#5794f7' }),
  tag({ id: 'banff', name: 'Banff', parentId: 'canada', value: 'Travel/Canada/Banff', color: '#0ea5a0' }),
  tag({ id: 'norway', name: 'Norway', parentId: 'travel', value: 'Travel/Norway' }),
  tag({ id: 'iceland', name: 'Iceland', parentId: 'travel', value: 'Travel/Iceland' }),
  tag({ id: 'japan', name: 'Japan', parentId: 'travel', value: 'Travel/Japan' }),
  tag({ id: 'family', name: 'Family', color: '#d9639b' }),
  tag({ id: 'sort', name: 'To sort' }),
];
// An archived or Locked item is never counted by the server, so it adds nothing here either.
const statistics = [
  stat('travel', 0, 60),
  stat('canada', 10, 40),
  stat('banff', 30, 30, { endDate: '2025-02-01T00:00:00.000Z' }),
  stat('norway', 12, 12),
  stat('iceland', 6, 6),
  stat('japan', 2, 2),
  stat('family', 80, 80, { coverAssetIds: ['family-1'], endDate: '2026-10-01T00:00:00.000Z' }),
];

const renderIndex = (list = tags, counts = statistics) => render(TagIndex, { tree: buildTagTree(list, counts) });
const cards = () => screen.queryAllByRole('article');
const cardNames = () => cards().map((card) => card.getAttribute('aria-label'));
const card = (name: string) => screen.getByRole('article', { name });
const find = () => screen.getByRole('searchbox', { name: 'Find a tag' });
const openMenu = async (name: string) => {
  await fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  return screen.getByRole('menu', { name: `Actions for ${name}` });
};

/** The Tags index ("tags as collections"): `design/frameleaf/template/src/TagsV2.jsx`. */
describe('TagIndex', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tagsIndexView.set({ ...defaultTagsIndexView });
    resetTagListExpansion();
  });

  describe('header', () => {
    it('shows the title, the counts line, Find a tag, the sort menu, Cards / List and New tag', () => {
      renderIndex();
      expect(screen.getByRole('heading', { level: 1, name: 'Tags' })).toBeInTheDocument();
      // 8 tags, of which Travel and Canada have tags inside them
      expect(screen.getByText('8 tags · 2 groups')).toBeInTheDocument();
      expect(find()).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sort tags' })).toHaveTextContent('Most used');
      const view = screen.getByRole('group', { name: 'View' });
      expect(within(view).getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(view).getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'New tag' })).toBeInTheDocument();
    });

    it('leaves the groups out of the counts line when no tag has tags inside it', () => {
      renderIndex([tag({ id: 'solo', name: 'Solo' })], []);
      expect(screen.getByText('1 tag')).toBeInTheDocument();
    });
  });

  describe('cards', () => {
    it('draws one card per top-level tag, busiest first, each a link to the tag', () => {
      renderIndex();
      expect(cardNames()).toEqual(['Family', 'Travel', 'To sort']);
      const cover = within(card('Travel')).getByRole('link', { name: 'Open Travel, 60 items' });
      expect(cover).toHaveAttribute('href', '/tags?path=Travel');
      // the name is a second link to the same place, kept out of the tab order
      const name = within(card('Travel')).getByRole('link', { name: 'Travel' });
      expect(name).toHaveAttribute('href', '/tags?path=Travel');
      expect(name).toHaveAttribute('tabindex', '-1');
    });

    it("makes the cover from the tag's newest photos, loaded lazily, and counts its items", () => {
      renderIndex();
      const images = [...card('Travel').querySelectorAll('img')];
      expect(images.map((image) => image.getAttribute('src'))).toEqual([
        '/media/travel-1/thumbnail',
        '/media/travel-2/thumbnail',
        '/media/travel-3/thumbnail',
        '/media/travel-4/thumbnail',
      ]);
      expect(images.every((image) => image.getAttribute('loading') === 'lazy')).toBe(true);
      expect(within(card('Travel')).getByText('60 items')).toBeInTheDocument();
      // a single photo fills the cover
      expect(card('Family').querySelectorAll('img')).toHaveLength(1);
    });

    it('names the tags inside a tag, busiest first, and counts the rest', () => {
      renderIndex();
      expect(within(card('Travel')).getByText('Canada · Norway · Iceland +1')).toBeInTheDocument();
      expect(card('Family').querySelector('.note')).toBeNull();
    });

    it('gives a tag without items an empty tile and says so', () => {
      renderIndex();
      expect(card('To sort').querySelector('img')).toBeNull();
      expect(card('To sort').querySelector('.cover-empty')).not.toBeNull();
      expect(within(card('To sort')).getByText('No items yet')).toBeInTheDocument();
      expect(within(card('To sort')).getByRole('link', { name: 'Open To sort, no items yet' })).toBeInTheDocument();
    });

    it('carries the tag colour as a dot beside the name', () => {
      renderIndex();
      const dot = card('Family').querySelector<HTMLElement>('.tag-dot')!;
      expect(dot.style.getPropertyValue('--tag-color')).toBe('#d9639b');
      expect(card('To sort').querySelector<HTMLElement>('.tag-dot')!.style.getPropertyValue('--tag-color')).toBe(
        '#8b95a1',
      );
    });
  });

  describe('Find a tag', () => {
    it('finds nested tags too and says where each one sits', async () => {
      renderIndex();
      await fireEvent.input(find(), { target: { value: 'AN' } });
      expect(cardNames()).toEqual(['Canada', 'Banff', 'Iceland', 'Japan']);
      expect(within(card('Canada')).getByText('in Travel')).toBeInTheDocument();
      expect(within(card('Banff')).getByText('in Travel › Canada')).toBeInTheDocument();
      expect(screen.getByText('4 tags match')).toBeInTheDocument();
    });

    it('shows a top-level match with the tags inside it, as before the search', async () => {
      renderIndex();
      await fireEvent.input(find(), { target: { value: 'trav' } });
      expect(cardNames()).toEqual(['Travel']);
      expect(within(card('Travel')).getByText('Canada · Norway · Iceland +1')).toBeInTheDocument();
    });

    it('says when nothing matches and clears the search from there', async () => {
      renderIndex();
      await fireEvent.input(find(), { target: { value: 'zzz' } });
      expect(cards()).toHaveLength(0);
      expect(screen.getByRole('heading', { name: 'No tags match “zzz”' })).toBeInTheDocument();
      await fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
      expect(find()).toHaveValue('');
      expect(cardNames()).toEqual(['Family', 'Travel', 'To sort']);
    });
  });

  describe('order and view', () => {
    it('sorts by name or by newest item, and remembers the choice', async () => {
      renderIndex();
      await fireEvent.click(screen.getByRole('button', { name: 'Sort tags' }));
      const menu = screen.getByRole('menu', { name: 'Sort tags' });
      expect(within(menu).getByRole('menuitemcheckbox', { name: 'Most used' })).toHaveAttribute('aria-checked', 'true');
      await fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'A–Z' }));
      expect(cardNames()).toEqual(['Family', 'To sort', 'Travel']);
      expect(get(tagsIndexView)).toEqual({ view: 'cards', sort: 'name' });

      await fireEvent.click(screen.getByRole('button', { name: 'Sort tags' }));
      await fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Newest photos' }));
      expect(cardNames()).toEqual(['Family', 'Travel', 'To sort']);
    });

    it('switches to the list and remembers it for the next visit', async () => {
      const { unmount } = renderIndex();
      await fireEvent.click(screen.getByRole('button', { name: 'List' }));
      expect(screen.getByRole('treegrid', { name: 'Tags' })).toBeInTheDocument();
      expect(cards()).toHaveLength(0);
      expect(get(tagsIndexView)).toEqual({ view: 'list', sort: 'used' });
      unmount();

      renderIndex();
      expect(screen.getByRole('treegrid', { name: 'Tags' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('repairs a remembered view it cannot read', () => {
      tagsIndexView.set({ view: 'columns', sort: 'colour' } as never);
      renderIndex();
      expect(cardNames()).toEqual(['Family', 'Travel', 'To sort']);
    });
  });

  describe('list view', () => {
    const rowNames = () =>
      within(screen.getByRole('treegrid'))
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.querySelector('.label')?.textContent);

    beforeEach(() => tagsIndexView.set({ view: 'list', sort: 'used' }));

    it('opens one level deep, and expands or collapses every branch', async () => {
      renderIndex();
      expect(rowNames()).toEqual(['Family', 'Travel', 'Canada', 'Norway', 'Iceland', 'Japan', 'To sort']);
      await fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
      expect(rowNames()).toContain('Banff');
      await fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
      expect(rowNames()).toEqual(['Family', 'Travel', 'To sort']);
    });

    it('keeps the branches as they were left when the list is shown again', async () => {
      const { unmount } = renderIndex();
      await fireEvent.click(screen.getByRole('button', { name: 'Collapse Travel' }));
      expect(rowNames()).toEqual(['Family', 'Travel', 'To sort']);
      unmount();
      renderIndex();
      expect(rowNames()).toEqual(['Family', 'Travel', 'To sort']);
    });

    it('lists the matches flat while finding, and offers no Expand all', async () => {
      renderIndex();
      await fireEvent.input(find(), { target: { value: 'ban' } });
      expect(rowNames()).toEqual(['Banff']);
      expect(screen.getByText('in Travel › Canada')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Expand all' })).toBeNull();
    });

    it('opens a tag with Enter on its row', async () => {
      renderIndex();
      const row = screen.getByRole('row', { name: /Canada/ });
      row.focus();
      await fireEvent.keyDown(row, { key: 'Enter' });
      expect(navigation.goto).toHaveBeenCalledWith('/tags?path=Travel%2FCanada');
    });
  });

  describe('changing tags', () => {
    it('offers Rename, Colour, New tag inside and Delete in a card menu', async () => {
      renderIndex();
      const menu = await openMenu('Travel');
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((item) => item.textContent?.trim()),
      ).toEqual(['Rename', 'Colour', 'New tag inside', 'Delete']);
    });

    it('creates a top-level tag with a name and a colour, and says so', async () => {
      sdkMock.createTag.mockResolvedValue(tag({ id: 'new', name: 'Pets' }));
      renderIndex();
      await fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
      const dialog = screen.getByRole('dialog', { name: 'New tag' });
      expect(within(dialog).getByRole('combobox', { name: 'Inside' })).toHaveValue('');
      expect(within(dialog).getByRole('radio', { name: 'Grey' })).toHaveAttribute('aria-checked', 'true');
      await fireEvent.input(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: ' Pets ' } });
      await fireEvent.click(within(dialog).getByRole('radio', { name: 'Amber' }));
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
      await waitFor(() =>
        expect(sdkMock.createTag).toHaveBeenCalledWith({
          tagCreateDto: { name: 'Pets', parentId: null, color: '#d9a441' },
        }),
      );
      await waitFor(() => expect(navigation.invalidateAll).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText('Tag Pets created.')).toBeInTheDocument());
      // it stays on the index: a new tag has nothing to show yet
      expect(navigation.goto).not.toHaveBeenCalled();
    });

    it('creates a tag inside another from its card, in that tag’s colour', async () => {
      sdkMock.createTag.mockResolvedValue(
        tag({ id: 'new', name: 'Jasper', parentId: 'canada', value: 'Travel/Canada/Jasper' }),
      );
      renderIndex();
      await fireEvent.click(within(await openMenu('Travel')).getByRole('menuitem', { name: 'New tag inside' }));
      const dialog = screen.getByRole('dialog', { name: 'New tag in Travel' });
      const inside = within(dialog).getByRole('combobox', { name: 'Inside' });
      expect(inside).toHaveValue('travel');
      expect(within(dialog).getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
      // every tag can hold the new one, drawn as the tree
      expect([...inside.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
        'None (top level)',
        'Family',
        'Travel',
        '— Canada',
        '— — Banff',
        '— Norway',
        '— Iceland',
        '— Japan',
        'To sort',
      ]);
      await fireEvent.change(inside, { target: { value: 'canada' } });
      await fireEvent.input(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Jasper' } });
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
      await waitFor(() =>
        expect(sdkMock.createTag).toHaveBeenCalledWith({
          tagCreateDto: { name: 'Jasper', parentId: 'canada', color: '#5794f7' },
        }),
      );
    });

    it('refuses a name with a slash or one a tag in the same place already has', async () => {
      renderIndex();
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
      expect(sdkMock.createTag).not.toHaveBeenCalled();
    });

    it('renames a tag from its card and refuses a name a sibling has', async () => {
      sdkMock.updateTag.mockResolvedValue(tag({ id: 'family', name: 'Kin' }));
      renderIndex();
      await fireEvent.click(within(await openMenu('Family')).getByRole('menuitem', { name: 'Rename' }));
      const dialog = screen.getByRole('dialog', { name: 'Rename tag' });
      const name = within(dialog).getByRole('textbox', { name: 'Name' });
      expect(name).toHaveValue('Family');
      await fireEvent.input(name, { target: { value: 'travel' } });
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('A tag named travel already exists here.');
      expect(sdkMock.updateTag).not.toHaveBeenCalled();

      await fireEvent.input(name, { target: { value: 'Kin' } });
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(sdkMock.updateTag).toHaveBeenCalledWith({ id: 'family', tagUpdateDto: { name: 'Kin' } }),
      );
      await waitFor(() => expect(screen.getByText('Renamed to Kin.')).toBeInTheDocument());
    });

    it('changes a colour by name from the card menu', async () => {
      sdkMock.updateTag.mockResolvedValue(tag({ id: 'family', name: 'Family', color: '#0ea5a0' }));
      renderIndex();
      await fireEvent.click(within(await openMenu('Family')).getByRole('menuitem', { name: 'Colour' }));
      const dialog = screen.getByRole('dialog', { name: 'Tag colour' });
      expect(
        within(dialog)
          .getAllByRole('radio')
          .map((option) => option.getAttribute('aria-label')),
      ).toEqual(['Grey', 'Green', 'Teal', 'Blue', 'Purple', 'Pink', 'Amber', 'Red']);
      expect(within(dialog).getByRole('radio', { name: 'Pink' })).toHaveAttribute('aria-checked', 'true');
      await fireEvent.click(within(dialog).getByRole('radio', { name: 'Teal' }));
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(sdkMock.updateTag).toHaveBeenCalledWith({ id: 'family', tagUpdateDto: { color: '#0ea5a0' } }),
      );
      await waitFor(() => expect(screen.getByText('Colour changed to Teal.')).toBeInTheDocument());
    });

    it('confirms a delete with the tags inside and the items that lose them, as a danger action', async () => {
      sdkMock.deleteTag.mockResolvedValue(undefined as never);
      renderIndex();
      await fireEvent.click(within(await openMenu('Travel')).getByRole('menuitem', { name: 'Delete' }));
      const dialog = screen.getByRole('dialog', { name: 'Delete tag' });
      // every tag under it goes too, not only the ones directly inside
      expect(dialog).toHaveTextContent(
        'Delete Travel and the 5 tags inside it? 60 items will lose these tags but stay in your library.',
      );
      expect(within(dialog).getByText('Travel').tagName).toBe('STRONG');
      const confirm = within(dialog).getByRole('button', { name: 'Delete' });
      expect(confirm).toHaveClass('danger');
      await fireEvent.click(confirm);
      await waitFor(() => expect(sdkMock.deleteTag).toHaveBeenCalledWith({ id: 'travel' }));
      await waitFor(() => expect(navigation.invalidateAll).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText('Tag deleted.')).toBeInTheDocument());
    });

    it('names the whole path of a nested tag in the delete confirmation', async () => {
      renderIndex();
      await fireEvent.input(find(), { target: { value: 'banff' } });
      await fireEvent.click(within(await openMenu('Banff')).getByRole('menuitem', { name: 'Delete' }));
      expect(screen.getByRole('dialog', { name: 'Delete tag' })).toHaveTextContent(
        'Delete Travel › Canada › Banff? 30 items will lose this tag but stay in your library.',
      );
    });

    it('says so when a deleted tag has no items', async () => {
      renderIndex();
      await fireEvent.click(within(await openMenu('To sort')).getByRole('menuitem', { name: 'Delete' }));
      expect(screen.getByRole('dialog', { name: 'Delete tag' })).toHaveTextContent(
        'Delete To sort? No items use this tag.',
      );
    });

    it('keeps the dialog open with the reason when the server refuses, and changes nothing', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      sdkMock.deleteTag.mockRejectedValue(new Error('offline'));
      renderIndex();
      await fireEvent.click(within(await openMenu('Family')).getByRole('menuitem', { name: 'Delete' }));
      const dialog = screen.getByRole('dialog', { name: 'Delete tag' });
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Unable to delete tag');
      expect(navigation.invalidateAll).not.toHaveBeenCalled();
      expect(cardNames()).toEqual(['Family', 'Travel', 'To sort']);
      // and it can be tried again
      expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
    });
  });

  it('shows the empty state for an account without tags, with a way to make the first one', async () => {
    renderIndex([], []);
    expect(screen.getByText('0 tags')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No tags yet' })).toBeInTheDocument();
    expect(screen.getByText('Create a tag to start grouping photos and videos.')).toBeInTheDocument();
    expect(screen.queryByRole('treegrid')).toBeNull();
    const [, inState] = screen.getAllByRole('button', { name: 'New tag' });
    await fireEvent.click(inState);
    expect(screen.getByRole('dialog', { name: 'New tag' })).toBeInTheDocument();
  });
});
