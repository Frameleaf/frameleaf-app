import type { AlbumResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import { getAllAlbums } from '@immich/sdk';
import UploadMenuButton from './UploadMenuButton.svelte';

/**
 * UploadMenuButton (FL-45) is the top bar's Upload control, ported from the prototype's
 * `UploadButton`. It fetches real albums through `getAllAlbums` — mocked here — and must
 * offer only true albums and shared spaces as a target, never a collection (a collection
 * groups albums; it is not itself a place photos go, see BulkAlbumDialog).
 */

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAllAlbums: vi.fn(),
}));

type AlbumUsers = AlbumResponseDto['albumUsers'];

const album = (partial: Partial<AlbumResponseDto> & { id: string; albumName: string }): AlbumResponseDto =>
  ({
    albumThumbnailAssetId: null,
    albumUsers: [] as unknown as AlbumUsers,
    assetCount: 0,
    createdAt: '2026-09-22T00:00:00.000Z',
    description: '',
    hasSharedLink: false,
    icon: null,
    isActivityEnabled: true,
    parentId: null,
    shared: false,
    sortOrder: null,
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...partial,
  }) as AlbumResponseDto;

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('UploadMenuButton', () => {
  it('offers Upload files and Upload folder', async () => {
    vi.mocked(getAllAlbums).mockResolvedValue([]);
    render(UploadMenuButton);

    await fireEvent.click(screen.getByRole('button', { name: en.upload }));

    expect(screen.getByRole('menuitem', { name: new RegExp(en.frameleaf_transfer_upload_files) })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: new RegExp(en.frameleaf_transfer_upload_folder) })).toBeInTheDocument();
  });

  it('lists albums and shared spaces as upload targets, never a collection', async () => {
    vi.mocked(getAllAlbums).mockResolvedValue([
      album({ id: 'trips', albumName: 'Trips' }),
      album({ id: 'iceland', albumName: 'Iceland', parentId: 'trips' }),
      album({ id: 'solo', albumName: 'Solo album' }),
    ]);

    render(UploadMenuButton);
    await fireEvent.click(screen.getByRole('button', { name: en.upload }));

    await waitFor(() => expect(screen.getByRole('option', { name: 'Iceland' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Solo album' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Trips' })).toBeNull();
  });
});
