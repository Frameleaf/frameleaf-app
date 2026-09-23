import {
  linkSharedSpaceAlbum,
  removeAssetFromAlbum,
  unlinkSharedSpaceAlbum,
  updateAlbumInfo,
  AlbumKind,
  AlbumUserRole,
  type SharedSpaceAlbumResponseDto,
  type UserResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { albumFactory } from '@test-data/factories/album-factory';
import en from '../../../../../i18n/en.json';
import SharedSpaceLinkedAlbums from './SharedSpaceLinkedAlbums.svelte';

vi.mock('$lib/utils');
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  linkSharedSpaceAlbum: vi.fn(),
  removeAssetFromAlbum: vi.fn(),
  unlinkSharedSpaceAlbum: vi.fn(),
  updateAlbumInfo: vi.fn(),
}));

let signedInId = 'ada';
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    get user() {
      return { id: signedInId, name: 'Signed in', email: 'signed-in@example.com', isAdmin: false };
    },
    params: {},
  },
}));

const user = (id: string, name: string): UserResponseDto =>
  ({
    id,
    name,
    email: `${id}@example.com`,
    profileImagePath: '',
    avatarColor: 'primary',
  }) as unknown as UserResponseDto;

const ada = user('ada', 'Ada');
const bo = user('bo', 'Bo');
const cy = user('cy', 'Cy');

const space = albumFactory.build({
  id: 'space-1',
  albumName: 'Family Space',
  kind: AlbumKind.Space,
  albumUsers: [
    { user: ada, role: AlbumUserRole.Owner },
    { user: bo, role: AlbumUserRole.Editor },
    { user: cy, role: AlbumUserRole.Viewer },
  ],
});

const linked = (overrides: Partial<SharedSpaceAlbumResponseDto>): SharedSpaceAlbumResponseDto => ({
  id: 'album-linked',
  albumName: 'Summer',
  icon: null,
  assetCount: 4,
  thumbnailAssetId: null,
  linkedAt: '2026-09-20T00:00:00.000Z',
  linkedBy: bo,
  canUnlink: false,
  ...overrides,
});

const library = [
  albumFactory.build({ id: 'album-linked', albumName: 'Summer', kind: AlbumKind.Album }),
  albumFactory.build({ id: 'album-free', albumName: 'Winter', kind: AlbumKind.Album }),
  albumFactory.build({ id: 'collection-1', albumName: 'Trips', kind: AlbumKind.Collection }),
  space,
];

beforeEach(() => {
  vi.clearAllMocks();
  signedInId = 'ada';
  addMessages('dev', en);
});

describe('SharedSpaceLinkedAlbums', () => {
  it('lists linked albums with how much of each is in the space', () => {
    render(SharedSpaceLinkedAlbums, {
      space,
      albums: [linked({}), linked({ id: 'album-empty', albumName: 'Empty', assetCount: 0 })],
      library,
      onChanged: vi.fn(),
    });

    expect(screen.getByText('Summer')).toBeInTheDocument();
    expect(screen.getByText(/4 items in this shared space/)).toBeInTheDocument();
    expect(screen.getByText(/None of its items are in this shared space yet/)).toBeInTheDocument();
    expect(screen.getAllByText(/Linked by Bo/)).toHaveLength(2);
  });

  it('never offers a viewer the link control', () => {
    signedInId = 'cy';
    render(SharedSpaceLinkedAlbums, { space, albums: [], library, onChanged: vi.fn() });

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(en.frameleaf_spaces_albums_empty)).toBeInTheDocument();
  });

  it('offers only plain albums that are not linked yet, never a collection or a space', () => {
    render(SharedSpaceLinkedAlbums, { space, albums: [linked({})], library, onChanged: vi.fn() });

    const options = [...screen.getByRole('combobox').querySelectorAll('option')].map((option) => option.value);
    expect(options).toEqual(['', 'album-free']);
  });

  it('links by reference and changes nothing else', async () => {
    const onChanged = vi.fn();
    render(SharedSpaceLinkedAlbums, { space, albums: [], library, onChanged });

    await fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'album-free' },
    });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_album_link }));

    await waitFor(() => expect(linkSharedSpaceAlbum).toHaveBeenCalledWith({ id: 'space-1', albumId: 'album-free' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(updateAlbumInfo).not.toHaveBeenCalled();
  });

  it("opens a linked album's picture, an item already in the space, in the space's viewer", async () => {
    const onOpenAsset = vi.fn();
    render(SharedSpaceLinkedAlbums, {
      space,
      albums: [linked({ thumbnailAssetId: 'asset-in-space' }), linked({ id: 'album-empty', albumName: 'Empty' })],
      library,
      onChanged: vi.fn(),
      onOpenAsset,
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Open a photo from Summer in this shared space' }));

    expect(onOpenAsset).toHaveBeenCalledWith('asset-in-space');
    // Without a picture in the space there is nothing to open.
    expect(screen.queryByRole('button', { name: 'Open a photo from Empty in this shared space' })).toBeNull();
  });

  it('unlinks only where the server allows it, and removes no photos', async () => {
    render(SharedSpaceLinkedAlbums, {
      space,
      albums: [linked({ canUnlink: true }), linked({ id: 'album-other', albumName: 'Other', canUnlink: false })],
      library,
      onChanged: vi.fn(),
    });

    expect(screen.queryByRole('button', { name: 'Unlink Other from this shared space' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Unlink Summer from this shared space' }));

    await waitFor(() =>
      expect(unlinkSharedSpaceAlbum).toHaveBeenCalledWith({ id: 'space-1', albumId: 'album-linked' }),
    );
    expect(removeAssetFromAlbum).not.toHaveBeenCalled();
  });
});
