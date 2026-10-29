import { AlbumUserRole, LibraryAssetItemKind, LibraryBookmarkItemKind, LibraryItemKind } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import {
  canIncludeLibraryForCollection,
  collectionItems,
  downloadBoardsCollection,
  downloadBoardsItems,
} from './boards-download';

const archive = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/asset-utils', () => ({
  downloadArchive: archive,
  ignoreCancelledDownload: vi.fn(),
}));
const handleError = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/handle-error', () => ({ handleError }));

const asset = (id: string) => ({ kind: LibraryAssetItemKind.Asset, asset: { id } }) as never;
const link = (id: string) => ({ kind: LibraryBookmarkItemKind.Bookmark, bookmark: { id } }) as never;
const page = (items: never[], next?: { id: string; kind: LibraryItemKind }) => ({
  assetCount: 0,
  bookmarkCount: 0,
  itemCount: items.length,
  items,
  nextCursor: next ?? null,
});

beforeEach(() => {
  vi.resetAllMocks();
  archive.mockResolvedValue(undefined);
});

describe('downloadBoardsItems', () => {
  it('adds the library file with the saved links', async () => {
    await downloadBoardsItems({ fileName: 'Website', assetIds: ['a'], bookmarkIds: ['l'], includeLibrary: true });
    expect(archive).toHaveBeenCalledWith('Website', { assetIds: ['a'] }, { library: { bookmarkIds: ['l'] } });
  });

  it('downloads only the originals without it', async () => {
    await downloadBoardsItems({ fileName: 'Website', assetIds: ['a'], bookmarkIds: ['l'], includeLibrary: false });
    expect(archive).toHaveBeenCalledWith('Website', { assetIds: ['a'] }, { originals: true });
  });
});

describe('collectionItems', () => {
  it('reads every page of the collection, files and saved links apart', async () => {
    sdkMock.getAlbumItems
      .mockResolvedValueOnce(page([asset('a1'), link('l1')], { id: 'l1', kind: LibraryItemKind.Bookmark }))
      .mockResolvedValueOnce(page([asset('a2')]));

    expect(await collectionItems('album')).toEqual({ assetIds: ['a1', 'a2'], bookmarkIds: ['l1'] });
    expect(sdkMock.getAlbumItems).toHaveBeenNthCalledWith(1, { id: 'album', limit: 200 }, { signal: undefined });
    expect(sdkMock.getAlbumItems).toHaveBeenNthCalledWith(
      2,
      { id: 'album', limit: 200, afterId: 'l1', afterKind: LibraryItemKind.Bookmark },
      { signal: undefined },
    );
  });
});

describe('canIncludeLibraryForCollection', () => {
  const me = userAdminFactory.build();
  const other = userAdminFactory.build();

  it('is offered for a collection only this person can add to', () => {
    const album = albumFactory.build({ albumUsers: [{ role: AlbumUserRole.Owner, user: me }] });
    expect(canIncludeLibraryForCollection(album, me.id)).toBe(true);
    const viewed = albumFactory.build({
      albumUsers: [
        { role: AlbumUserRole.Owner, user: me },
        { role: AlbumUserRole.Viewer, user: other },
      ],
    });
    expect(canIncludeLibraryForCollection(viewed, me.id)).toBe(true);
  });

  it('is not offered when someone else owns it or can add to it', () => {
    const theirs = albumFactory.build({ albumUsers: [{ role: AlbumUserRole.Owner, user: other }] });
    expect(canIncludeLibraryForCollection(theirs, me.id)).toBe(false);
    const edited = albumFactory.build({
      albumUsers: [
        { role: AlbumUserRole.Owner, user: me },
        { role: AlbumUserRole.Editor, user: other },
      ],
    });
    expect(canIncludeLibraryForCollection(edited, me.id)).toBe(false);
  });
});

describe('downloadBoardsCollection', () => {
  const album = albumFactory.build({ id: 'album' });

  it('lets the server read the collection when there is no library file', async () => {
    await downloadBoardsCollection({ album, fileName: 'Website', includeLibrary: false, errorMessage: 'failed' });
    expect(sdkMock.getAlbumItems).not.toHaveBeenCalled();
    expect(archive).toHaveBeenCalledWith('Website', { albumId: 'album' }, { originals: true });
  });

  it('lists the files and saved links for the library file', async () => {
    sdkMock.getAlbumItems.mockResolvedValue(page([asset('a1'), link('l1')]));
    await downloadBoardsCollection({ album, fileName: 'Website', includeLibrary: true, errorMessage: 'failed' });
    expect(archive).toHaveBeenCalledWith('Website', { assetIds: ['a1'] }, { library: { bookmarkIds: ['l1'] } });
  });

  it('says so and downloads nothing when the collection cannot be read', async () => {
    const error = new Error('offline');
    sdkMock.getAlbumItems.mockRejectedValue(error);
    await downloadBoardsCollection({ album, fileName: 'Website', includeLibrary: true, errorMessage: 'failed' });
    expect(handleError).toHaveBeenCalledWith(error, 'failed');
    expect(archive).not.toHaveBeenCalled();
  });
});
