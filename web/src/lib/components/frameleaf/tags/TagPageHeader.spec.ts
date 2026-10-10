import type { TagResponseDto, TagStatisticsResponseDto } from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { buildTagTree } from '$lib/frameleaf/tag-tree';
import TagPageHeader from './TagPageHeader.svelte';

const navigation = vi.hoisted(() => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/navigation', () => navigation);
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
  startDate: string,
  endDate: string,
): TagStatisticsResponseDto => ({
  id,
  count,
  total,
  coverAssetIds: [`${id}-1`, `${id}-2`, `${id}-3`, `${id}-4`],
  startDate,
  endDate,
});

const tags = [
  tag({ id: 'travel', name: 'Travel', color: '#5794f7' }),
  tag({ id: 'canada', name: 'Canada', parentId: 'travel', value: 'Travel/Canada', color: '#5794f7' }),
  tag({ id: 'banff', name: 'Banff', parentId: 'canada', value: 'Travel/Canada/Banff', color: '#0ea5a0' }),
  tag({ id: 'jasper', name: 'Jasper', parentId: 'canada', value: 'Travel/Canada/Jasper' }),
  tag({ id: 'norway', name: 'Norway', parentId: 'travel', value: 'Travel/Norway' }),
  tag({ id: 'nature', name: 'Nature' }),
  tag({ id: 'nature-canada', name: 'canada', parentId: 'nature', value: 'Nature/canada' }),
  tag({ id: 'sort', name: 'To sort' }),
];
const statistics = [
  stat('travel', 0, 248, '2023-07-22T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
  stat('canada', 98, 150, '2026-08-02T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
  stat('banff', 30, 30, '2026-08-02T00:00:00.000Z', '2026-08-09T00:00:00.000Z'),
  stat('jasper', 22, 22, '2026-08-10T00:00:00.000Z', '2026-08-23T00:00:00.000Z'),
  stat('norway', 50, 50, '2025-06-01T00:00:00.000Z', '2025-07-17T00:00:00.000Z'),
];

const tree = buildTagTree(tags, statistics);
const renderHeader = (id: string) => render(TagPageHeader, { node: tree.byId.get(id)!, tree });
const header = (name: string) => screen.getByRole('region', { name: `Tag ${name}` });
const toolbar = () => screen.getByRole('toolbar', { name: 'Tag actions' });
const openMore = async () => {
  await fireEvent.click(screen.getByRole('button', { name: 'More tag actions' }));
  return screen.getByRole('menu', { name: 'More tag actions' });
};
const follows = { replaceState: true, invalidateAll: true, keepFocus: true, noScroll: true };

/** The head of a tag's page: `TagPage` in `design/frameleaf/template/src/TagsV2.jsx`. */
describe('TagPageHeader', () => {
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
    vi.spyOn(toastManager, 'primary').mockImplementation(() => undefined as never);
  });

  describe('what it shows', () => {
    it('leads back through the tags above it, ending on the tag itself', () => {
      renderHeader('banff');
      const crumbs = within(header('Banff')).getByRole('navigation', { name: 'Tag path' });
      expect(
        within(crumbs)
          .getAllByRole('link')
          .map((link) => [link.textContent, link.getAttribute('href')]),
      ).toEqual([
        ['Tags', '/tags'],
        ['Travel', '/tags?path=Travel'],
        ['Canada', '/tags?path=Travel%2FCanada'],
      ]);
      expect(within(crumbs).getByText('Banff')).toHaveAttribute('aria-current', 'page');
    });

    it('names the tag as the page heading and counts its items, the tags inside and the years', () => {
      renderHeader('travel');
      // the heading is the tag's own name, not the name of the button it also is
      expect(screen.getByRole('heading', { level: 1, name: 'Travel' })).toBeInTheDocument();
      expect(header('Travel').querySelector('.summary')).toHaveTextContent('248 items 2 tags inside 2023 – 2026');
    });

    it('shortens the dates to one month when everything was taken in it, and drops what does not apply', () => {
      const { unmount } = renderHeader('banff');
      expect(header('Banff').querySelector('.summary')).toHaveTextContent(/^30 items\s*Aug 2026$/);
      unmount();
      renderHeader('sort');
      expect(header('To sort').querySelector('.summary')).toHaveTextContent(/^0 items$/);
    });

    it('offers Tag photos, Colour, Move and a "…" menu with New tag inside and Delete tag', async () => {
      renderHeader('canada');
      expect(
        within(toolbar())
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim()),
      ).toEqual(['Tag photos', 'Colour', 'Move', 'More tag actions']);
      const menu = await openMore();
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((item) => item.textContent?.trim()),
      ).toEqual(['New tag inside', 'Delete tag']);
    });

    it('shows the tags inside as small cards that open them, and a tile to add one', () => {
      renderHeader('canada');
      const inside = screen.getByRole('region', { name: 'Tags inside' });
      expect(within(inside).getByText('2 tags')).toBeInTheDocument();
      expect(
        within(inside)
          .getAllByRole('article')
          .map((card) => card.getAttribute('aria-label')),
      ).toEqual(['Banff', 'Jasper']);
      expect(within(inside).getByRole('link', { name: 'Open Banff, 30 items' })).toHaveAttribute(
        'href',
        '/tags?path=Travel%2FCanada%2FBanff',
      );
      expect(within(inside).getByRole('button', { name: 'New tag here' })).toBeInTheDocument();
    });

    it('has no "Tags inside" row for a tag with none', () => {
      renderHeader('banff');
      expect(screen.queryByRole('region', { name: 'Tags inside' })).toBeNull();
    });
  });

  describe('colour', () => {
    it('opens the eight colours from the tile and applies the chosen one straight away', async () => {
      sdkMock.updateTag.mockResolvedValue(tag({ id: 'canada', name: 'Canada', color: '#d9639b' }));
      renderHeader('canada');
      const tile = screen.getByRole('button', { name: 'Change colour' });
      expect(tile).toHaveAttribute('aria-expanded', 'false');
      expect(tile.style.getPropertyValue('--tag-color')).toBe('#5794f7');
      await fireEvent.click(tile);
      const popup = screen.getByRole('dialog', { name: 'Tag colour' });
      expect(within(popup).getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
      await waitFor(() => expect(document.activeElement).toBe(within(popup).getByRole('radio', { name: 'Blue' })));

      await fireEvent.click(within(popup).getByRole('radio', { name: 'Pink' }));
      await waitFor(() =>
        expect(sdkMock.updateTag).toHaveBeenCalledWith({ id: 'canada', tagUpdateDto: { color: '#d9639b' } }),
      );
      await waitFor(() => expect(navigation.invalidateAll).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText('Colour changed to Pink.')).toBeInTheDocument());
      expect(screen.queryByRole('dialog', { name: 'Tag colour' })).toBeNull();
      expect(document.activeElement).toBe(tile);
    });

    it('opens the same colours from the Colour button, and moves through them with the arrow keys', async () => {
      renderHeader('canada');
      const button = within(toolbar()).getByRole('button', { name: 'Colour' });
      await fireEvent.click(button);
      const popup = screen.getByRole('dialog', { name: 'Tag colour' });
      const blue = within(popup).getByRole('radio', { name: 'Blue' });
      await waitFor(() => expect(document.activeElement).toBe(blue));
      await fireEvent.keyDown(blue, { key: 'ArrowRight' });
      expect(document.activeElement).toBe(within(popup).getByRole('radio', { name: 'Purple' }));
      await fireEvent.keyDown(document.activeElement!, { key: 'Home' });
      expect(document.activeElement).toBe(within(popup).getByRole('radio', { name: 'Grey' }));
      // passing over a colour chooses nothing
      expect(sdkMock.updateTag).not.toHaveBeenCalled();
    });

    it('closes the colours with Escape, hands focus back, and keeps the key from the page', async () => {
      renderHeader('canada');
      const onPageKey = vi.fn();
      addEventListener('keydown', onPageKey);
      const tile = screen.getByRole('button', { name: 'Change colour' });
      await fireEvent.click(tile);
      await waitFor(() => expect(screen.getByRole('radio', { name: 'Blue' })).toHaveFocus());
      await fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      removeEventListener('keydown', onPageKey);
      expect(screen.queryByRole('dialog', { name: 'Tag colour' })).toBeNull();
      expect(document.activeElement).toBe(tile);
      expect(onPageKey).not.toHaveBeenCalled();
    });

    it('says so in the usual toast when the colour could not be saved, and changes nothing', async () => {
      const toast = vi.spyOn(toastManager, 'danger').mockImplementation(() => undefined as never);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      sdkMock.updateTag.mockRejectedValue(new Error('offline'));
      renderHeader('canada');
      await fireEvent.click(screen.getByRole('button', { name: 'Change colour' }));
      await fireEvent.click(screen.getByRole('radio', { name: 'Red' }));
      await waitFor(() => expect(toast).toHaveBeenCalled());
      expect(navigation.invalidateAll).not.toHaveBeenCalled();
      expect(header('Canada').querySelector('.status')?.textContent).toBe('');
    });
  });

  describe('rename in place', () => {
    const startEdit = async () => {
      await fireEvent.click(screen.getByTitle('Edit tag name'));
      return screen.getByRole('textbox', { name: 'Edit tag name' });
    };

    it('saves the new name and follows the tag to its new address without leaving the old one behind', async () => {
      sdkMock.updateTag.mockResolvedValue(tag({ id: 'canada', name: 'Kanada', value: 'Travel/Kanada' }));
      renderHeader('canada');
      const field = await startEdit();
      expect(field).toHaveValue('Canada');
      expect(field).toHaveAttribute('maxlength', '60');
      await fireEvent.input(field, { target: { value: ' Kanada ' } });
      await fireEvent.keyDown(field, { key: 'Enter' });
      await waitFor(() =>
        expect(sdkMock.updateTag).toHaveBeenCalledWith({ id: 'canada', tagUpdateDto: { name: 'Kanada' } }),
      );
      await waitFor(() => expect(navigation.goto).toHaveBeenCalledWith('/tags?path=Travel%2FKanada', follows));
      await waitFor(() => expect(screen.getByText('Renamed to Kanada.')).toBeInTheDocument());
      // the field gives way to the heading again, which takes focus back
      await waitFor(() => expect(screen.getByTitle('Edit tag name')).toHaveFocus());
    });

    it('refuses a name a tag in the same place already has, and keeps what was typed', async () => {
      renderHeader('norway');
      const field = await startEdit();
      await fireEvent.input(field, { target: { value: 'CANADA' } });
      await fireEvent.keyDown(field, { key: 'Enter' });
      expect(await screen.findByRole('alert')).toHaveTextContent('A tag named CANADA already exists here.');
      expect(screen.getByRole('textbox', { name: 'Edit tag name' })).toHaveValue('CANADA');
      expect(screen.getByRole('textbox', { name: 'Edit tag name' })).toHaveAttribute('aria-invalid', 'true');
      expect(sdkMock.updateTag).not.toHaveBeenCalled();
    });

    it('refuses a name with a slash', async () => {
      renderHeader('norway');
      const field = await startEdit();
      await fireEvent.input(field, { target: { value: 'Oslo/Bergen' } });
      await fireEvent.keyDown(field, { key: 'Enter' });
      expect(await screen.findByRole('alert')).toHaveTextContent('Give the tag a name without slashes.');
      expect(sdkMock.updateTag).not.toHaveBeenCalled();
    });

    it('abandons the edit with Escape, clears the refusal and hands focus back', async () => {
      renderHeader('norway');
      const field = await startEdit();
      await fireEvent.input(field, { target: { value: 'canada' } });
      await fireEvent.keyDown(field, { key: 'Enter' });
      await screen.findByRole('alert');
      await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit tag name' }), { key: 'Escape' });
      await waitFor(() => expect(screen.getByTitle('Edit tag name')).toHaveFocus());
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Norway');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(sdkMock.updateTag).not.toHaveBeenCalled();
    });

    it('saves nothing when the name is unchanged or emptied', async () => {
      renderHeader('norway');
      let field = await startEdit();
      await fireEvent.keyDown(field, { key: 'Enter' });
      await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit tag name' })).toBeNull());
      field = await startEdit();
      await fireEvent.input(field, { target: { value: ' '.repeat(3) } });
      await fireEvent.keyDown(field, { key: 'Enter' });
      await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Norway'));
      expect(sdkMock.updateTag).not.toHaveBeenCalled();
    });

    it('keeps the field open and says so in the usual toast when the save fails', async () => {
      const toast = vi.spyOn(toastManager, 'danger').mockImplementation(() => undefined as never);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      sdkMock.updateTag.mockRejectedValue(new Error('offline'));
      renderHeader('norway');
      const field = await startEdit();
      await fireEvent.input(field, { target: { value: 'Norge' } });
      await fireEvent.keyDown(field, { key: 'Enter' });
      await waitFor(() => expect(toast).toHaveBeenCalled());
      expect(screen.getByRole('textbox', { name: 'Edit tag name' })).toHaveValue('Norge');
      expect(navigation.goto).not.toHaveBeenCalled();
    });
  });

  describe('move', () => {
    const openMove = async (name: string) => {
      await fireEvent.click(within(toolbar()).getByRole('button', { name: 'Move' }));
      const dialog = screen.getByRole('dialog', { name: `Move “${name}”` });
      return { dialog, inside: within(dialog).getByRole('combobox', { name: 'Inside' }) as HTMLSelectElement };
    };

    it('offers the top level and every tag except the tag itself and the tags inside it', async () => {
      renderHeader('canada');
      const { inside } = await openMove('Canada');
      expect(inside).toHaveValue('travel');
      expect([...inside.options].map((option) => option.textContent)).toEqual([
        'None (top level)',
        'Travel',
        '— Norway',
        'Nature',
        '— canada',
        'To sort',
      ]);
    });

    it('moves the tag under another one and follows it to its new address', async () => {
      sdkMock.updateTag.mockResolvedValue(
        tag({ id: 'canada', name: 'Canada', parentId: 'sort', value: 'To sort/Canada' }),
      );
      renderHeader('canada');
      const { dialog, inside } = await openMove('Canada');
      await fireEvent.change(inside, { target: { value: 'sort' } });
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
      await waitFor(() =>
        expect(sdkMock.updateTag).toHaveBeenCalledWith({ id: 'canada', tagUpdateDto: { parentId: 'sort' } }),
      );
      await waitFor(() => expect(navigation.goto).toHaveBeenCalledWith('/tags?path=To%20sort%2FCanada', follows));
      await waitFor(() => expect(screen.getByText('Tag moved.')).toBeInTheDocument());
    });

    it('moves a nested tag to the top level', async () => {
      sdkMock.updateTag.mockResolvedValue(tag({ id: 'banff', name: 'Banff', value: 'Banff' }));
      renderHeader('banff');
      const { dialog, inside } = await openMove('Banff');
      await fireEvent.change(inside, { target: { value: '' } });
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
      await waitFor(() =>
        expect(sdkMock.updateTag).toHaveBeenCalledWith({ id: 'banff', tagUpdateDto: { parentId: null } }),
      );
      await waitFor(() => expect(navigation.goto).toHaveBeenCalledWith('/tags?path=Banff', follows));
    });

    it('refuses a place that already has a tag of that name', async () => {
      renderHeader('canada');
      const { dialog, inside } = await openMove('Canada');
      await fireEvent.change(inside, { target: { value: 'nature' } });
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('A tag named Canada already exists here.');
      expect(sdkMock.updateTag).not.toHaveBeenCalled();
    });

    it('does nothing when the tag is left where it is', async () => {
      renderHeader('canada');
      const { dialog } = await openMove('Canada');
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Move “Canada”' })).toBeNull());
      expect(sdkMock.updateTag).not.toHaveBeenCalled();
      expect(navigation.goto).not.toHaveBeenCalled();
    });

    it('shows what the server says when it refuses the move', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      sdkMock.updateTag.mockRejectedValue(new Error('offline'));
      renderHeader('canada');
      const { dialog, inside } = await openMove('Canada');
      await fireEvent.change(inside, { target: { value: 'sort' } });
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Unable to save tag');
      expect(navigation.goto).not.toHaveBeenCalled();
    });
  });

  describe('new tags and delete', () => {
    it('creates a tag inside this one from the menu or the "New tag here" tile, and stays here', async () => {
      sdkMock.createTag.mockResolvedValue(
        tag({ id: 'new', name: 'Lake Louise', parentId: 'canada', value: 'Travel/Canada/Lake Louise' }),
      );
      renderHeader('canada');
      await fireEvent.click(within(await openMore()).getByRole('menuitem', { name: 'New tag inside' }));
      let dialog = screen.getByRole('dialog', { name: 'New tag in Canada' });
      expect(within(dialog).getByRole('combobox', { name: 'Inside' })).toHaveValue('canada');
      await fireEvent.input(within(dialog).getByRole('textbox', { name: 'Name' }), {
        target: { value: 'Lake Louise' },
      });
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
      await waitFor(() =>
        expect(sdkMock.createTag).toHaveBeenCalledWith({
          tagCreateDto: { name: 'Lake Louise', parentId: 'canada', color: '#5794f7' },
        }),
      );
      await waitFor(() => expect(screen.getByText('Tag Lake Louise created.')).toBeInTheDocument());
      expect(navigation.invalidateAll).toHaveBeenCalled();
      expect(navigation.goto).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      await fireEvent.click(screen.getByRole('button', { name: 'New tag here' }));
      dialog = screen.getByRole('dialog', { name: 'New tag in Canada' });
      expect(within(dialog).getByRole('combobox', { name: 'Inside' })).toHaveValue('canada');
    });

    it('deletes the tag after confirming, goes up one level and says so in a toast', async () => {
      sdkMock.deleteTag.mockResolvedValue(undefined as never);
      renderHeader('canada');
      await fireEvent.click(within(await openMore()).getByRole('menuitem', { name: 'Delete tag' }));
      const dialog = screen.getByRole('dialog', { name: 'Delete tag' });
      expect(dialog).toHaveTextContent(
        'Delete Travel › Canada and the 2 tags inside it? 150 items will lose these tags but stay in your library.',
      );
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(sdkMock.deleteTag).toHaveBeenCalledWith({ id: 'canada' }));
      await waitFor(() =>
        expect(navigation.goto).toHaveBeenCalledWith('/tags?path=Travel', { replaceState: true, invalidateAll: true }),
      );
      await waitFor(() => expect(toastManager.primary).toHaveBeenCalledWith('Tag deleted.'));
    });

    it('goes back to the index after deleting a top-level tag', async () => {
      sdkMock.deleteTag.mockResolvedValue(undefined as never);
      renderHeader('sort');
      await fireEvent.click(within(await openMore()).getByRole('menuitem', { name: 'Delete tag' }));
      await fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Delete tag' })).getByRole('button', { name: 'Delete' }),
      );
      await waitFor(() =>
        expect(navigation.goto).toHaveBeenCalledWith('/tags', { replaceState: true, invalidateAll: true }),
      );
    });
  });

  it('sends "Tag photos" to the library, where photos are picked, and says what to do there', async () => {
    renderHeader('canada');
    await fireEvent.click(within(toolbar()).getByRole('button', { name: 'Tag photos' }));
    await waitFor(() => expect(navigation.goto).toHaveBeenCalledWith('/photos'));
    await waitFor(() =>
      expect(toastManager.primary).toHaveBeenCalledWith(
        'Select photos, then choose Tag in the selection bar and pick Canada.',
      ),
    );
  });

  describe('on a phone', () => {
    const phoneWidth = (query: string) => ({
      matches: query.includes('max-width: 700px'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    beforeEach(() => {
      vi.mocked(matchMedia).mockImplementation(phoneWidth as never);
    });

    afterEach(() => {
      vi.mocked(matchMedia).mockImplementation(((query: string) => ({
        ...phoneWidth(query),
        matches: false,
      })) as never);
    });

    it('keeps Tag photos in the row and moves Colour and Move into "…"', async () => {
      renderHeader('canada');
      expect(
        within(toolbar())
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim()),
      ).toEqual(['Tag photos', 'More tag actions']);
      const menu = await openMore();
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((item) => item.textContent?.trim()),
      ).toEqual(['Colour', 'Move', 'New tag inside', 'Delete tag']);
      await fireEvent.click(within(menu).getByRole('menuitem', { name: 'Colour' }));
      const dialog = screen.getByRole('dialog', { name: 'Tag colour' });
      expect(within(dialog).getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    });
  });
});
