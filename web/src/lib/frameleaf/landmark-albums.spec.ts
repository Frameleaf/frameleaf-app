import { sdkMock } from '$lib/__mocks__/sdk.mock';
import {
  createLandmarkAlbum,
  dismissLandmarkAlbum,
  landmarkVisits,
  suggestLandmarkAlbum,
} from '$lib/frameleaf/landmark-albums';
import type { LandmarkCard } from '$lib/frameleaf/landmarks';

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

  it("adds a memory's own items, so the album never holds less than the memory", async () => {
    sdkMock.searchAssets.mockResolvedValue(found(['a', 'b']));
    sdkMock.createAlbum.mockResolvedValue({ id: 'album' } as never);
    sdkMock.addAssetsToAlbum.mockResolvedValue([]);

    await createLandmarkAlbum({ ...visit, assetIds: ['b', 'beside'] });

    expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledWith({ id: 'album', bulkIdsDto: { ids: ['a', 'b', 'beside'] } });
  });

  it('makes no album when nothing was taken there', async () => {
    sdkMock.searchAssets.mockResolvedValue(found([]));

    await expect(createLandmarkAlbum(visit)).resolves.toBeNull();
    expect(sdkMock.createAlbum).not.toHaveBeenCalled();
  });
});

/** FL-357: a visit worth an album, suggested under the landmarks on Explore. */
describe('suggestLandmarkAlbum', () => {
  const card = (id: string, label: string, count: number) => ({ id, label, count }) as LandmarkCard;
  const resort = card('Q1229066', 'Disneyland Resort', 20);
  const studios = card('Q1337576', 'Universal Studios Hollywood', 9);
  const days = (...buckets: [string, number][]) =>
    ({ buckets: buckets.map(([date, count]) => ({ date, count })), granularity: 'day', total: 0 }) as never;

  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    sdkMock.getAllAlbums.mockResolvedValue([]);
  });

  it('joins days at most one empty day apart into one visit', () => {
    const visits = landmarkVisits([
      { date: '2019-06-03', count: 40 },
      { date: '2019-06-05', count: 44 },
      { date: '2026-09-10', count: 14 },
      { date: '2026-09-11', count: 6 },
    ]);
    expect(visits).toEqual([
      { startDate: '2019-06-03', endDate: '2019-06-05', count: 84 },
      { startDate: '2026-09-10', endDate: '2026-09-11', count: 20 },
    ]);
  });

  it('offers the busiest visit to the most photographed landmark', async () => {
    sdkMock.searchHistogram.mockResolvedValue(days(['2019-06-03', 84], ['2026-09-10', 14], ['2026-09-11', 6]));

    await expect(suggestLandmarkAlbum([resort, studios])).resolves.toEqual({
      landmark: resort,
      startDate: '2019-06-03',
      endDate: '2019-06-03',
      count: 84,
    });
    expect(sdkMock.searchHistogram).toHaveBeenCalledWith({
      searchHistogramDto: { filter: { landmarkIds: { any: [resort.id] } }, granularity: 'day' },
    });
  });

  it('moves on from a landmark that has its album, a visit turned down, and visits too small', async () => {
    sdkMock.getAllAlbums.mockResolvedValue([{ albumName: 'Disneyland Resort' }] as never);
    sdkMock.searchHistogram.mockResolvedValue(days(['2026-09-14', 9], ['2026-10-01', 2]));

    const suggestion = await suggestLandmarkAlbum([resort, studios, card('Q243', 'Eiffel Tower', 3)]);
    expect(suggestion).toMatchObject({ landmark: studios, startDate: '2026-09-14', count: 9 });
    expect(sdkMock.searchHistogram).toHaveBeenCalledTimes(1);

    dismissLandmarkAlbum(suggestion!);
    await expect(suggestLandmarkAlbum([resort, studios])).resolves.toBeNull();
  });

  it('asks nothing of the server when no landmark has enough items', async () => {
    await expect(suggestLandmarkAlbum([card('Q243', 'Eiffel Tower', 4)])).resolves.toBeNull();
    expect(sdkMock.getAllAlbums).not.toHaveBeenCalled();
  });
});
