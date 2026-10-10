import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFolderTree,
  firstUsefulFolder,
  folderAt,
  type FolderNode,
  type FolderSort,
} from '$lib/frameleaf/folder-tree';
import FolderColumns from './FolderColumns.svelte';

vi.mock('$lib/utils', () => ({
  getAssetMediaUrl: ({ id, size }: { id: string; size: string }) => `/api/assets/${id}/${size}`,
}));

const jamie = '3f9a1c2e-7b4d-4e8a-9c61-0d2f5a8b7e14';
const day = (value: string) => `${value}T00:00:00.000Z`;
const tree = buildFolderTree([
  { path: '/drone', count: 3, size: 100, coverAssetIds: ['d1'] },
  {
    path: '/photos/2026/Rockies',
    count: 24,
    size: 5 * 1024 * 1024,
    coverAssetIds: ['r1', 'r2', 'r3', 'r4'],
    startDate: day('2026-08-02'),
    endDate: day('2026-08-09'),
  },
  { path: '/photos/2026/Rockies/Banff', count: 30, size: 1024, coverAssetIds: ['b1'] },
  { path: '/photos/2026/Rockies/Jasper', count: 2, size: 2048, coverAssetIds: ['j1'] },
  { path: '/photos/2026/Summer', count: 1, size: 1, coverAssetIds: ['s1'] },
  { path: '/photos/2025', count: 4, size: 4096, coverAssetIds: ['o1'] },
  { path: `/uploads/${jamie}/2026-09`, count: 1200, size: 1, coverAssetIds: ['u1'] },
]);
const top = firstUsefulFolder(tree);
const at = (path: string) => folderAt(tree, path)!;

const handlers = { onGo: vi.fn(), onOpen: vi.fn(), onCopy: vi.fn(), onTimeline: vi.fn() };
const renderColumns = (path: string, sort: FolderSort = 'name') =>
  render(FolderColumns, {
    top,
    folder: at(path),
    sort,
    label: (node: FolderNode) => (node === top ? 'All folders' : node.name === jamie ? 'Jamie’s uploads' : node.name),
    accountName: (node: FolderNode) => (node.name === jamie ? 'Jamie' : null),
    dateRange: (node: FolderNode) => (node.endDate ? 'Aug 2026' : ''),
    ...handlers,
  });

const columns = () => screen.getAllByRole('listbox');
const rows = (column: HTMLElement) =>
  within(column)
    .getAllByRole('option')
    .map((row) => row.querySelector('strong')?.textContent);
const row = (name: string | RegExp) => screen.getByRole('option', { name });
const fact = (term: string) => screen.getByText(term, { selector: 'dt' }).nextElementSibling;

/** FL-46 Folders: the columns view and its preview (FoldersV2.jsx Columns). */
describe('FolderColumns', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens a column for every folder on the way, and one for what the open folder holds', () => {
    renderColumns('/photos/2026/Rockies');
    expect(columns().map((column) => column.getAttribute('aria-label'))).toEqual([
      'All folders',
      'Folders in photos',
      'Folders in 2026',
      'Folders in Rockies',
    ]);
    expect(rows(columns()[0])).toEqual(['drone', 'photos', 'uploads']);
    expect(rows(columns()[1])).toEqual(['2025', '2026']);
    expect(rows(columns()[2])).toEqual(['Rockies', 'Summer']);
    expect(rows(columns()[3])).toEqual(['Banff', 'Jasper']);
  });

  it('has no column after a folder with nothing inside', () => {
    renderColumns('/photos/2026/Summer');
    expect(columns()).toHaveLength(3);
  });

  it('marks the folders on the way as chosen and only the open one as the stop for Tab', () => {
    renderColumns('/photos/2026/Rockies');
    const chosen = screen.getAllByRole('option', { selected: true }).map((option) => option.dataset.path);
    expect(chosen).toEqual(['/photos', '/photos/2026', '/photos/2026/Rockies']);
    const tabbable = screen.getAllByRole('option').filter((option) => option.tabIndex === 0);
    expect(tabbable.map((option) => option.dataset.path)).toEqual(['/photos/2026/Rockies']);
  });

  it('gives Tab the first folder when the top is open and nothing is chosen yet', () => {
    renderColumns('/');
    expect(columns()).toHaveLength(1);
    expect(screen.queryAllByRole('option', { selected: true })).toHaveLength(0);
    const tabbable = screen.getAllByRole('option').filter((option) => option.tabIndex === 0);
    expect(tabbable.map((option) => option.dataset.path)).toEqual(['/drone']);
  });

  it('names each row with its items, with a mini pile of its photos', () => {
    renderColumns('/photos/2026/Rockies');
    expect(row(/Banff/)).toHaveTextContent('Banff 30 items');
    expect(row(/Summer/)).toHaveTextContent('Summer 1 item');
    expect(row(/Banff/).querySelector('img')).toHaveAttribute('src', '/api/assets/b1/thumbnail');
    expect(row(/Banff/).querySelector('img')).toHaveAttribute('loading', 'lazy');
  });

  it('follows the sort order', () => {
    renderColumns('/photos/2026/Rockies', 'items');
    expect(rows(columns()[0])).toEqual(['uploads', 'photos', 'drone']);
    expect(rows(columns()[3])).toEqual(['Banff', 'Jasper']);
  });

  describe('arrow keys', () => {
    const press = (name: RegExp, key: string) => fireEvent.keyDown(row(name), { key });

    it('move up and down a column, and to its ends with Home and End', async () => {
      renderColumns('/photos');
      await press(/photos/, 'ArrowDown');
      expect(handlers.onGo).toHaveBeenLastCalledWith(at('/uploads'), { keyboard: true });
      await press(/photos/, 'ArrowUp');
      expect(handlers.onGo).toHaveBeenLastCalledWith(at('/drone'), { keyboard: true });
      await press(/photos/, 'End');
      expect(handlers.onGo).toHaveBeenLastCalledWith(at('/uploads'), { keyboard: true });
      await press(/photos/, 'Home');
      expect(handlers.onGo).toHaveBeenLastCalledWith(at('/drone'), { keyboard: true });
      expect(handlers.onOpen).not.toHaveBeenCalled();
    });

    it('stop at the ends of a column', async () => {
      renderColumns('/drone');
      await press(/drone/, 'ArrowUp');
      await press(/drone/, 'Home');
      renderColumns('/uploads');
      await fireEvent.keyDown(screen.getAllByRole('option', { name: /uploads/ }).at(-1)!, { key: 'ArrowDown' });
      expect(handlers.onGo).not.toHaveBeenCalled();
    });

    it('go into a folder with the right arrow and back out with the left', async () => {
      renderColumns('/photos/2026');
      await press(/2026/, 'ArrowRight');
      expect(handlers.onGo).toHaveBeenLastCalledWith(at('/photos/2026/Rockies'), { keyboard: true });
      await press(/2026/, 'ArrowLeft');
      expect(handlers.onGo).toHaveBeenLastCalledWith(at('/photos'), { keyboard: true });
    });

    it('do nothing going into a folder with nothing inside, or left from the first column', async () => {
      renderColumns('/drone');
      await press(/drone/, 'ArrowRight');
      await press(/drone/, 'ArrowLeft');
      expect(handlers.onGo).not.toHaveBeenCalled();
    });

    it('open the folder in the grid with Enter, and leave other keys to the page', async () => {
      renderColumns('/photos/2026');
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      row(/2026/).dispatchEvent(enter);
      expect(handlers.onOpen).toHaveBeenCalledWith(at('/photos/2026'));
      expect(enter.defaultPrevented).toBe(true);
      const letter = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
      row(/2026/).dispatchEvent(letter);
      expect(letter.defaultPrevented).toBe(false);
    });

    it('take focus to the folder they opened', async () => {
      const { rerender } = renderColumns('/photos');
      await press(/photos/, 'ArrowRight');
      await rerender({ folder: at('/photos/2025') });
      await waitFor(() => expect(row(/2025/)).toHaveFocus());
    });
  });

  it('opens a folder beside the columns with a click and in the grid with a double click', async () => {
    renderColumns('/photos');
    await fireEvent.click(row(/drone/));
    expect(handlers.onGo).toHaveBeenCalledWith(at('/drone'));
    await fireEvent.dblClick(row(/drone/));
    expect(handlers.onOpen).toHaveBeenCalledWith(at('/drone'));
  });

  describe('the preview', () => {
    it('shows the open folder: a collage, its name, items, size, folders inside, dates and path', () => {
      renderColumns('/photos/2026/Rockies');
      const preview = within(screen.getByRole('complementary', { name: 'Rockies details' }));
      expect(preview.getByRole('heading', { level: 2, name: 'Rockies' })).toBeInTheDocument();
      expect(fact('Items')).toHaveTextContent('56');
      expect(fact('Size')).toHaveTextContent('5.0 MB');
      expect(fact('Folders inside')).toHaveTextContent('2');
      expect(fact('Taken')).toHaveTextContent('Aug 2026');
      expect(preview.getByText('Path on disk').nextElementSibling).toHaveTextContent('/photos/2026/Rockies');
      // four photos make the 2 x 2
      const collage = screen.getByRole('complementary').querySelectorAll(':scope .cover img');
      expect([...collage].map((image) => image.getAttribute('src'))).toEqual([
        '/api/assets/r1/thumbnail',
        '/api/assets/r2/thumbnail',
        '/api/assets/r3/thumbnail',
        '/api/assets/r4/thumbnail',
      ]);
    });

    it('says None and a dash for a folder with nothing inside and no dates, and shows one photo large', () => {
      renderColumns('/drone');
      expect(fact('Folders inside')).toHaveTextContent('None');
      expect(fact('Taken')).toHaveTextContent('–');
      expect(fact('Items')).toHaveTextContent('3');
      const collage = screen.getByRole('complementary').querySelectorAll(':scope .cover img');
      expect([...collage].map((image) => image.getAttribute('src'))).toEqual(['/api/assets/d1/preview']);
    });

    it('groups thousands in the item count', () => {
      renderColumns('/uploads');
      expect(fact('Items')).toHaveTextContent('1,200');
    });

    it('previews the whole library at the top', () => {
      renderColumns('/');
      const preview = within(screen.getByRole('complementary', { name: 'All folders details' }));
      expect(preview.getByRole('heading', { level: 2, name: 'All folders' })).toBeInTheDocument();
      expect(fact('Folders inside')).toHaveTextContent('3');
    });

    it("explains an account's uploads folder and keeps its real path", () => {
      renderColumns(`/uploads/${jamie}`);
      const preview = within(screen.getByRole('complementary', { name: 'Jamie’s uploads details' }));
      expect(preview.getByText('Everything Jamie has uploaded.')).toBeInTheDocument();
      expect(preview.getByText('Path on disk').nextElementSibling).toHaveTextContent(`/uploads/${jamie}`);
      expect(row(/Jamie’s uploads/)).toHaveAttribute('title', `On disk: ${jamie}`);
    });

    it('opens the folder, shows it in the timeline and copies its path', async () => {
      renderColumns('/photos/2026/Rockies');
      const preview = within(screen.getByRole('complementary'));
      await fireEvent.click(preview.getByRole('button', { name: 'Open' }));
      expect(handlers.onOpen).toHaveBeenCalledWith(at('/photos/2026/Rockies'));
      await fireEvent.click(preview.getByRole('button', { name: 'Show in timeline' }));
      expect(handlers.onTimeline).toHaveBeenCalledWith(at('/photos/2026/Rockies'));
      await fireEvent.click(preview.getByRole('button', { name: 'Copy path' }));
      expect(handlers.onCopy).toHaveBeenCalledWith(at('/photos/2026/Rockies'));
    });
  });
});
