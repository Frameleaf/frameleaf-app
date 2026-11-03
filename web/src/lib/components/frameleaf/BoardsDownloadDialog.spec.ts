import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import BoardsDownloadDialog from './BoardsDownloadDialog.svelte';

/** FL-660: Boards' Download dialog, prototype `ExportDialog` (README point 10, screen 11). */
describe('BoardsDownloadDialog', () => {
  beforeEach(() => {
    addMessages('dev', en);
  });

  it('shows the design: originals, the library file switch on by default and the Backup note', () => {
    render(BoardsDownloadDialog, { open: true, count: 2, name: 'Website', onDownload: vi.fn() });

    expect(screen.getByRole('heading', { name: 'Download 2 items' })).toBeInTheDocument();
    expect(screen.getByText('Website').tagName).toBe('STRONG');
    expect(screen.getByText(/exactly as saved/)).toBeInTheDocument();
    const library = screen.getByRole('switch', { name: /Include a library file/ });
    expect(library).toBeChecked();
    expect(library).toBeEnabled();
    expect(library).toHaveAccessibleDescription(/frameleaf-library\.json with collections, tags, ratings, notes/);
    expect(screen.getByText('For a full copy you can restore, use Backup in settings.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download .zip' })).toBeInTheDocument();
  });

  it('downloads with the library file, then closes', async () => {
    const onDownload = vi.fn();
    render(BoardsDownloadDialog, { open: true, count: 1, name: 'Boards', onDownload });
    expect(screen.getByRole('heading', { name: 'Download 1 item' })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Download .zip' }));

    expect(onDownload).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('downloads only the originals when the switch is turned off', async () => {
    const onDownload = vi.fn();
    render(BoardsDownloadDialog, { open: true, count: 3, name: 'Boards', onDownload });

    await fireEvent.click(screen.getByRole('switch', { name: /Include a library file/ }));
    expect(screen.getByRole('switch', { name: /Include a library file/ })).not.toBeChecked();
    await fireEvent.click(screen.getByRole('button', { name: 'Download .zip' }));

    expect(onDownload).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('turns the library file off, and says why, when it cannot be made', async () => {
    const onDownload = vi.fn();
    render(BoardsDownloadDialog, { open: true, count: 3, name: 'Shared', libraryAvailable: false, onDownload });

    const library = screen.getByRole('switch', { name: /Include a library file/ });
    expect(library).toBeDisabled();
    expect(library).not.toBeChecked();
    expect(library).toHaveAccessibleDescription(/up to 10,000 items, all of them your own/);
    await fireEvent.click(screen.getByRole('button', { name: 'Download .zip' }));

    expect(onDownload).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('downloads nothing on Cancel', async () => {
    const onDownload = vi.fn();
    render(BoardsDownloadDialog, { open: true, count: 2, name: 'Boards', onDownload });

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onDownload).not.toHaveBeenCalled();
  });
});
