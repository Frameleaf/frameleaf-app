import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import FolderAlbumsSection from '$lib/components/frameleaf/FolderAlbumsSection.svelte';
import en from '../../../../../i18n/en.json';

const estimate = {
  complete: true,
  folders: [
    { path: '/mnt/nas/family', count: 38 },
    { path: '/mnt/nas/family/2024/Banff', count: 212 },
    { path: '/mnt/nas/family/2025/Summer/Camping', count: 140 },
  ],
};
const base = {
  title: 'Albums',
  roots: ['/mnt/nas/family'],
  exclusionPatterns: [],
  libraryName: 'Family photos',
  ownerName: 'Taylor',
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

const events = {
  complete: true,
  folders: [
    { path: '/mnt/nas/family/2026-11-19 - Nathan/Capture', count: 158 },
    { path: '/mnt/nas/family/2026-11-19 - Nathan/Videos', count: 6 },
    { path: '/mnt/nas/family/2026-11-19 - Nathan/Export', count: 161 },
    { path: '/mnt/nas/family/2026-11-20 - Park/Capture', count: 40 },
    { path: '/mnt/nas/family/2026-11-20 - Park/Export', count: 12 },
    { path: '/mnt/nas/family/2026-11-19 - Nathan/RAW', count: 0, skipped: 158 },
    { path: '/mnt/nas/family/2026-11-20 - Park/RAW', count: 0, skipped: 40 },
  ],
};

describe('FolderAlbumsSection (FL-838, FL-1837)', () => {
  it('previews an album for every folder, as FL-838 made them', () => {
    render(FolderAlbumsSection, { ...base, checked: true, estimate, onChange: vi.fn() });

    expect(screen.getByRole('radio', { name: /An album for every folder/ })).toBeChecked();
    expect(screen.getByTestId('folder-albums-preview')).toHaveTextContent(
      'Frameleaf will keep 4 albums and 2 collections from nas › family.',
    );
  });

  it('recommends one album for each event folder for a folder laid out by event, with the subfolder rules', async () => {
    const onOptions = vi.fn();
    render(FolderAlbumsSection, { ...base, checked: true, estimate: events, onChange: vi.fn(), onOptions });

    expect(await screen.findByRole('radio', { name: /One album for each event folder/ })).toBeChecked();
    expect(screen.getByText(en.frameleaf_folder_albums_recommended)).toBeInTheDocument();
    expect(onOptions).toHaveBeenLastCalledWith(expect.objectContaining({ shape: 'events' }), 'match');
    const preview = screen.getByTestId('folder-albums-preview');
    // two event albums, each with an Export album inside, instead of 2 collections of 5 albums
    expect(preview).toHaveTextContent(
      'Frameleaf will keep 4 albums from nas › family, instead of 5 albums and 2 collections.',
    );
    // the example: on the drive and in Albums
    expect(within(preview).getAllByText('2026-11-19 - Nathan')).toHaveLength(2);

    // the RAW folders hold only files this folder skips
    expect(screen.getByText(/In 2 folders · all empty/)).toHaveTextContent(en.frameleaf_folder_albums_inside_skipped);

    const exportRow = screen.getByRole('group', { name: 'Export folders' });
    expect(within(exportRow).getByRole('button', { name: 'Album inside' })).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(within(exportRow).getByRole('button', { name: 'In the album' }));
    expect(onOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ shape: 'events', subfolders: { Export: 'join' } }),
      'match',
    );
    expect(preview).toHaveTextContent('Frameleaf will keep 2 albums from nas › family');
  });

  it('on a folder already added, saves new rules with the choice about the albums made so far', async () => {
    const onOptions = vi.fn();
    render(FolderAlbumsSection, {
      ...base,
      checked: true,
      editing: true,
      estimate: events,
      onChange: vi.fn(),
      onOptions,
    });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await fireEvent.click(screen.getByRole('radio', { name: /One album for each event folder/ }));
    expect(
      screen.getByText(/Family photos already has 5 albums and 2 collections made from its folders/),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Change them to match/ })).toBeChecked();
    await fireEvent.click(screen.getByRole('radio', { name: /Leave them, use this for new folders only/ }));
    await fireEvent.click(save);
    expect(onOptions).toHaveBeenCalledWith(expect.objectContaining({ shape: 'events' }), 'newOnly');
  });

  it('turns on and off directly while adding a folder', async () => {
    const onChange = vi.fn();
    render(FolderAlbumsSection, { ...base, checked: false, estimate, onChange });
    expect(screen.queryByTestId('folder-albums-preview')).toBeNull();

    await fireEvent.click(screen.getByRole('switch', { name: en.frameleaf_folder_albums_switch }));
    expect(onChange).toHaveBeenCalledWith(true, false);
  });

  it('asks before turning off on a folder, keeping the albums unless told to remove them', async () => {
    sdkMock.estimateLibraryFolder.mockResolvedValue({ ...estimate, readable: true, found: true, count: 390, bytes: 0 });
    const onChange = vi.fn();
    render(FolderAlbumsSection, { ...base, checked: true, editing: true, onChange });
    expect(await screen.findByText(/Frameleaf will keep 4 albums and 2 collections/)).toBeInTheDocument();
    expect(sdkMock.estimateLibraryFolder).toHaveBeenCalledWith({ path: '/mnt/nas/family', exclusionPatterns: [] });

    await fireEvent.click(screen.getByRole('switch', { name: en.frameleaf_folder_albums_switch }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(en.frameleaf_folder_albums_never_deleted)).toBeInTheDocument();
    expect(dialog.getByRole('radio', { name: /Keep them as ordinary albums/ })).toBeChecked();
    expect(onChange).not.toHaveBeenCalled();

    await fireEvent.click(dialog.getByRole('radio', { name: /Remove the albums/ }));
    await fireEvent.click(dialog.getByRole('button', { name: 'Remove 6 albums' }));
    expect(onChange).toHaveBeenCalledWith(false, true);
  });
});
