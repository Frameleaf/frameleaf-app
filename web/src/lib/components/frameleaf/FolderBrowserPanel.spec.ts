import { AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { readable } from 'svelte/store';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFolderTree } from '$lib/frameleaf/folder-tree';
import { assetFactory } from '@test-data/factories/asset-factory';
import FolderBrowserPanel from './FolderBrowserPanel.svelte';

const navigation = vi.hoisted(() => ({ afterNavigate: vi.fn(), goto: vi.fn(), invalidateAll: vi.fn() }));
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

const tree = buildFolderTree([
  { path: '/data/library/2026', count: 2, size: 3 * 1024 * 1024 },
  { path: '/data/library/2026/trip', count: 3, size: 1024 },
  { path: '/data/library/2026/trip/day-1/raw', count: 1, size: 512 },
  { path: '/data/library/2025', count: 4, size: 2048 },
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

const renderPanel = (path = '/data/library/2026', assets = files, folders = tree) =>
  render(FolderBrowserPanel, { tree: folders, path, assets });

/** FL-46 FD-1..FD-8 (Folders.jsx:89-315). */
describe('FolderBrowserPanel', () => {
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!;
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')!;

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // The file grid lays out once it has measured its width.
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 900 },
      clientHeight: { configurable: true, get: () => 800 },
    });
  });
  afterEach(() => {
    Object.defineProperties(HTMLElement.prototype, { clientWidth, clientHeight });
  });

  it('shows the subtitle, the sort control and Show in timeline (FD-2, FD-7)', () => {
    renderPanel();
    expect(screen.getByText('Browse originals the way they are stored on disk.')).toBeInTheDocument();
    const sort = screen.getByRole('combobox', { name: 'Sort files' });
    expect([...sort.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Name',
      'Date taken',
      'Size',
    ]);
    expect(screen.getByRole('button', { name: 'Show in timeline' })).toBeEnabled();
  });

  it('draws the breadcrumb bar from All folders to the open folder (FD-6)', async () => {
    renderPanel('/data/library/2026/trip');
    const crumbs = screen.getByRole('navigation', { name: 'Folder path' });
    expect(within(crumbs).getByRole('button', { name: 'All folders' })).toBeInTheDocument();
    expect(within(crumbs).getByRole('button', { name: '2026' })).toBeInTheDocument();
    expect(within(crumbs).getByText('trip')).toHaveAttribute('aria-current', 'page');
    await fireEvent.click(within(crumbs).getByRole('button', { name: 'library' }));
    expect(navigation.goto).toHaveBeenCalledWith('/folders?path=%2Fdata%2Flibrary', {
      keepFocus: true,
      noScroll: true,
    });
  });

  it('draws the folder tree with totals and the open folder expanded and chosen (FD-6)', () => {
    renderPanel('/data/library/2026/trip/day-1/raw');
    const folderTree = screen.getByRole('tree', { name: 'Folders' });
    const raw = within(folderTree)
      .getAllByRole('treeitem')
      .find((item) => item.dataset.treeId === '/data/library/2026/trip/day-1/raw')!;
    expect(raw).toHaveAttribute('aria-selected', 'true');
    expect(raw).toHaveAttribute('aria-level', '7');
    const root = within(folderTree).getAllByRole('treeitem')[0];
    expect(root.querySelector(':scope > .dv-tree-row')).toHaveTextContent('All folders 10');
  });

  it('opens a folder from the tree with the keyboard', async () => {
    renderPanel('/data/library');
    const folderTree = screen.getByRole('tree', { name: 'Folders' });
    const library = within(folderTree)
      .getAllByRole('treeitem')
      .find((item) => item.dataset.treeId === '/data/library')!;
    library.focus();
    await fireEvent.keyDown(library, { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).dataset.treeId).toBe('/data/library/2025');
    await fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(navigation.goto).toHaveBeenCalledWith('/folders?path=%2Fdata%2Flibrary%2F2025', {
      keepFocus: true,
      noScroll: true,
    });
  });

  it('lists subfolders with their file and folder counts and size (FD-3)', () => {
    renderPanel();
    const rows = within(screen.getByRole('list', { name: 'Subfolders' })).getAllByRole('button');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('trip');
    expect(rows[0]).toHaveTextContent('4 files · 1 folder');
    expect(rows[0]).toHaveTextContent('1.5 KB');
  });

  it("shows the folder's details: files with and without subfolders, size, folders and path (FD-4)", () => {
    renderPanel();
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent('6 files · 2 here');
    expect(footer).toHaveTextContent('3.0 MB');
    expect(footer).toHaveTextContent('1 folder');
    expect(footer).toHaveTextContent('/data/library/2026');
  });

  it('shows its files in the results grid, named with size and capture day, opening the viewer (FD-1)', async () => {
    renderPanel();
    const grid = screen.getByRole('region', { name: 'Files in 2026' });
    await waitFor(() => expect(grid.querySelectorAll('.fl-grid-cell')).toHaveLength(2));
    const captions = [...grid.querySelectorAll('.fl-grid-caption')].map((caption) => caption.textContent?.trim());
    // name order, numeric
    expect(captions).toEqual(['IMG_9.jpg 1.0 KB · 2026-09-03', 'IMG_10.jpg 2.0 MB · 2026-09-01']);
    // the offline original is marked
    expect(grid.querySelector('.fl-grid-cell')!.querySelector('[title="Asset Offline"]')).not.toBeNull();
    await fireEvent.click(grid.querySelectorAll<HTMLElement>('.fl-tile-open')[1]);
    expect(assetUtils.navigateToAsset).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });

  it('sorts the files by size, largest first (FD-2)', async () => {
    renderPanel();
    await fireEvent.change(screen.getByRole('combobox', { name: 'Sort files' }), { target: { value: 'size' } });
    const grid = screen.getByRole('region', { name: 'Files in 2026' });
    await waitFor(() => expect(grid.querySelector('.fl-grid-caption')?.textContent).toContain('IMG_10.jpg'));
  });

  it('says a folder holds only subfolders (FD-5)', () => {
    renderPanel('/data/library', []);
    expect(screen.getByText('No files directly in this folder')).toBeInTheDocument();
    expect(screen.getByText('Open a subfolder to see its originals.')).toBeInTheDocument();
  });

  it('says "No folders yet" for an empty library, with Show in timeline disabled (FD-5)', () => {
    renderPanel('/', [], buildFolderTree([]));
    expect(screen.getByText('No folders yet')).toBeInTheDocument();
    expect(
      screen.getByText('Imported originals appear here in the same structure as your storage.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show in timeline' })).toBeDisabled();
  });

  it('shows the folder in the timeline through a path search (FD-8)', async () => {
    renderPanel();
    await fireEvent.click(screen.getByRole('button', { name: 'Show in timeline' }));
    expect(navigation.goto).toHaveBeenCalledWith(expect.stringContaining('originalPath'));
    expect(screen.getByText('Showing 2026 in the timeline.')).toBeInTheDocument();
  });
});
