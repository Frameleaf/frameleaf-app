import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import BackupBrowse from '$lib/components/frameleaf/backup/BackupBrowse.svelte';
import en from '../../../../../../i18n/en.json';

const manifests = [
  { key: 'newest', createdAt: '2026-11-16T08:29:00Z', finishedAt: null, assets: 3, bytes: 3000, files: 3 },
  { key: 'older', createdAt: '2026-11-08T08:28:00Z', finishedAt: null, assets: 3, bytes: 3000, files: 3 },
] as never[];

const folder = (name: string, files: number, size: number) => ({
  name,
  type: 'folder',
  files,
  size,
  modifiedAt: '2026-11-01T00:00:00Z',
});
const file = (name: string, size: number) => ({
  name,
  type: 'file',
  files: 1,
  size,
  modifiedAt: '2026-11-01T00:00:00Z',
});

/** `/` holds `data`; `/data` holds `library` and three files, read two entries at a time here. */
const listings: Record<string, { entries: ReturnType<typeof file>[]; hiddenLocked: number }> = {
  '/': { entries: [folder('data', 5, 5000)], hiddenLocked: 0 },
  '/data': {
    entries: [folder('library', 2, 2000), file('a.jpg', 1000), file('b.mov', 1000), file('c.jpg', 1000)],
    hiddenLocked: 2,
  },
};

const step = () =>
  screen.getByRole('list', { name: 'Restore steps' }).querySelector(':scope [aria-current="step"] strong');

describe('Backup › Restore › Files or folders (FL-1666)', () => {
  beforeAll(() => {
    addMessages('dev', en);
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.browseCloudBackup.mockImplementation(({ cloudBackupBrowseDto: { path, offset = 0 } }) => {
      const { entries, hiddenLocked } = listings[path] ?? { entries: [], hiddenLocked: 0 };
      const limit = path === '/data' ? 2 : 200;
      return Promise.resolve({
        path,
        total: entries.length,
        entries: entries.slice(offset, offset + limit),
        hiddenLocked,
      } as never);
    });
    sdkMock.restoreCloudBackup.mockResolvedValue({} as never);
  });

  const openData = async () => {
    await fireEvent.click(await screen.findByRole('button', { name: 'Open data' }));
    return screen.findByRole('checkbox', { name: 'Choose a.jpg' });
  };

  it('browses from the top by folder, ticks files and folders, and pages a long folder', async () => {
    const onDone = vi.fn();
    render(BackupBrowse, { manifests, start: 'older', onDone });
    expect(step()).toHaveTextContent('Choose');
    expect(screen.getByLabelText('Backup date')).toHaveValue('older');
    expect(sdkMock.browseCloudBackup).toHaveBeenCalledWith({
      cloudBackupBrowseDto: { manifestKey: 'older', path: '/', offset: 0, limit: 200 },
    });
    expect(screen.getByText('Nothing chosen yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    await openData();
    const crumbs = screen.getByRole('navigation', { name: 'Folder' });
    expect(within(crumbs).getByRole('button', { name: 'data' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('2 files of Locked items are in this folder and restored with it.')).toBeInTheDocument();

    // Two entries were read; the rest come a page at a time.
    await fireEvent.click(screen.getByRole('button', { name: 'Show 2 more files' }));
    expect(await screen.findByRole('checkbox', { name: 'Choose c.jpg' })).toBeInTheDocument();
    expect(sdkMock.browseCloudBackup).toHaveBeenLastCalledWith({
      cloudBackupBrowseDto: { manifestKey: 'older', path: '/data', offset: 2, limit: 200 },
    });

    await fireEvent.click(screen.getByRole('checkbox', { name: 'Choose a.jpg' }));
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Choose library' }));
    expect(screen.getByText(/^3 files chosen · /)).toBeInTheDocument();

    // "All folders" goes back to the top; a ticked folder ticks what is inside it.
    await fireEvent.click(within(crumbs).getByRole('button', { name: 'All folders' }));
    await fireEvent.click(await screen.findByRole('checkbox', { name: 'Choose data' }));
    expect(screen.getByText(/^5 files chosen · /)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Open data' }));
    const inside = await screen.findByRole('checkbox', { name: 'Choose a.jpg' });
    expect(inside).toBeChecked();
    expect(inside).toBeDisabled();

    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(step()).toHaveTextContent('Where they go');
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(step()).toHaveTextContent('Review');
    const facts = screen.getByText('Already in the way').closest('div')!;
    expect(within(facts).getByText('Checked as it runs')).toBeInTheDocument();
    expect(screen.getByText('Where it was')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_backup_browse_aside_title_original)).toBeInTheDocument();
    // No storage words on the restore pages.
    expect(document.body.textContent).not.toMatch(/snapshot|chunk|pack|bucket|object/i);

    await fireEvent.click(screen.getByRole('button', { name: /^Restore 5 files$/ }));
    expect(sdkMock.restoreCloudBackup).toHaveBeenCalledWith({
      cloudBackupRestoreDto: { manifestKey: 'older', scope: 'files', paths: ['/data'] },
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('saves to another folder only once a whole folder path is given', async () => {
    render(BackupBrowse, { manifests, onDone: vi.fn() });
    await fireEvent.click(await openData());
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await fireEvent.click(screen.getByRole('radio', { name: /^Save to another folder/ }));
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    await fireEvent.input(screen.getByLabelText('Folder to save to'), { target: { value: 'restored' } });
    expect(continueButton).toBeDisabled();
    await fireEvent.input(screen.getByLabelText('Folder to save to'), { target: { value: '/mnt/photos/Restored' } });
    await fireEvent.click(continueButton);
    expect(screen.getByText('Another folder')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_backup_browse_aside_title_elsewhere)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: /^Restore 1 file$/ }));
    expect(sdkMock.restoreCloudBackup).toHaveBeenCalledWith({
      cloudBackupRestoreDto: {
        manifestKey: 'newest',
        scope: 'files',
        paths: ['/data/a.jpg'],
        folder: '/mnt/photos/Restored',
      },
    });
  });

  it('lists a file’s earlier versions and carries the chosen one on to step 2', async () => {
    sdkMock.getCloudBackupFileVersions.mockResolvedValue({
      versions: [
        { manifestKey: 'newest', createdAt: '2026-11-16T08:29:00Z', modifiedAt: '', size: 3000 },
        { manifestKey: 'older', createdAt: '2026-11-08T08:28:00Z', modifiedAt: '', size: 1000 },
      ],
    });
    render(BackupBrowse, { manifests, start: 'older', onDone: vi.fn() });
    await openData();
    await fireEvent.click(screen.getByRole('button', { name: 'Earlier versions of a.jpg' }));
    expect(sdkMock.getCloudBackupFileVersions).toHaveBeenCalledWith({
      cloudBackupFileVersionsDto: { path: '/data/a.jpg' },
    });
    const list = await screen.findByRole('radiogroup', { name: 'Versions of a.jpg' });
    const [newest, held] = within(list).getAllByRole('radio');
    expect(newest.closest('label')).toHaveTextContent('Newest');
    expect(held.closest('label')).toHaveTextContent('In the backup you’re browsing');
    expect(held).toBeChecked();
    expect(screen.getByText(/changed in 2 backups/)).toBeInTheDocument();

    await fireEvent.click(newest);
    await fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    expect(step()).toHaveTextContent('Where they go');
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await fireEvent.click(screen.getByRole('button', { name: /^Restore 1 file$/ }));
    expect(sdkMock.restoreCloudBackup).toHaveBeenCalledWith({
      cloudBackupRestoreDto: { manifestKey: 'newest', scope: 'files', paths: ['/data/a.jpg'] },
    });
  });

  it('says when a file has no earlier versions', async () => {
    sdkMock.getCloudBackupFileVersions.mockResolvedValue({
      versions: [{ manifestKey: 'older', createdAt: '2026-11-08T08:28:00Z', modifiedAt: '', size: 1000 }],
    });
    render(BackupBrowse, { manifests, onDone: vi.fn() });
    await openData();
    await fireEvent.click(screen.getByRole('button', { name: 'Earlier versions of a.jpg' }));
    expect(await screen.findByText(/No earlier versions/)).toBeInTheDocument();
  });
});
