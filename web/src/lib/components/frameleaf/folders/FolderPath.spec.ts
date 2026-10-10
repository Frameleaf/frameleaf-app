import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFolderTree,
  firstUsefulFolder,
  folderAt,
  folderTrail,
  type FolderNode,
  type FolderTree,
} from '$lib/frameleaf/folder-tree';
import FolderPath from './FolderPath.svelte';

const tree = buildFolderTree([
  { path: '/photos/2023/Iceland', count: 1, size: 1 },
  { path: '/photos/2024', count: 1, size: 1 },
  { path: '/photos/2026/Rockies/Banff', count: 1, size: 1 },
  { path: '/photos/2026/Rockies/Jasper', count: 1, size: 1 },
  { path: '/photos/2026/Summer', count: 1, size: 1 },
  { path: '/scans', count: 1, size: 1 },
]);

/** A default install: every original in its own hash folder, hundreds side by side. */
const hashTree = (count: number) =>
  buildFolderTree(
    Array.from({ length: count }, (_, index) => ({
      path: `/upload/user/${index.toString(16).padStart(3, '0')}/aa`,
      count: 1,
      size: 1,
    })),
  );

const onGo = vi.fn();
const renderPath = (path: string, from: FolderTree = tree) => {
  const top = firstUsefulFolder(from);
  return render(FolderPath, {
    trail: folderTrail(folderAt(from, path)!, top),
    label: (node: FolderNode) => (node === top ? 'All folders' : node.name),
    href: (node: FolderNode) => `/folders?path=${encodeURIComponent(node.path)}`,
    title: (node: FolderNode) => (node.name === 'Rockies' ? 'On disk: Rockies' : undefined),
    onGo,
  });
};
const options = () => screen.queryAllByRole('menuitemcheckbox').map((option) => option.textContent?.trim());

/** FL-46 Folders: the path pills and the list of folders beside each (FoldersV2.jsx PathBar). */
describe('FolderPath', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('draws a pill for every folder from the top to the open one, each a link', () => {
    renderPath('/photos/2026/Rockies');
    const path = within(screen.getByRole('navigation', { name: 'Folder path' }));
    const pills = path.getAllByRole('link');
    expect(pills.map((pill) => pill.textContent?.trim())).toEqual(['All folders', 'photos', '2026', 'Rockies']);
    expect(pills.map((pill) => pill.getAttribute('href'))).toEqual([
      '/folders?path=%2F',
      '/folders?path=%2Fphotos',
      '/folders?path=%2Fphotos%2F2026',
      '/folders?path=%2Fphotos%2F2026%2FRockies',
    ]);
    expect(pills.at(-1)).toHaveAttribute('aria-current', 'page');
    expect(pills.at(-1)).toHaveAttribute('title', 'On disk: Rockies');
    expect(pills.at(0)).not.toHaveAttribute('aria-current');
  });

  it('puts the list of neighbours on every pill that has any, and never on the top', () => {
    renderPath('/photos/2026/Rockies');
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Other folders beside photos',
      'Other folders beside 2026',
      'Other folders beside Rockies',
    ]);
  });

  it('leaves the list off a folder that is alone at its level', () => {
    renderPath('/photos/2023/Iceland');
    expect(screen.queryByRole('button', { name: 'Other folders beside Iceland' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Other folders beside 2023' })).toBeInTheDocument();
  });

  it('lists the folders beside a pill in name order with the current one ticked, and goes to the one picked', async () => {
    renderPath('/photos/2026/Rockies');
    await fireEvent.click(screen.getByRole('button', { name: 'Other folders beside 2026' }));
    expect(screen.getByRole('menu', { name: 'Other folders beside 2026' })).toBeInTheDocument();
    expect(options()).toEqual(['2023', '2024', '2026']);
    expect(screen.getByRole('menuitemcheckbox', { name: '2026' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemcheckbox', { name: '2024' })).toHaveAttribute('aria-checked', 'false');
    // a short list has no filter field
    expect(screen.queryByRole('textbox')).toBeNull();

    await fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '2024' }));
    expect(onGo).toHaveBeenCalledWith(folderAt(tree, '/photos/2024'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('starts on the current folder and does nothing when it is picked again', async () => {
    renderPath('/photos/2026/Rockies');
    await fireEvent.click(screen.getByRole('button', { name: 'Other folders beside 2026' }));
    const current = screen.getByRole('menuitemcheckbox', { name: '2026' });
    await waitFor(() => expect(current).toHaveFocus());
    await fireEvent.click(current);
    expect(onGo).not.toHaveBeenCalled();
  });

  it('closes with Escape and gives focus back to the pill', async () => {
    renderPath('/photos/2026/Rockies');
    const trigger = screen.getByRole('button', { name: 'Other folders beside Rockies' });
    await fireEvent.click(trigger);
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  describe('a long level', () => {
    it('gets a filter field that takes focus, with the list scrolling under it', async () => {
      renderPath('/upload/user/00a/aa', hashTree(40));
      await fireEvent.click(screen.getByRole('button', { name: 'Other folders beside 00a' }));
      const filter = screen.getByRole('textbox', { name: 'Filter folders' });
      await waitFor(() => expect(filter).toHaveFocus());
      expect(options()).toHaveLength(40);
    });

    it('narrows the list as you type and goes to the first match with Enter', async () => {
      const hashes = hashTree(40);
      renderPath('/upload/user/00a/aa', hashes);
      const trigger = screen.getByRole('button', { name: 'Other folders beside 00a' });
      await fireEvent.click(trigger);
      const filter = screen.getByRole('textbox', { name: 'Filter folders' });
      await fireEvent.input(filter, { target: { value: '1f' } });
      expect(options()).toEqual(['01f']);
      await fireEvent.keyDown(filter, { key: 'Enter' });
      expect(onGo).toHaveBeenCalledWith(folderAt(hashes, '/upload/user/01f'));
      expect(screen.queryByRole('menu')).toBeNull();
      expect(trigger).toHaveFocus();
    });

    it('moves from the filter into the list with the arrow keys, and typing goes back to the filter', async () => {
      renderPath('/upload/user/00a/aa', hashTree(40));
      await fireEvent.click(screen.getByRole('button', { name: 'Other folders beside 00a' }));
      const filter = screen.getByRole('textbox', { name: 'Filter folders' });
      await waitFor(() => expect(filter).toHaveFocus());
      await fireEvent.keyDown(filter, { key: 'ArrowDown' });
      const first = screen.getAllByRole('menuitemcheckbox')[0];
      expect(first).toHaveFocus();
      await fireEvent.keyDown(first, { key: 'b' });
      expect(filter).toHaveFocus();
    });

    it('says when nothing matches', async () => {
      renderPath('/upload/user/00a/aa', hashTree(40));
      await fireEvent.click(screen.getByRole('button', { name: 'Other folders beside 00a' }));
      await fireEvent.input(screen.getByRole('textbox', { name: 'Filter folders' }), { target: { value: 'zz' } });
      expect(options()).toEqual([]);
      expect(screen.getByText('No folders match “zz”')).toBeInTheDocument();
    });

    it('never draws more than 200 rows at once; the filter reaches the rest', async () => {
      renderPath('/upload/user/00a/aa', hashTree(256));
      await fireEvent.click(screen.getByRole('button', { name: 'Other folders beside 00a' }));
      expect(options()).toHaveLength(200);
      expect(screen.getByText('Showing the first 200 of 256. Type to narrow the list.')).toBeInTheDocument();
      await fireEvent.input(screen.getByRole('textbox', { name: 'Filter folders' }), { target: { value: '0ff' } });
      expect(options()).toEqual(['0ff']);
      expect(screen.queryByText(/Showing the first/)).toBeNull();
    });

    it('starts empty each time it opens', async () => {
      renderPath('/upload/user/00a/aa', hashTree(40));
      const trigger = screen.getByRole('button', { name: 'Other folders beside 00a' });
      await fireEvent.click(trigger);
      await fireEvent.input(screen.getByRole('textbox', { name: 'Filter folders' }), { target: { value: '1f' } });
      await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      await fireEvent.click(trigger);
      expect(screen.getByRole('textbox', { name: 'Filter folders' })).toHaveValue('');
      expect(options()).toHaveLength(40);
    });
  });
});
