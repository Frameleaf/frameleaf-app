import { AssetOrder, AssetVisibility, searchAssets, SharedLinkType } from '@frameleaf/sdk';
import { sharedLinkFactory } from '$lib/../test-data/factories/shared-link-factory';
import { loadAlbumLinkCoverIds, sharedLinkCover } from './shared-link-cover';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  searchAssets: vi.fn(),
}));

describe('shared link cover', () => {
  it("is the link's own cover items and count, as the server gives them", () => {
    const album = sharedLinkFactory.build({
      type: SharedLinkType.Album,
      album: { id: 'album-1', albumName: 'Rockies', albumThumbnailAssetId: 'cover', assetCount: 15 } as never,
      assets: [],
      assetCount: 15,
      coverAssetIds: ['cover', 'n1', 'n2', 'n3'],
    });
    expect(sharedLinkCover(album)).toEqual({ ids: ['cover', 'n1', 'n2', 'n3'], count: 15 });
  });

  it('takes the count from the link, not from the items a response happens to carry', () => {
    // The list of links carries at most four items of a selection; a Locked or trashed one is never counted.
    const selection = sharedLinkFactory.build({
      type: SharedLinkType.Individual,
      assets: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }] as never,
      assetCount: 6,
      coverAssetIds: ['a1', 'a2', 'a3', 'a4'],
    });
    expect(sharedLinkCover(selection)).toEqual({ ids: ['a1', 'a2', 'a3', 'a4'], count: 6 });
    expect(sharedLinkCover({ coverAssetIds: [], assetCount: 0 })).toEqual({ ids: [], count: 0 });
  });
});

describe('the cover a new album link will have', () => {
  /** The album's items as the search returns them, newest first. */
  const newest = (...items: (string | { id: string; visibility: AssetVisibility })[]) =>
    ({
      assets: {
        items: items.map((item) =>
          typeof item === 'string' ? { id: item, visibility: AssetVisibility.Timeline } : item,
        ),
      },
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("follows the server's rule: the chosen cover first, then the newest, four at most, never a Locked item", async () => {
    vi.mocked(searchAssets).mockResolvedValue(
      newest('n1', { id: 'locked', visibility: AssetVisibility.Locked }, 'n2', 'chosen', 'n3', 'n4', 'n5'),
    );

    await expect(loadAlbumLinkCoverIds('album-1', 'chosen')).resolves.toEqual(['chosen', 'n1', 'n2', 'n3']);
    expect(searchAssets).toHaveBeenCalledTimes(1);
    expect(searchAssets).toHaveBeenCalledWith({
      metadataSearchDto: expect.objectContaining({ albumIds: ['album-1'], order: AssetOrder.Desc }),
    });
  });

  it('puts the chosen cover first even when it is not among the newest, and takes the newest alone without one', async () => {
    vi.mocked(searchAssets).mockResolvedValue(newest('n1', 'n2', 'n3', 'n4', 'n5'));

    await expect(loadAlbumLinkCoverIds('album-1', 'older')).resolves.toEqual(['older', 'n1', 'n2', 'n3']);
    await expect(loadAlbumLinkCoverIds('album-1')).resolves.toEqual(['n1', 'n2', 'n3', 'n4']);
    await expect(loadAlbumLinkCoverIds('album-1', null)).resolves.toEqual(['n1', 'n2', 'n3', 'n4']);
  });
});
