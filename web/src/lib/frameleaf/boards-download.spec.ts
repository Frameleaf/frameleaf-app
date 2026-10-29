import { LibraryAssetItemKind, LibraryBookmarkItemKind, LibraryItemKind } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { albumFactory } from '@test-data/factories/album-factory';
import { canIncludeLibrary, collectionItems, downloadBoardsCollection, downloadBoardsItems } from './boards-download';

const archive = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/asset-utils', () => ({
  downloadArchive: archive,
  ignoreCancelledDownload: vi.fn(),
}));

const asset = (id: string, ownerId = 'me') => ({ kind: LibraryAssetItemKind.Asset, asset: { id, ownerId } }) as never;
const link = (id: string, ownerId = 'me') =>
  ({ kind: LibraryBookmarkItemKind.Bookmark, bookmark: { id, ownerId } }) as never;
const items = (overrides = {}) => ({
  assetIds: ['a1'],
  bookmarkIds: ['l1'],
  owned: true,
  complete: true,
  ...overrides,
});
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

    expect(await collectionItems('album', 'me')).toEqual({
      assetIds: ['a1', 'a2'],
      bookmarkIds: ['l1'],
      owned: true,
      complete: true,
    });
    expect(sdkMock.getAlbumItems).toHaveBeenNthCalledWith(1, { id: 'album', limit: 200 }, { signal: undefined });
    expect(sdkMock.getAlbumItems).toHaveBeenNthCalledWith(
      2,
      { id: 'album', limit: 200, afterId: 'l1', afterKind: LibraryItemKind.Bookmark },
      { signal: undefined },
    );
  });

  it('notices an item someone else added to a collection this person owns', async () => {
    sdkMock.getAlbumItems.mockResolvedValueOnce(page([asset('a1'), asset('a2', 'jamie')]));
    expect(await collectionItems('album', 'me')).toMatchObject({ owned: false });
    sdkMock.getAlbumItems.mockResolvedValueOnce(page([asset('a1'), link('l1', 'jamie')]));
    expect(await collectionItems('album', 'me')).toMatchObject({ owned: false });
  });
});

describe('canIncludeLibrary', () => {
  it("is offered only once every item is known to be this person's own", () => {
    expect(canIncludeLibrary(null)).toBe(false);
    expect(canIncludeLibrary(items())).toBe(true);
    expect(canIncludeLibrary(items({ owned: false }))).toBe(false);
    expect(canIncludeLibrary(items({ complete: false }))).toBe(false);
  });
});

describe('downloadBoardsCollection', () => {
  const album = albumFactory.build({ id: 'album' });

  it('lets the server read the collection when there is no library file', async () => {
    await downloadBoardsCollection({ album, fileName: 'Website', items: items(), includeLibrary: false });
    expect(archive).toHaveBeenCalledWith('Website', { albumId: 'album' }, { originals: true });
  });

  it('downloads the items that were read, with the library file', async () => {
    await downloadBoardsCollection({ album, fileName: 'Website', items: items(), includeLibrary: true });
    expect(archive).toHaveBeenCalledWith('Website', { assetIds: ['a1'] }, { library: { bookmarkIds: ['l1'] } });
  });

  it("never asks for a library file for items that are not all this person's own", async () => {
    await downloadBoardsCollection({
      album,
      fileName: 'Website',
      items: items({ owned: false }),
      includeLibrary: true,
    });
    expect(archive).toHaveBeenCalledWith('Website', { albumId: 'album' }, { originals: true });
  });
});
