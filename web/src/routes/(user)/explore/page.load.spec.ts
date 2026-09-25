import {
  AssetTypeEnum,
  AssetVisibility,
  searchAssets,
  searchAssetStatistics,
  searchFacets,
  SearchFacetField,
} from '@immich/sdk';
import { load } from './+page';

vi.mock('@immich/sdk', async (original) => {
  const sdk = await original<typeof import('@immich/sdk')>();
  return {
    ...sdk,
    getAllPeople: vi.fn(async () => ({ people: [], total: 0, hidden: 0 })),
    getAlbumTree: vi.fn(async () => ({ albums: [], collections: [], spaces: [] })),
    getAssetStatistics: vi.fn(async () => ({ images: 0, videos: 0, total: 0 })),
    searchAssetStatistics: vi.fn(async () => ({ total: 0 })),
    getBestPhotos: vi.fn(async () => ({ total: 0, count: 0, items: [], nextPage: null })),
    searchFacets: vi.fn(async () => ({
      total: 2,
      facets: [{ fieldName: 'city', counts: [{ value: 'Paris', count: 2, coverAssetId: 'newest' }] }],
    })),
    searchAssets: vi.fn(async () => ({ assets: { items: [] }, albums: { items: [] } })),
  };
});
vi.mock('$lib/managers/memory-manager.svelte', () => ({
  memoryManager: {
    setFilters: () => {},
    applyPreferences: async () => {},
    refresh: async () => {},
    memories: [],
  },
}));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));
vi.mock('$lib/utils/i18n', () => ({ getFormatter: async () => (key: string) => key }));

const open = () => load({ url: new URL('https://example.test/explore') } as never);

/**
 * B1 (FL-50 review): Explore's counts and covers are taken in the scope of the search each card
 * opens. That search is flat, and the search session sends every flat search with Timeline
 * visibility, so archived, Locked and Live Photo video parts are never counted or covered.
 */
describe('the Explore loader', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts and covers People, Places and Things with Timeline visibility, in one request', async () => {
    const data = await open();

    expect(searchFacets).toHaveBeenCalledOnce();
    expect(vi.mocked(searchFacets).mock.calls[0][0].searchFacetsDto).toMatchObject({
      visibility: AssetVisibility.Timeline,
      facets: [SearchFacetField.People, SearchFacetField.City, SearchFacetField.Tags],
      facetCovers: true,
    });
    expect(data.places).toEqual([expect.objectContaining({ label: 'Paris', count: 2, coverAssetId: 'newest' })]);
    expect(data.libraryTotal).toBe(2);
  });

  it('counts the Photos and Videos shortcuts in the Timeline scope their search opens', async () => {
    await open();

    const bodies = vi.mocked(searchAssetStatistics).mock.calls.map(([{ statisticsSearchDto }]) => statisticsSearchDto);
    for (const type of [AssetTypeEnum.Image, AssetTypeEnum.Video]) {
      expect(bodies).toContainEqual({ type, visibility: AssetVisibility.Timeline });
    }
  });

  it('takes recent captures with Timeline visibility and makes no per-card cover search', async () => {
    await open();

    expect(searchAssets).toHaveBeenCalledOnce();
    expect(vi.mocked(searchAssets).mock.calls[0][0].metadataSearchDto).toMatchObject({
      visibility: AssetVisibility.Timeline,
    });
  });
});
