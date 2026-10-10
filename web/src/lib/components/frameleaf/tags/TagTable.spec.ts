import type { TagResponseDto, TagStatisticsResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTagTree, findTags, visibleTagRows, type FrameleafTagNode } from '$lib/frameleaf/tag-tree';
import TagTable from './TagTable.svelte';

const tag = (partial: Partial<TagResponseDto> & { id: string; name: string }): TagResponseDto =>
  ({
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    value: partial.name,
    ...partial,
  }) as TagResponseDto;

const stat = (id: string, total: number, endDate: string): TagStatisticsResponseDto => ({
  id,
  count: total,
  total,
  coverAssetIds: [`${id}-1`],
  startDate: '2023-01-01T00:00:00.000Z',
  endDate,
});

const tree = buildTagTree(
  [
    tag({ id: 'travel', name: 'Travel' }),
    tag({ id: 'canada', name: 'Canada', parentId: 'travel', value: 'Travel/Canada' }),
    tag({ id: 'banff', name: 'Banff', parentId: 'canada', value: 'Travel/Canada/Banff' }),
    tag({ id: 'norway', name: 'Norway', parentId: 'travel', value: 'Travel/Norway' }),
    tag({ id: 'family', name: 'Family' }),
    tag({ id: 'sort', name: 'To sort' }),
  ],
  [
    stat('travel', 1248, '2026-08-23T00:00:00.000Z'),
    stat('canada', 40, '2026-08-23T00:00:00.000Z'),
    stat('banff', 30, '2025-02-01T00:00:00.000Z'),
    stat('norway', 12, '2025-07-17T00:00:00.000Z'),
    stat('family', 80, '2026-10-01T00:00:00.000Z'),
  ],
);

// What the index passes: the row's "…" menu. Here it is a bare trigger, which is all the table looks at.
const menu = createRawSnippet<[FrameleafTagNode]>((node) => ({
  render: () => `<button type="button" aria-haspopup="menu" aria-label="Actions for ${node().name}">…</button>`,
}));

const onToggle = vi.fn();
const onOpen = vi.fn();

const renderTable = (open: string[] = ['travel']) => {
  const expanded = new Set(open);
  return render(TagTable, { rows: visibleTagRows(tree, expanded), expanded, onToggle, onOpen, menu });
};
const grid = () => screen.getByRole('treegrid', { name: 'Tags' });
const rows = () => within(grid()).getAllByRole('row').slice(1);
const row = (name: string) => rows().find((item) => item.querySelector('.label')?.textContent === name)!;
const cells = (name: string) =>
  within(row(name))
    .getAllByRole('gridcell')
    .slice(0, 4)
    .map((cell) => cell.textContent?.replaceAll(/\s+/g, ' ').trim());

/** The list view of the Tags index: `TagTable` in `design/frameleaf/template/src/TagsV2.jsx`. */
describe('TagTable', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => vi.clearAllMocks());

  it('names its columns for what they hold', () => {
    renderTable();
    expect(
      within(grid())
        .getAllByRole('columnheader')
        .map((header) => header.textContent?.trim()),
    ).toEqual(['Tag', 'Items', 'Tags inside', 'Newest item', 'Actions']);
  });

  it('draws the tree as rows with their level, and marks which branches are open', () => {
    renderTable(['travel']);
    expect(rows().map((item) => item.querySelector('.label')?.textContent)).toEqual([
      'Travel',
      'Canada',
      'Norway',
      'Family',
      'To sort',
    ]);
    expect(row('Travel')).toHaveAttribute('aria-level', '1');
    expect(row('Travel')).toHaveAttribute('aria-expanded', 'true');
    expect(row('Canada')).toHaveAttribute('aria-level', '2');
    expect(row('Canada')).toHaveAttribute('aria-expanded', 'false');
    // a tag with nothing inside it is not a branch
    expect(row('Norway')).not.toHaveAttribute('aria-expanded');
    expect(within(row('Norway')).queryByRole('button', { name: /Expand|Collapse/ })).toBeNull();
  });

  it('shows items, tags inside and the day of the newest item, with a dash where there is none', () => {
    renderTable();
    // the capture day is a date at UTC midnight and is shown as that day whatever the time zone here
    expect(cells('Travel')).toEqual(['Travel', '1,248', '2', 'Aug 23, 2026']);
    expect(cells('Norway')).toEqual(['Norway', '12', '–', 'Jul 17, 2025']);
    expect(cells('To sort')).toEqual(['To sort', '0', '–', '–']);
  });

  it('links each name to its tag, outside the tab order', () => {
    renderTable();
    const link = within(row('Canada')).getByRole('link', { name: 'Canada' });
    expect(link).toHaveAttribute('href', '/tags?path=Travel%2FCanada');
    expect(link).toHaveAttribute('tabindex', '-1');
  });

  it('is one tab stop, and the menu of the row with focus is the next one', async () => {
    renderTable();
    expect(rows().filter((item) => item.tabIndex === 0)).toEqual([row('Travel')]);
    expect(within(row('Travel')).getByRole('button', { name: 'Actions for Travel' })).toHaveProperty('tabIndex', 0);
    expect(within(row('Family')).getByRole('button', { name: 'Actions for Family' })).toHaveProperty('tabIndex', -1);

    row('Travel').focus();
    await fireEvent.keyDown(row('Travel'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('Canada'));
    expect(rows().filter((item) => item.tabIndex === 0)).toEqual([row('Canada')]);
    expect(within(row('Canada')).getByRole('button', { name: 'Actions for Canada' })).toHaveProperty('tabIndex', 0);
    expect(within(row('Travel')).getByRole('button', { name: 'Actions for Travel' })).toHaveProperty('tabIndex', -1);
  });

  it('moves between rows with Up, Down, Home and End', async () => {
    renderTable();
    row('Travel').focus();
    await fireEvent.keyDown(row('Travel'), { key: 'End' });
    expect(document.activeElement).toBe(row('To sort'));
    await fireEvent.keyDown(row('To sort'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(row('Family'));
    await fireEvent.keyDown(row('Family'), { key: 'Home' });
    expect(document.activeElement).toBe(row('Travel'));
    // nowhere to go above the first row
    await fireEvent.keyDown(row('Travel'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(row('Travel'));
  });

  it('opens a branch with Right, then steps into it; closes it with Left, then steps out', async () => {
    renderTable(['travel']);
    row('Canada').focus();
    await fireEvent.keyDown(row('Canada'), { key: 'ArrowRight' });
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'canada' }));

    row('Travel').focus();
    await fireEvent.keyDown(row('Travel'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(row('Canada'));
    expect(onToggle).toHaveBeenCalledTimes(1);

    // Left on a closed branch or a leaf goes to its parent
    await fireEvent.keyDown(row('Canada'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(row('Travel'));
    // Left on an open branch closes it
    await fireEvent.keyDown(row('Travel'), { key: 'ArrowLeft' });
    expect(onToggle).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'travel' }));
    // Right on a leaf does nothing
    row('Norway').focus();
    await fireEvent.keyDown(row('Norway'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(row('Norway'));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('opens a tag with Enter or a click on its row', async () => {
    renderTable();
    row('Family').focus();
    await fireEvent.keyDown(row('Family'), { key: 'Enter' });
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'family' }));
    await fireEvent.click(within(row('Norway')).getAllByRole('gridcell')[1]);
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'norway' }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('leaves the name link, the expander and the menu to do their own thing', async () => {
    renderTable();
    await fireEvent.click(within(row('Canada')).getByRole('link', { name: 'Canada' }));
    await fireEvent.click(within(row('Travel')).getByRole('button', { name: 'Actions for Travel' }));
    expect(onOpen).not.toHaveBeenCalled();

    await fireEvent.click(within(row('Travel')).getByRole('button', { name: 'Collapse Travel' }));
    await fireEvent.click(within(row('Canada')).getByRole('button', { name: 'Expand Canada' }));
    expect(onToggle.mock.calls.map(([node]) => node.id)).toEqual(['travel', 'canada']);
    expect(onOpen).not.toHaveBeenCalled();

    // a key pressed in the row's menu is the menu's, not the table's
    const trigger = within(row('Travel')).getByRole('button', { name: 'Actions for Travel' });
    trigger.focus();
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(document.activeElement).toBe(trigger);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('lists search matches flat: no levels, no branches, and where each tag sits', async () => {
    render(TagTable, { rows: findTags(tree, 'an'), flat: true, expanded: new Set(['travel']), onToggle, onOpen, menu });
    expect(rows().map((item) => item.querySelector('.label')?.textContent)).toEqual(['Canada', 'Banff']);
    for (const item of rows()) {
      expect(item).toHaveAttribute('aria-level', '1');
      expect(item).not.toHaveAttribute('aria-expanded');
    }
    expect(within(row('Banff')).getByText('in Travel › Canada')).toBeInTheDocument();
    expect(within(row('Canada')).queryByRole('button', { name: /Expand|Collapse/ })).toBeNull();
    // Left and Right have nothing to open or leave
    row('Canada').focus();
    await fireEvent.keyDown(row('Canada'), { key: 'ArrowRight' });
    await fireEvent.keyDown(row('Canada'), { key: 'ArrowLeft' });
    expect(onToggle).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row('Canada'));
  });
});
