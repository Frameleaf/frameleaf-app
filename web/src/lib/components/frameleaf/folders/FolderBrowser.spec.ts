import { AssetTypeEnum, type AssetResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { get, readable } from 'svelte/store';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFolderTree, folderAt, sortFolders } from '$lib/frameleaf/folder-tree';
import { foldersView } from '$lib/stores/folders.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import FolderBrowser from './FolderBrowser.svelte';

const navigation = vi.hoisted(() => ({
  afterNavigate: vi.fn(),
  beforeNavigate: vi.fn(),
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));
vi.mock('$app/navigation', () => navigation);
const assetUtils = vi.hoisted(() => ({ navigateToAsset: vi.fn() }));
vi.mock('$lib/utils/asset-utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...assetUtils,
}));
vi.mock('$lib/utils', () => ({
  getAssetMediaUrl: ({ id }: { id: string }) => `/api/assets/${id}/thumbnail`,
  getAssetPlaybackUrl: ({ id }: { id: string }) => `/api/assets/${id}/video/playback`,
  getAssetUrls: ({ id }: { id: string }) => ({ thumbnail: `/thumb/${id}` }),
  handlePromiseError: vi.fn(),
}));
vi.mock('$lib/utils/thumbnail-util', () => ({ getAltText: readable(() => 'A photo') }));
vi.mock('$lib/components/assets/thumbnail/ImageThumbnail.svelte', async () => {
  const { default: TestImage } = await import('$lib/../test-data/frameleaf/TestImage.svelte');
  return { default: TestImage };
});

/**
 * Columns are offered from 900px. The store asked the test window (the `matchMedia` stub in
 * `test-data/setup.ts`) about that width when it loaded; its answer is as wide as the test says.
 */
const columnsQueries = vi
  .mocked(matchMedia)
  .mock.results.map((result) => result.value as { media: string; matches: boolean })
  .filter((query) => query.media.includes('min-width: 900px'));
const windowIs = (wide: boolean) => {
  for (const query of columnsQueries) {
    query.matches = wide;
  }
};

const jamie = '3f9a1c2e-7b4d-4e8a-9c61-0d2f5a8b7e14';
const day = (value: string) => `${value}T00:00:00.000Z`;
const tree = buildFolderTree([
  {
    path: '/photos/2026',
    count: 2,
    size: 3 * 1024 * 1024,
    coverAssetIds: ['own-1', 'own-2'],
    startDate: day('2026-09-01'),
    endDate: day('2026-09-03'),
  },
  {
    path: '/photos/2026/trip',
    count: 3,
    size: 1024,
    coverAssetIds: ['trip-1', 'trip-2', 'trip-3'],
    startDate: day('2026-06-10'),
    endDate: day('2026-06-12'),
  },
  {
    path: '/photos/2026/trip/day-1/raw',
    count: 1,
    size: 512,
    coverAssetIds: ['raw-1'],
    startDate: day('2026-06-10'),
    endDate: day('2026-06-10'),
  },
  {
    path: '/photos/2025',
    count: 4,
    size: 2048,
    coverAssetIds: ['old-1'],
    startDate: day('2025-02-01'),
    endDate: day('2025-02-01'),
  },
  {
    path: `/uploads/${jamie}/2026-09`,
    count: 5,
    size: 4096,
    coverAssetIds: ['up-1', 'up-2', 'up-3', 'up-4'],
    startDate: day('2026-09-02'),
    endDate: day('2026-09-20'),
  },
]);

const file = (overrides: Partial<AssetResponseDto>) =>
  assetFactory.build({ type: AssetTypeEnum.Image, isOffline: false, ...overrides });
const files = [
  file({
    id: 'b',
    originalFileName: 'IMG_10.jpg',
    localDateTime: '2026-09-01T10:00:00.000Z',
    exifInfo: { fileSizeInByte: 2 * 1024 * 1024 },
  }),
  file({
    id: 'a',
    originalFileName: 'IMG_9.jpg',
    localDateTime: '2026-09-03T10:00:00.000Z',
    exifInfo: { fileSizeInByte: 1024 },
    isOffline: true,
  }),
];

const renderBrowser = (
  path = '/photos/2026',
  props: Partial<Parameters<typeof render<typeof FolderBrowser>>[1]> = {},
) => render(FolderBrowser, { tree, path, assets: files, accounts: { [jamie]: 'Jamie' }, ...props });

// The photo tiles are articles too; a folder card is the one with a name.
const cards = () => screen.queryAllByRole('article').filter((article) => article.hasAttribute('aria-label'));
const cardNames = () => cards().map((card) => card.getAttribute('aria-label'));
/** The path on disk as the page shows it, without the words around it. */
const diskPath = () => document.querySelector<HTMLElement>('.disk-path');
const captions = () =>
  [...document.querySelectorAll('.fl-grid-caption')].map((caption) =>
    caption.textContent?.replaceAll(/\s+/g, ' ').trim(),
  );
const chooseSort = async (name: string) => {
  await fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
  await fireEvent.click(screen.getByRole('menuitemcheckbox', { name }));
};

/** FL-46 Folders as a visual browser (FoldersV2.jsx), grid view. */
describe('FolderBrowser', () => {
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!;
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')!;

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    foldersView.set({ view: 'grid', fileNames: false });
    windowIs(true);
    // The file grid lays out once it has measured its width.
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 900 },
      clientHeight: { configurable: true, get: () => 800 },
    });
  });
  afterEach(() => {
    Object.defineProperties(HTMLElement.prototype, { clientWidth, clientHeight });
  });

  describe('the top', () => {
    it('is titled Folders, says what the page is, and draws no path', () => {
      renderBrowser('/', { assets: [] });
      expect(screen.getByRole('heading', { level: 1, name: 'Folders' })).toBeInTheDocument();
      expect(screen.getByText('Browse originals the way they are stored on disk.')).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Folder path' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Copy path' })).toBeNull();
    });

    it('shows each folder as a card: a pile of its photos, its name, items, folders inside and size', () => {
      renderBrowser('/', { assets: [] });
      expect(cardNames()).toEqual(['photos', 'uploads']);
      const photos = within(screen.getByRole('article', { name: 'photos' }));
      const open = photos.getByRole('link', { name: 'Open photos, 10 items' });
      expect(open).toHaveAttribute('href', '/folders?path=%2Fphotos');
      expect(photos.getByText('10 items · 2 folders · 3.0 MB')).toBeInTheDocument();
      // the pile: three prints, the back one first, each a lazy thumbnail of a photo under the folder
      const prints = [...open.querySelectorAll('img')];
      expect(prints.map((print) => print.getAttribute('src'))).toEqual([
        '/api/assets/own-2/thumbnail',
        '/api/assets/old-1/thumbnail',
        '/api/assets/own-1/thumbnail',
      ]);
      expect(prints.every((print) => print.getAttribute('loading') === 'lazy')).toBe(true);
      expect(screen.getByRole('heading', { level: 2, name: /^Folders\s+2 folders$/ })).toBeInTheDocument();
    });

    it('starts where the tree first branches, with the place on disk beside Copy path', () => {
      const deep = buildFolderTree([
        { path: '/usr/src/app/upload/library/2026', count: 2, size: 10 },
        { path: '/usr/src/app/upload/library/2025', count: 1, size: 5 },
      ]);
      renderBrowser('/', { tree: deep, assets: [] });
      expect(screen.getByRole('heading', { level: 1, name: 'Folders' })).toBeInTheDocument();
      expect(cardNames()).toEqual(['2025', '2026']);
      // nothing above the top is offered as a place to go
      expect(screen.queryByRole('navigation', { name: 'Folder path' })).toBeNull();
      expect(diskPath()).toHaveTextContent('/usr/src/app/upload/library');
      expect(diskPath()!.parentElement).toHaveTextContent('On disk: /usr/src/app/upload/library');
      expect(screen.getByRole('button', { name: 'Copy path' })).toHaveAttribute('title', '/usr/src/app/upload/library');
    });

    it('says "No folders yet" for an empty library, with nothing to search and Show in timeline disabled', () => {
      renderBrowser('/', { tree: buildFolderTree([]), assets: [] });
      expect(screen.getByText('No folders yet')).toBeInTheDocument();
      expect(
        screen.getByText('Imported originals appear here in the same structure as your storage.'),
      ).toBeInTheDocument();
      expect(cards()).toHaveLength(0);
      expect(screen.queryByRole('searchbox')).toBeNull();
      expect(screen.getByRole('button', { name: 'Show in timeline' })).toBeDisabled();
    });
  });

  describe('a folder', () => {
    it('has its name as the title and its items, size and dates under it', () => {
      renderBrowser();
      expect(screen.getByRole('heading', { level: 1, name: '2026' })).toBeInTheDocument();
      expect(screen.getByText('6 items · 3.0 MB · Jun – Sep 2026')).toBeInTheDocument();
    });

    it('draws its path as pills from All folders, the open folder marked', () => {
      renderBrowser('/photos/2026/trip');
      const path = within(screen.getByRole('navigation', { name: 'Folder path' }));
      expect(path.getAllByRole('link').map((pill) => pill.textContent?.trim())).toEqual([
        'All folders',
        'photos',
        '2026',
        'trip',
      ]);
      expect(path.getByRole('link', { name: 'All folders' })).toHaveAttribute('href', '/folders?path=%2F');
      expect(path.getByRole('link', { name: '2026' })).toHaveAttribute('href', '/folders?path=%2Fphotos%2F2026');
      expect(path.getByRole('link', { name: 'trip' })).toHaveAttribute('aria-current', 'page');
      expect(path.getByRole('link', { name: '2026' })).not.toHaveAttribute('aria-current');
    });

    it('goes to a folder picked from the list beside a pill, keeping focus on the pill', async () => {
      renderBrowser();
      await fireEvent.click(screen.getByRole('button', { name: 'Other folders beside 2026' }));
      const options = screen.getAllByRole('menuitemcheckbox');
      expect(options.map((option) => option.textContent?.trim())).toEqual(['2025', '2026']);
      expect(options[1]).toHaveAttribute('aria-checked', 'true');
      await fireEvent.click(options[0]);
      expect(navigation.goto).toHaveBeenCalledWith('/folders?path=%2Fphotos%2F2025', {
        keepFocus: true,
        noScroll: true,
        replaceState: false,
      });
    });

    it('lists its folders, then its own photos under "In this folder"', async () => {
      renderBrowser();
      expect(cardNames()).toEqual(['trip']);
      expect(
        within(screen.getByRole('article', { name: 'trip' })).getByText('4 items · 1 folder · 1.5 KB'),
      ).toBeInTheDocument();
      const section = screen.getByRole('region', { name: 'In this folder' });
      expect(
        within(section).getByRole('heading', { level: 2, name: /^In this folder\s+2 items$/ }),
      ).toBeInTheDocument();
      await waitFor(() => expect(section.querySelectorAll('.fl-grid-cell')).toHaveLength(2));
      // the offline original is marked
      expect(section.querySelector('.fl-grid-cell')!.querySelector('[title="Asset Offline"]')).not.toBeNull();
    });

    it('opens a photo in the viewer', async () => {
      renderBrowser();
      const section = screen.getByRole('region', { name: 'In this folder' });
      await waitFor(() => expect(section.querySelectorAll('.fl-tile-open')).toHaveLength(2));
      await fireEvent.click(section.querySelectorAll<HTMLElement>('.fl-tile-open')[1]);
      expect(assetUtils.navigateToAsset).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    });

    it('shows file names and sizes under the tiles when File names is on, and remembers it', async () => {
      renderBrowser();
      const names = screen.getByRole('button', { name: 'File names' });
      expect(names).toHaveAttribute('aria-pressed', 'false');
      await waitFor(() => expect(document.querySelectorAll('.fl-grid-cell')).toHaveLength(2));
      expect(captions()).toEqual([]);

      await fireEvent.click(names);
      expect(names).toHaveAttribute('aria-pressed', 'true');
      // name order, numeric
      await waitFor(() => expect(captions()).toEqual(['IMG_9.jpg 1.0 KB', 'IMG_10.jpg 2.0 MB']));
      expect(get(foldersView)).toEqual({ view: 'grid', fileNames: true });

      await fireEvent.click(names);
      expect(get(foldersView)).toEqual({ view: 'grid', fileNames: false });
    });

    it('starts with file names on for a viewer who chose them', async () => {
      foldersView.set({ view: 'grid', fileNames: true });
      renderBrowser();
      expect(screen.getByRole('button', { name: 'File names' })).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => expect(captions()).toHaveLength(2));
    });

    it('has no "In this folder" for a folder that only holds folders', () => {
      renderBrowser('/photos', { assets: [] });
      expect(cardNames()).toEqual(['2025', '2026']);
      expect(screen.queryByRole('region', { name: 'In this folder' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'File names' })).toBeNull();
    });

    it('keeps the folders, the counts and the path when its files fail to load, and offers a retry', async () => {
      renderBrowser('/photos/2026', { assets: [], assetsFailed: true });
      expect(cardNames()).toEqual(['trip']);
      expect(screen.getByText('6 items · 3.0 MB · Jun – Sep 2026')).toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: 'Folder path' })).toBeInTheDocument();
      const section = within(screen.getByRole('region', { name: 'In this folder' }));
      // the count still comes from the tree
      expect(section.getByRole('heading', { level: 2, name: /^In this folder\s+2 items$/ })).toBeInTheDocument();
      expect(section.getByRole('alert')).toHaveTextContent('Couldn’t load this folder’s files just now.');
      await fireEvent.click(section.getByRole('button', { name: 'Try again' }));
      expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
    });

    it('shows the folder in the timeline through a path search', async () => {
      renderBrowser();
      await fireEvent.click(screen.getByRole('button', { name: 'Show in timeline' }));
      expect(navigation.goto).toHaveBeenCalledWith(expect.stringContaining('originalPath'));
      expect(screen.getByText('Showing 2026 in the timeline.')).toBeInTheDocument();
    });
  });

  describe('a level with hundreds of folders', () => {
    // A default install: every original alone in a hash folder, hundreds side by side.
    const hashes = buildFolderTree(
      Array.from({ length: 300 }, (_, index) => ({
        path: `/upload/user/${index.toString(16).padStart(3, '0')}/aa`,
        count: 1,
        size: 1024,
        coverAssetIds: [`cover-${index}`],
      })),
    );

    it('draws the cards a screenful at a time as the end comes into view, every thumbnail lazy', async () => {
      const observed: IntersectionObserverCallback[] = [];
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(callback: IntersectionObserverCallback) {
            observed.push(callback);
          }
          observe = vi.fn();
          disconnect = vi.fn();
        },
      );
      renderBrowser('/upload/user', { tree: hashes, assets: [] });
      expect(screen.getByRole('heading', { level: 2, name: /^Folders\s+300 folders$/ })).toBeInTheDocument();
      expect(cards()).toHaveLength(240);
      expect(document.querySelectorAll('article img:not([loading="lazy"])')).toHaveLength(0);

      observed.at(-1)!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await waitFor(() => expect(cards()).toHaveLength(300));
      vi.unstubAllGlobals();
    });

    it('finds a folder in the whole level, not only among the cards drawn so far', async () => {
      const last = sortFolders(folderAt(hashes, '/upload/user')!.children, 'name').at(-1)!.name;
      renderBrowser('/upload/user', { tree: hashes, assets: [] });
      expect(cardNames()).not.toContain(last);
      const find = screen.getByRole('searchbox', { name: 'Find a folder' });
      await fireEvent.input(find, { target: { value: last } });
      expect(cardNames()).toEqual([last]);
      await fireEvent.input(find, { target: { value: '' } });
      expect(cards()).toHaveLength(240);
    });

    it('keeps the list beside a pill bounded', async () => {
      renderBrowser('/upload/user/00a', { tree: hashes, assets: [] });
      await fireEvent.click(screen.getByRole('button', { name: 'Other folders beside 00a' }));
      expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(200);
      expect(screen.getByRole('textbox', { name: 'Filter folders' })).toBeInTheDocument();
    });
  });

  describe('sort', () => {
    it('offers name, newest, largest and most items, and orders the folders', async () => {
      renderBrowser('/photos', { assets: [] });
      expect(cardNames()).toEqual(['2025', '2026']);
      await fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
      expect(screen.getAllByRole('menuitemcheckbox').map((option) => option.textContent?.trim())).toEqual([
        'Name',
        'Newest first',
        'Largest first',
        'Most items',
      ]);
      await fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Newest first' }));
      expect(cardNames()).toEqual(['2026', '2025']);
      await chooseSort('Most items');
      expect(cardNames()).toEqual(['2026', '2025']);
      await chooseSort('Name');
      expect(cardNames()).toEqual(['2025', '2026']);
    });

    it('orders the photos too: largest first', async () => {
      foldersView.set({ view: 'grid', fileNames: true });
      renderBrowser();
      await waitFor(() => expect(captions()).toEqual(['IMG_9.jpg 1.0 KB', 'IMG_10.jpg 2.0 MB']));
      await chooseSort('Largest first');
      await waitFor(() => expect(captions()).toEqual(['IMG_10.jpg 2.0 MB', 'IMG_9.jpg 1.0 KB']));
    });
  });

  describe('Find a folder', () => {
    it('shows the matching folders from anywhere as cards that say where they are', async () => {
      renderBrowser();
      await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a folder' }), { target: { value: ' 202 ' } });
      expect(
        screen.getByRole('heading', { level: 2, name: /^Folders matching “202”\s+3 folders$/ }),
      ).toBeInTheDocument();
      expect(cardNames()).toEqual(['2025', '2026', '2026-09']);
      expect(
        within(screen.getByRole('article', { name: '2026' })).getByText('6 items · in photos'),
      ).toBeInTheDocument();
      expect(
        within(screen.getByRole('article', { name: '2026-09' })).getByText('5 items · in uploads › Jamie’s uploads'),
      ).toBeInTheDocument();
      // the open folder's own content steps aside
      expect(screen.queryByRole('region', { name: 'In this folder' })).toBeNull();
    });

    it('finds a folder two levels down and names the top as All folders', async () => {
      renderBrowser('/');
      await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a folder' }), { target: { value: 'photo' } });
      expect(
        within(screen.getByRole('article', { name: 'photos' })).getByText('10 items · in All folders'),
      ).toBeInTheDocument();
    });

    it('says when nothing matches and clears the search', async () => {
      renderBrowser();
      const find = screen.getByRole('searchbox', { name: 'Find a folder' });
      await fireEvent.input(find, { target: { value: 'zebra' } });
      expect(screen.getByText('No folders match “zebra”')).toBeInTheDocument();
      expect(cards()).toHaveLength(0);
      await fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
      expect(find).toHaveValue('');
      expect(cardNames()).toEqual(['trip']);
    });

    it('opens a found folder in the grid, even when the search began in columns', async () => {
      foldersView.set({ view: 'columns', fileNames: false });
      renderBrowser('/photos', { assets: [] });
      await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a folder' }), { target: { value: 'trip' } });
      const found = within(screen.getByRole('article', { name: 'trip' })).getByRole('link', {
        name: 'Open trip, 4 items',
      });
      expect(found).toHaveAttribute('href', '/folders?path=%2Fphotos%2F2026%2Ftrip');
      await fireEvent.click(found);
      expect(get(foldersView).view).toBe('grid');
    });
  });

  describe('friendly names', () => {
    it("shows a folder named after an account's id as that person's uploads", () => {
      renderBrowser('/uploads', { assets: [] });
      expect(cardNames()).toEqual(['Jamie’s uploads']);
      const open = screen.getByRole('link', { name: 'Open Jamie’s uploads, 5 items' });
      expect(open).toHaveAttribute('href', `/folders?path=%2Fuploads%2F${jamie}`);
      expect(open).toHaveAttribute('title', `On disk: ${jamie}`);
    });

    it('keeps the real path in view and copies the real path', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      renderBrowser(`/uploads/${jamie}`, { assets: [] });
      expect(screen.getByRole('heading', { level: 1, name: 'Jamie’s uploads' })).toBeInTheDocument();
      const path = within(screen.getByRole('navigation', { name: 'Folder path' }));
      expect(path.getByRole('link', { name: 'Jamie’s uploads' })).toHaveAttribute('title', `On disk: ${jamie}`);
      expect(diskPath()).toHaveAttribute('title', `/uploads/${jamie}`);
      expect(diskPath()!.parentElement).toHaveTextContent(`On disk: /uploads/${jamie}`);

      await fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
      expect(writeText).toHaveBeenCalledWith(`/uploads/${jamie}`);
      await waitFor(() => expect(screen.getByText(`Copied /uploads/${jamie}`)).toBeInTheDocument());
      vi.unstubAllGlobals();
    });

    it('shows the path to select by hand where the browser cannot copy', async () => {
      vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
      renderBrowser();
      await fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
      await waitFor(() =>
        expect(screen.getByText('Couldn’t copy it for you. The path is /photos/2026')).toBeInTheDocument(),
      );
      vi.unstubAllGlobals();
    });

    it('leaves a folder alone when its id belongs to no account the session knows', () => {
      renderBrowser('/uploads', { assets: [], accounts: {} });
      expect(cardNames()).toEqual([jamie]);
    });

    it('says where a folder under a friendly one is, but not for ordinary folders', () => {
      const { unmount } = renderBrowser(`/uploads/${jamie}/2026-09`, { assets: [] });
      expect(diskPath()).toHaveTextContent(`/uploads/${jamie}/2026-09`);
      unmount();
      renderBrowser('/photos/2026');
      expect(diskPath()).toBeNull();
      expect(screen.queryByText(/On disk:/)).toBeNull();
      expect(screen.getByRole('button', { name: 'Copy path' })).toHaveAttribute('title', '/photos/2026');
    });
  });

  describe('views', () => {
    it('offers Grid and Columns on a wide window and remembers the choice', async () => {
      renderBrowser();
      const view = within(screen.getByRole('group', { name: 'View' }));
      expect(view.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'true');
      await fireEvent.click(view.getByRole('button', { name: 'Columns' }));
      expect(get(foldersView)).toEqual({ view: 'columns', fileNames: false });
      expect(view.getByRole('button', { name: 'Columns' })).toHaveAttribute('aria-pressed', 'true');
      // the columns and their preview take the place of the cards and the photos
      expect(screen.getByRole('listbox', { name: 'All folders' })).toBeInTheDocument();
      expect(screen.getByRole('complementary', { name: '2026 details' })).toBeInTheDocument();
      expect(cards()).toHaveLength(0);
      expect(screen.queryByRole('region', { name: 'In this folder' })).toBeNull();
    });

    it('does not offer Columns where they do not fit, and shows the grid whatever was chosen', () => {
      windowIs(false);
      foldersView.set({ view: 'columns', fileNames: false });
      renderBrowser();
      expect(screen.queryByRole('group', { name: 'View' })).toBeNull();
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(cardNames()).toEqual(['trip']);
      // the stored choice is left for the wide window it was made on
      expect(get(foldersView).view).toBe('columns');
    });

    it('asks for the files once when the grid takes over from columns that had not loaded them', async () => {
      foldersView.set({ view: 'columns', fileNames: false });
      renderBrowser('/photos/2026', { assets: [], assetsDeferred: true });
      expect(navigation.invalidateAll).not.toHaveBeenCalled();
      await fireEvent.click(screen.getByRole('button', { name: 'Grid' }));
      await waitFor(() => expect(navigation.invalidateAll).toHaveBeenCalledTimes(1));
      // until they arrive the section holds its place with the count from the tree
      expect(screen.getByRole('heading', { level: 2, name: /^In this folder\s+2 items$/ })).toBeInTheDocument();
    });

    it('opens a folder in the grid from the columns with Enter', async () => {
      foldersView.set({ view: 'columns', fileNames: false });
      renderBrowser('/photos/2026', { assets: [], assetsDeferred: true });
      const row = screen.getByRole('option', { name: /trip/ });
      await fireEvent.keyDown(row, { key: 'Enter' });
      expect(get(foldersView).view).toBe('grid');
      expect(navigation.goto).toHaveBeenCalledWith('/folders?path=%2Fphotos%2F2026%2Ftrip', { keepFocus: true });
    });

    it('steps through the columns without leaving a trail of history entries', async () => {
      foldersView.set({ view: 'columns', fileNames: false });
      renderBrowser('/photos/2026', { assets: [] });
      await fireEvent.keyDown(screen.getByRole('option', { name: /2026/ }), { key: 'ArrowUp' });
      expect(navigation.goto).toHaveBeenCalledWith('/folders?path=%2Fphotos%2F2025', {
        keepFocus: true,
        noScroll: true,
        replaceState: true,
      });
      // a click is a place to come back to
      await fireEvent.click(screen.getByRole('option', { name: /trip/ }));
      expect(navigation.goto).toHaveBeenLastCalledWith('/folders?path=%2Fphotos%2F2026%2Ftrip', {
        keepFocus: true,
        noScroll: true,
        replaceState: false,
      });
    });
  });

  describe('moving between folders', () => {
    const arrive = (type: string) => {
      for (const [callback] of navigation.afterNavigate.mock.calls) {
        callback({ type, from: null, to: null });
      }
    };

    it("puts focus on the folder's name after a link opened it, so reading starts there", async () => {
      const { rerender } = renderBrowser();
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading).not.toHaveFocus();
      await rerender({ path: '/photos/2026/trip', assets: [] });
      arrive('link');
      expect(screen.getByRole('heading', { level: 1, name: 'trip' })).toHaveFocus();
    });

    it('leaves focus alone when the viewer opens or closes over the same folder', () => {
      renderBrowser();
      arrive('link');
      expect(screen.getByRole('heading', { level: 1 })).not.toHaveFocus();
    });

    it('starts another folder clean: no search left over', async () => {
      const { rerender } = renderBrowser();
      const find = screen.getByRole('searchbox', { name: 'Find a folder' });
      await fireEvent.input(find, { target: { value: 'trip' } });
      await rerender({ path: '/photos/2026/trip', assets: [] });
      expect(find).toHaveValue('');
    });
  });
});
