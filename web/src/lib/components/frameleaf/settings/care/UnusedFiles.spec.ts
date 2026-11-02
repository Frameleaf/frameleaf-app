import { emptyFileTrash, getFileTrash, restoreFileTrashItem } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import UnusedFiles from '$lib/components/frameleaf/settings/care/UnusedFiles.svelte';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import en from '../../../../../../../i18n/en.json';

/** Library care › Unused files (FL-416): totals, paging, Restore, and Empty with the size it gives back. */
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  getFileTrash: vi.fn(),
  restoreFileTrashItem: vi.fn(),
  emptyFileTrash: vi.fn(),
  getUtilitiesSummary: vi.fn().mockResolvedValue({ unusedFiles: 0, unusedBytes: 0 }),
}));
vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: vi.fn() }));

const item = (index: number, overrides: Record<string, unknown> = {}) => ({
  id: `entry-${index}`,
  originalFileName: index === 1 ? 'VID_0311.MOV' : `IMG_${String(index).padStart(4, '0')}.HEIC`,
  sizeInBytes: 8_400_000,
  checksum: 'c'.repeat(64),
  lastOwnerId: 'taylor',
  lastOwnerName: 'Taylor',
  lastAssetId: null,
  trashedAt: '2026-10-02T10:00:00.000Z',
  ...overrides,
});
const page = (total: number, from: number, count: number) => ({
  items: Array.from({ length: count }, (_, offset) => item(from + offset)),
  total,
  totalBytes: 4_500_000_000,
});
const hero = () => within(screen.getByRole('region', { name: en.frameleaf_unused_status }));

describe('Unused files (FL-416)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getFileTrash).mockImplementation(({ page: number = 1 }) =>
      Promise.resolve(page(45, (number - 1) * 20, number === 3 ? 5 : 20)),
    );
  });

  it('says how many files wait and the space they hold, and pages through them', async () => {
    render(UnusedFiles);

    expect(await hero().findByRole('heading', { name: '45 files are waiting, using 4.5 GB' })).toBeInTheDocument();
    expect(hero().getByText(en.frameleaf_unused_hero_body)).toBeInTheDocument();
    expect(screen.getByText('1–20 of 45')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByText('VID_0311.MOV')).toBeInTheDocument();
    expect(screen.getAllByText('Taylor’s library')).toHaveLength(20);
    expect(getFileTrash).toHaveBeenCalledWith({ page: 1, size: 20 });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_unused_next }));
    expect(await screen.findByText('21–40 of 45')).toBeInTheDocument();
    expect(getFileTrash).toHaveBeenLastCalledWith({ page: 2, size: 20 });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_unused_next }));
    expect(await screen.findByText('41–45 of 45')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_unused_next })).toBeDisabled();
  });

  it('restores a file to the library it was last in', async () => {
    vi.mocked(restoreFileTrashItem).mockResolvedValue({ assetId: 'asset' });
    render(UnusedFiles);

    await fireEvent.click(await screen.findByRole('button', { name: 'Restore VID_0311.MOV' }));
    expect(restoreFileTrashItem).toHaveBeenCalledWith({ id: 'entry-1' });
    expect(await screen.findByText('VID_0311.MOV is back in Taylor’s library.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore VID_0311.MOV' })).toBeDisabled();
    expect(await hero().findByRole('heading', { name: '44 files are waiting, using 4.5 GB' })).toBeInTheDocument();
  });

  it('cannot restore a file whose account was removed', async () => {
    vi.mocked(getFileTrash).mockResolvedValue({
      items: [item(1, { lastOwnerId: null, lastOwnerName: null })],
      total: 1,
      totalBytes: 8_400_000,
    });
    render(UnusedFiles);

    expect(await screen.findByText(en.frameleaf_unused_removed_account)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore VID_0311.MOV' })).toBeDisabled();
  });

  it('empties it only after a confirmation that states the size', async () => {
    vi.mocked(confirmFrameleaf).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(emptyFileTrash).mockResolvedValue({ files: 45, bytes: 4_500_000_000, kept: 0 });
    render(UnusedFiles);

    await fireEvent.click(await hero().findByRole('button', { name: en.frameleaf_unused_empty }));
    expect(confirmFrameleaf).toHaveBeenCalledWith({
      title: 'Empty Unused files and get back 4.5 GB?',
      prompt: expect.stringContaining('45 files, 4.5 GB in all, are deleted from the drive for good'),
      confirmText: 'Empty and get back 4.5 GB',
      danger: true,
    });
    expect(emptyFileTrash).not.toHaveBeenCalled();

    vi.mocked(getFileTrash).mockResolvedValue({ items: [], total: 0, totalBytes: 0 });
    await fireEvent.click(hero().getByRole('button', { name: en.frameleaf_unused_empty }));
    await waitFor(() => expect(emptyFileTrash).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('45 files were deleted from the drive, giving back 4.5 GB.')).toBeInTheDocument();
    expect(await hero().findByRole('heading', { name: en.frameleaf_unused_hero_empty })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.frameleaf_unused_empty })).toBeNull();
  });
});
