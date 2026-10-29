import {
  AssetTypeEnum,
  AssetVisibility,
  SearchFacetField,
  SearchHistogramGranularity,
  type AssetResponseDto,
  type SearchResponseDto,
} from '@frameleaf/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
import type { StudioAssetRef } from './host-contract';

vi.mock('$lib/frameleaf/restoration', () => ({ restorationFileUrl: () => '' }));
vi.mock('$lib/utils', () => ({
  getAssetMediaUrl: ({ id, size }: { id: string; size?: string }) => `/api/assets/${id}/thumbnail?size=${size}`,
  getAssetPlaybackUrl: ({ id }: { id: string }) => `/api/assets/${id}/video/playback`,
  getStudioHdrVideoUrl: (id: string) => `/api/assets/${id}/video/studio-hdr`,
}));

const { createStudioLibraryServices, histogramMonths, monthRange, searchStudioLibrary, studioLibraryFacets } =
  await import('./library-search');
const { toStudioAsset } = await import('./assets');

const PERSON = '11111111-1111-4111-8111-111111111111';
const asset = (id: string, overrides: Partial<AssetResponseDto> = {}): AssetResponseDto =>
  ({
    id,
    type: AssetTypeEnum.Image,
    originalFileName: `${id}.jpg`,
    duration: null,
    thumbhash: 'hash',
    isOffline: false,
    isTrashed: false,
    visibility: AssetVisibility.Timeline,
    ...overrides,
  }) as AssetResponseDto;
const page = (items: AssetResponseDto[], nextPage: string | null = null) =>
  ({
    assets: { items, nextPage, count: items.length, total: items.length, facets: [], nextCursor: null },
    albums: { items: [], count: 0, total: 0, facets: [] },
  }) as SearchResponseDto;
const api = (overrides: Record<string, unknown> = {}) => ({
  searchSmart: vi.fn().mockResolvedValue(page([asset('smart')])),
  searchAssets: vi.fn().mockResolvedValue(page([asset('recent')])),
  searchFacets: vi.fn().mockResolvedValue({ facets: [], total: 0 }),
  searchHistogram: vi.fn().mockResolvedValue({ buckets: [], granularity: SearchHistogramGranularity.Month, total: 0 }),
  ...overrides,
});

afterEach(() => {
  sessionAccess.isElevated = false;
});

describe('FL-636 Studio library search', () => {
  it('runs smart search for words, with the Search filters, on the timeline like the library Search', async () => {
    const sdk = api();
    const result = await searchStudioLibrary(
      { text: ' dog on the beach ', type: 'video', personId: PERSON, city: 'Banff', month: '2026-07' },
      { language: 'en', elevated: false, api: sdk as never },
    );
    expect(sdk.searchAssets).not.toHaveBeenCalled();
    expect(sdk.searchSmart).toHaveBeenCalledExactlyOnceWith(
      {
        smartSearchDto: {
          query: 'dog on the beach',
          language: 'en',
          type: AssetTypeEnum.Video,
          personIds: [PERSON],
          city: 'Banff',
          takenAfter: '2026-07-01T00:00:00.000Z',
          takenBefore: '2026-08-01T00:00:00.000Z',
          visibility: AssetVisibility.Timeline,
          page: 1,
          size: 60,
          withExif: false,
        },
      },
      { signal: undefined },
    );
    expect(result.items.map((item) => item.id)).toEqual(['smart']);
  });

  it('lists the library newest first when there are no words, and reports the next page', async () => {
    const sdk = api({ searchAssets: vi.fn().mockResolvedValue(page([asset('recent')], '3')) });
    const result = await searchStudioLibrary({ page: 2 }, { language: 'en', elevated: false, api: sdk as never });
    expect(sdk.searchSmart).not.toHaveBeenCalled();
    expect(sdk.searchAssets).toHaveBeenCalledWith(
      { metadataSearchDto: { visibility: AssetVisibility.Timeline, page: 2, size: 60, withExif: false } },
      { signal: undefined },
    );
    expect(result.nextPage).toBe(3);
  });

  it('offers no page after the last one the frame may ask for', async () => {
    const sdk = api({ searchAssets: vi.fn().mockResolvedValue(page([asset('recent')], '1001')) });
    const last = await searchStudioLibrary({ page: 1000 }, { language: 'en', elevated: false, api: sdk as never });
    expect(last.nextPage).toBeNull();
    const before = await searchStudioLibrary({ page: 999 }, { language: 'en', elevated: false, api: sdk as never });
    expect(before.nextPage).toBe(1000);
  });

  it('asks for Locked items only while the session is unlocked, and keeps them only then', async () => {
    const locked = asset('locked', { visibility: AssetVisibility.Locked });
    const sdk = api({
      searchAssets: vi.fn(({ metadataSearchDto }) =>
        Promise.resolve(page(metadataSearchDto.visibility === AssetVisibility.Locked ? [locked] : [asset('plain')])),
      ),
    });

    const closed = await searchStudioLibrary({}, { language: 'en', elevated: false, api: sdk as never });
    expect(sdk.searchAssets).toHaveBeenCalledTimes(1);
    expect(closed.items.map((item) => item.id)).toEqual(['plain']);

    sessionAccess.isElevated = true;
    const open = await searchStudioLibrary({}, { language: 'en', elevated: true, api: sdk as never });
    expect(sdk.searchAssets).toHaveBeenLastCalledWith(
      { metadataSearchDto: expect.objectContaining({ visibility: AssetVisibility.Locked }) },
      { signal: undefined },
    );
    expect(open.items.map((item) => item.id)).toEqual(['plain', 'locked']);
  });

  it('never hands the editor trashed, audio or (while locked) Locked items, even if a search returns them', async () => {
    const sdk = api({
      searchAssets: vi
        .fn()
        .mockResolvedValue(
          page([
            asset('ok'),
            asset('trashed', { isTrashed: true }),
            asset('audio', { type: AssetTypeEnum.Audio }),
            asset('locked', { visibility: AssetVisibility.Locked }),
          ]),
        ),
    });
    const result = await searchStudioLibrary({}, { language: 'en', elevated: false, api: sdk as never });
    expect(result.items.map((item) => item.id)).toEqual(['ok']);
  });

  it('offers named people only, with places and months newest first', async () => {
    const sdk = api({
      searchFacets: vi.fn().mockResolvedValue({
        total: 9,
        facets: [
          {
            fieldName: SearchFacetField.People,
            counts: [
              { value: PERSON, label: 'Jamie', count: 4 },
              { value: '22222222-2222-4222-8222-222222222222', label: '', count: 9 },
            ],
          },
          { fieldName: SearchFacetField.City, counts: [{ value: 'Banff', count: 3 }] },
        ],
      }),
      searchHistogram: vi.fn().mockResolvedValue({
        granularity: SearchHistogramGranularity.Month,
        total: 6,
        buckets: [
          { date: '2025-12-01T00:00:00.000Z', count: 1 },
          { date: '2026-07-01T00:00:00.000Z', count: 5 },
          { date: '2026-08-01T00:00:00.000Z', count: 0 },
        ],
      }),
    });
    const facets = await studioLibraryFacets({ api: sdk as never, personThumbnailUrl: (id) => `/people/${id}` });
    expect(facets).toEqual({
      people: [{ id: PERSON, name: 'Jamie', count: 4, thumbnailUrl: `/people/${PERSON}` }],
      places: [{ value: 'Banff', count: 3 }],
      months: [
        { value: '2026-07', count: 5 },
        { value: '2025-12', count: 1 },
      ],
    });
    expect(sdk.searchFacets).toHaveBeenCalledWith(
      {
        searchFacetsDto: expect.objectContaining({
          visibility: AssetVisibility.Timeline,
          facets: [SearchFacetField.People, SearchFacetField.City],
        }),
      },
      { signal: undefined },
    );
  });

  it('turns a month into its exact range and ignores empty histogram months', () => {
    expect(monthRange('2026-12')).toEqual({
      takenAfter: '2026-12-01T00:00:00.000Z',
      takenBefore: '2027-01-01T00:00:00.000Z',
    });
    expect(
      histogramMonths({
        buckets: [{ date: '2026-01-01', count: 0 }],
        granularity: SearchHistogramGranularity.Month,
        total: 0,
      }),
    ).toEqual([]);
  });
});

describe('FL-636 adopting library results into the session', () => {
  const setup = (sdk = api(), offered: StudioAssetRef[] = []) => {
    const adopted: AssetResponseDto[] = [];
    const lookup = vi.fn((id: string) => Promise.resolve(asset(id)));
    const services = createStudioLibraryServices({
      language: () => 'en',
      elevated: () => sessionAccess.isElevated,
      offered: () => [...offered, ...adopted.map((item) => toStudioAsset(item))],
      adopt: (records) => {
        adopted.push(...records);
        return Promise.resolve();
      },
      lookup,
      personThumbnailUrl: (id) => `/people/${id}`,
      api: sdk as never,
    });
    return { services, adopted, lookup };
  };

  it('reads a search result again as this session before adopting it, and answers with its bin ref', async () => {
    const { services, adopted, lookup } = setup();
    await services.searchLibrary({ text: 'lake' });
    const refs = await services.addLibraryAssets(['SMART']);
    expect(lookup).toHaveBeenCalledExactlyOnceWith('smart');
    expect(adopted.map((item) => item.id)).toEqual(['smart']);
    expect(refs).toEqual([toStudioAsset(asset('smart'))]);
  });

  it('does not adopt a result whose access was revoked after the search', async () => {
    const { services, adopted, lookup } = setup();
    await services.searchLibrary({ text: 'lake' });
    lookup.mockRejectedValueOnce(new Error('403'));
    expect(await services.addLibraryAssets(['smart'])).toEqual([]);
    expect(adopted).toEqual([]);
  });

  it('does not read or adopt what is already offered', async () => {
    const present = toStudioAsset(asset('handoff'));
    const { services, adopted, lookup } = setup(api(), [present]);
    const refs = await services.addLibraryAssets(['handoff', 'other']);
    expect(lookup).toHaveBeenCalledExactlyOnceWith('other');
    expect(adopted.map((item) => item.id)).toEqual(['other']);
    expect(refs.map((item) => item.id)).toEqual(['handoff', 'other']);
  });

  it('does not adopt a Locked result once the session has locked again', async () => {
    sessionAccess.isElevated = true;
    const locked = asset('locked', { visibility: AssetVisibility.Locked });
    const sdk = api({
      searchAssets: vi.fn(({ metadataSearchDto }) =>
        Promise.resolve(page(metadataSearchDto.visibility === AssetVisibility.Locked ? [locked] : [])),
      ),
    });
    const { services, adopted, lookup } = setup(sdk);
    lookup.mockResolvedValue(locked);
    expect((await services.searchLibrary({})).items.map((item) => item.id)).toEqual(['locked']);
    sessionAccess.isElevated = false;
    expect(await services.addLibraryAssets(['locked'])).toEqual([]);
    expect(adopted).toEqual([]);
  });

  it('reads the filters once per session, and again after a failure', async () => {
    const searchFacets = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ facets: [], total: 0 });
    const { services } = setup(api({ searchFacets }));
    await expect(services.libraryFacets()).rejects.toThrow('offline');
    await services.libraryFacets();
    await services.libraryFacets();
    expect(searchFacets).toHaveBeenCalledTimes(2);
  });
});
