import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { createLandmarkAlbum } from '$lib/frameleaf/landmark-albums';

/** FL-356: a visit to a landmark kept as an album of everything taken there on those days. */
describe('createLandmarkAlbum', () => {
  const visit = { landmarkId: 'Q181185', startDate: '2026-06-01', endDate: '2026-06-02', albumName: 'Disneyland' };
  const found = (ids: string[]) => ({ assets: { items: ids.map((id) => ({ id })), total: ids.length } }) as never;

  beforeEach(() => vi.resetAllMocks());

  it('puts everything taken at the landmark on those days in a new album', async () => {
    sdkMock.searchAssets.mockResolvedValue(found(['a', 'b']));
    sdkMock.createAlbum.mockResolvedValue({ id: 'album' } as never);
    sdkMock.addAssetsToAlbum.mockResolvedValue([]);

    await expect(createLandmarkAlbum(visit)).resolves.toBe('album');

    expect(sdkMock.searchAssets.mock.calls[0][0].metadataSearchDto.filter).toMatchObject({
      landmarkIds: { any: ['Q181185'] },
      localDateTime: { gte: '2026-06-01T00:00:00.000Z', lt: '2026-06-03T00:00:00.000Z' },
    });
    expect(sdkMock.createAlbum).toHaveBeenCalledWith({ createAlbumDto: { albumName: 'Disneyland' } });
    expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledWith({ id: 'album', bulkIdsDto: { ids: ['a', 'b'] } });
  });

  it('makes no album when nothing was taken there', async () => {
    sdkMock.searchAssets.mockResolvedValue(found([]));

    await expect(createLandmarkAlbum(visit)).resolves.toBeNull();
    expect(sdkMock.createAlbum).not.toHaveBeenCalled();
  });
});
