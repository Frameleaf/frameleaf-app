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

describe('FolderAlbumsSection (FL-838)', () => {
  it('shows the albums it will make as a tree when switched on', () => {
    render(FolderAlbumsSection, { ...base, checked: true, estimate, onChange: vi.fn() });

    const preview = screen.getByTestId('folder-albums-preview');
    expect(preview).toHaveTextContent('From nas › family, Frameleaf will make 4 albums and 2 collections:');
    expect(within(preview).getByText('Family photos')).toBeInTheDocument();
    expect(within(preview).getByText('Collection · 140 photos')).toBeInTheDocument();
    // Summer only holds Camping: an album of albums below the top
    expect(within(preview).getByText('Holds albums')).toBeInTheDocument();
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
    expect(await screen.findByText(/Frameleaf keeps 4 albums and 2 collections/)).toBeInTheDocument();
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
