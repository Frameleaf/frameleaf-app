import { AssetTypeEnum, AssetVisibility, ImageEnrichmentFilter } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  contextDiscoveryState,
  discoverySearchRequest,
  discoveryUrl,
  emptyDiscoveryQuery,
  isDiscoveryFilter,
  isEmptyDiscoverySearch,
  migrateLegacySearch,
  parseDiscoveryQuery,
  parseDiscoveryQueryText,
  readDiscoveryQuery,
  readSearchLocation,
  structuredSearchRequest,
  toSearchDto,
  toServerDateCondition,
  toServerFilter,
  withDiscoveryFacet,
  withSearchDefaults,
  type DiscoveryQuery,
} from '$lib/components/discovery/query';

/**
 * FL-48: the structured search bridge is lossless. Every fixture here goes through the real
 * serialization a person's search takes — the URL, the search dialog's context, the request the
 * results page sends — and must come back exactly as it went in, or be refused out loud.
 */

const albumId = '11111111-2222-4333-8444-555555555555';
const spaceId = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const petId = '99999999-8888-4777-8666-555555555555';
const personA = 'aaaaaaaa-0000-4000-8000-000000000001';
const personB = 'aaaaaaaa-0000-4000-8000-000000000002';
const personC = 'aaaaaaaa-0000-4000-8000-000000000003';
const tagA = 'bbbbbbbb-0000-4000-8000-000000000001';
const tagB = 'bbbbbbbb-0000-4000-8000-000000000002';
const assetId = 'cccccccc-0000-4000-8000-000000000001';

const urlOf = (path: string) => new URL(`http://localhost${path}`);
const roundTrip = (query: DiscoveryQuery) => readDiscoveryQuery(urlOf(discoveryUrl(query)));

/** One query using every branch the source query supports. */
const everything = (): DiscoveryQuery => ({
  version: 1,
  text: 'lake at dusk',
  mode: 'text',
  textField: 'description',
  queryAssetId: assetId,
  spaceId,
  imageEnrichment: ImageEnrichmentFilter.NsfwReview,
  grouping: 'months',
  view: 'moments',
  filter: {
    personIds: { any: [personA], all: [personB], none: [personC] },
    tagIds: { any: [tagA], none: [tagB] },
    albumIds: { all: [albumId] },
    petIds: { none: [petId] },
    type: { in: [AssetTypeEnum.Image, AssetTypeEnum.Video] },
    visibility: { ne: AssetVisibility.Archive },
    city: { eq: null },
    country: { in: ['Canada', 'Norway'] },
    state: { notIn: ['Alberta'] },
    make: { eq: 'Fujifilm' },
    lensModel: { ne: null },
    rating: { gte: 3, lte: 5 },
    fileSizeInBytes: { gt: 1024 },
    takenAt: { gte: '2026-08-01', lt: '2026-09-01T00:00:00.000Z' },
    createdAt: { lte: '2026-09-22' },
    trashedAt: { eq: null },
    originalFileName: { startsWith: 'IMG_' },
    originalPath: { notLike: '/tmp/' },
    description: { endsWith: 'lake' },
    ocr: { matches: 'menu' },
    isFavorite: { eq: true },
    isMotion: { eq: false },
    hasPeople: { eq: true },
    hasAlbums: { eq: false },
    hasTags: { eq: true },
    or: [{ city: { eq: 'Banff' } }, { rating: { eq: null }, isEncoded: { eq: false } }],
  },
});

describe('the versioned query contract', () => {
  it('round-trips every source query branch through a URL unchanged', () => {
    const source = everything();
    expect(roundTrip(source)).toEqual(source);
  });

  it('round-trips excluded values, mixed operators and nested or branches without reordering them', () => {
    const source: DiscoveryQuery = {
      ...emptyDiscoveryQuery(),
      filter: {
        personIds: { none: [personA] },
        rating: { ne: 0, gt: 1 },
        or: [{ tagIds: { all: [tagA, tagB] } }, { hasTags: { eq: false } }],
      },
    };
    expect(roundTrip(source)).toEqual(source);
  });

  it('round-trips a selected value that currently matches nothing', () => {
    // A zero-match facet stays selected: nothing about its count removes it from the query.
    const source = withDiscoveryFacet(emptyDiscoveryQuery(), 'city', 'Nowhere-that-exists');
    expect(roundTrip(source).filter.city).toEqual({ eq: 'Nowhere-that-exists' });
  });

  it('fills missing presentation fields with their defaults and never shares objects with the input', () => {
    const input = { version: 1, filter: { isFavorite: { eq: true } } };
    const result = parseDiscoveryQuery(input);
    expect(result).toEqual({ ok: true, query: { ...emptyDiscoveryQuery(), filter: { isFavorite: { eq: true } } } });
    if (result.ok) {
      result.query.filter.isFavorite = { eq: false };
    }
    expect(input.filter.isFavorite).toEqual({ eq: true });
  });

  it('refuses a newer contract version explicitly instead of reading it as an older one', () => {
    expect(parseDiscoveryQuery({ ...everything(), version: 2 })).toEqual({ ok: false, problem: 'unsupported-version' });
    expect(parseDiscoveryQuery({ ...everything(), version: 'one' })).toEqual({ ok: false, problem: 'malformed' });
    expect(parseDiscoveryQuery({ ...everything(), version: 0 })).toEqual({ ok: false, problem: 'malformed' });
  });

  it('fails safely on malformed payloads', () => {
    for (const raw of ['not-json', '[]', 'null', '"text"', '{"version":1,"filter":[]}', 'x'.repeat(40_000)]) {
      expect(parseDiscoveryQueryText(raw).ok).toBe(false);
    }
    expect(readDiscoveryQuery(urlOf('/search?dq=%7Bbroken'))).toEqual(emptyDiscoveryQuery());
  });

  it('refuses conditions the search DTO would refuse, so the API is never handed them', () => {
    const invalid: unknown[] = [
      { unknownField: { eq: 'x' } },
      { isFavorite: { eq: true, ne: false } },
      { isFavorite: { eq: 'true' } },
      { personIds: { any: [] } },
      { personIds: { eq: personA } },
      { city: { like: 'Banff' } },
      { ocr: { like: 'menu' } },
      { originalFileName: { like: '' } },
      { type: { eq: 'photo-ish' } },
      { visibility: { eq: 'everything' } },
      { rating: { gte: 'four' } },
      { fileSizeInBytes: { eq: null } },
      { takenAt: { gte: '2026-02-30' } },
      { takenAt: { gte: 'yesterday' } },
      { takenAt: { eq: null } },
      { takenAt: { ne: '2026-08-01' } },
      { or: [] },
      { or: [{}] },
      { or: [{ or: [{ city: { eq: 'Banff' } }] }] },
      { city: { eq: 'x'.repeat(4097) } },
      { ['__proto__']: { eq: 'x' } },
    ];
    for (const filter of invalid) {
      expect(isDiscoveryFilter(filter), JSON.stringify(filter)).toBe(false);
      expect(parseDiscoveryQuery({ version: 1, filter }).ok).toBe(false);
    }
  });

  it('accepts calendar days, datetimes with an offset and null trash dates', () => {
    expect(isDiscoveryFilter({ takenAt: { gte: '2024-02-29', lte: '2026-08-31T23:59:59.999+02:00' } })).toBe(true);
    expect(isDiscoveryFilter({ trashedAt: { ne: null } })).toBe(true);
    expect(isDiscoveryFilter({ takenAt: { ne: '2026-08-01T00:00:00.000Z' } })).toBe(true);
  });

  it('refuses unknown context values rather than forwarding them', () => {
    expect(parseDiscoveryQuery({ version: 1, textField: 'everywhere' }).ok).toBe(false);
    expect(parseDiscoveryQuery({ version: 1, imageEnrichment: 'bogus' }).ok).toBe(false);
    expect(parseDiscoveryQuery({ version: 1, queryAssetId: 7 }).ok).toBe(false);
    expect(parseDiscoveryQuery({ version: 1, mode: 'magic' }).ok).toBe(false);
    expect(parseDiscoveryQuery({ version: 1, view: 'wall' }).ok).toBe(false);
  });

  it('reads earlier prototype and fork aliases as the conditions they always meant', () => {
    const result = parseDiscoveryQuery({
      version: 1,
      petIds: [petId, petId],
      filter: {
        person: { eq: personA },
        favorite: { eq: true },
        isArchived: { eq: false },
        isNotInAlbum: { eq: true },
        type: { eq: 'photo' },
        rating: { eq: '4' },
        tagIds: [tagA, tagA],
      },
    });
    expect(result).toEqual({
      ok: true,
      query: {
        ...emptyDiscoveryQuery(),
        filter: {
          personIds: { any: [personA] },
          isFavorite: { eq: true },
          visibility: { ne: AssetVisibility.Archive },
          hasAlbums: { eq: false },
          type: { eq: AssetTypeEnum.Image },
          // the prototype's minimum-rating select meant "at least"
          rating: { gte: 4 },
          tagIds: { all: [tagA] },
          petIds: { any: [petId] },
        },
      },
    });
  });
});

describe('legacy search migration', () => {
  it('migrates every flat field with the meaning the server gives it', () => {
    const migration = migrateLegacySearch({
      query: 'dog on the beach',
      city: 'Banff',
      state: null,
      country: 'Canada',
      make: 'Fujifilm',
      model: 'X100V',
      lensModel: null,
      type: AssetTypeEnum.Video,
      visibility: AssetVisibility.Archive,
      isFavorite: false,
      isMotion: true,
      isEncoded: false,
      rating: null,
      personIds: [personA, personB],
      petIds: [petId],
      albumIds: [albumId],
      tagIds: [tagA],
      takenAfter: '2026-01-01T00:00:00.000Z',
      takenBefore: '2026-12-31T23:59:59.999Z',
      createdAfter: '2025-01-01T00:00:00.000Z',
      updatedBefore: '2026-09-01T00:00:00.000Z',
      originalFileName: 'IMG',
      description: 'sunset',
      ocr: 'menu',
      originalPath: '/library/2026',
      id: assetId,
      libraryId: null,
      checksum: 'abc123',
      imageEnrichment: ImageEnrichmentFilter.MissingImageDescription,
      page: 3,
      size: 100,
      withExif: true,
      language: 'en',
    });
    expect(migration.unsupported).toEqual([]);
    expect(migration.query).toEqual({
      ...emptyDiscoveryQuery(),
      text: 'dog on the beach',
      mode: 'smart',
      imageEnrichment: ImageEnrichmentFilter.MissingImageDescription,
      filter: {
        originalFileName: { like: 'IMG' },
        description: { like: 'sunset' },
        ocr: { matches: 'menu' },
        originalPath: { like: '/library/2026' },
        city: { eq: 'Banff' },
        state: { eq: null },
        country: { eq: 'Canada' },
        make: { eq: 'Fujifilm' },
        model: { eq: 'X100V' },
        lensModel: { eq: null },
        type: { eq: AssetTypeEnum.Video },
        visibility: { eq: AssetVisibility.Archive },
        isFavorite: { eq: false },
        isMotion: { eq: true },
        isEncoded: { eq: false },
        rating: { eq: null },
        personIds: { all: [personA, personB] },
        petIds: { all: [petId] },
        albumIds: { all: [albumId] },
        tagIds: { all: [tagA] },
        takenAt: { gte: '2026-01-01T00:00:00.000Z', lte: '2026-12-31T23:59:59.999Z' },
        createdAt: { gte: '2025-01-01T00:00:00.000Z' },
        updatedAt: { lte: '2026-09-01T00:00:00.000Z' },
        id: { eq: assetId },
        libraryId: { eq: null },
        checksum: { eq: 'abc123' },
      },
    });
  });

  it('keeps the similar-photo reference as search context', () => {
    const migration = migrateLegacySearch({ queryAssetId: assetId, originalFileName: 'IMG' });
    expect(migration.unsupported).toEqual([]);
    expect(migration.query).toMatchObject({ mode: 'smart', text: '', queryAssetId: assetId });
    expect(migration.query.filter).toEqual({ originalFileName: { like: 'IMG' } });
  });

  it('keeps each text mode in its own field so the dialog reopens on it', () => {
    for (const field of ['originalFileName', 'description', 'ocr', 'originalPath'] as const) {
      expect(migrateLegacySearch({ [field]: 'term' }).query).toMatchObject({
        text: 'term',
        mode: 'text',
        textField: field,
        filter: {},
      });
    }
  });

  it('reads a structured request from the search dialog, including its folded text field', () => {
    const migration = migrateLegacySearch({
      filter: { personIds: { none: [personA] }, or: [{ city: { eq: 'Banff' } }, { city: { eq: 'Jasper' } }] },
      ocr: 'receipt',
      imageEnrichment: ImageEnrichmentFilter.Nsfw,
    });
    expect(migration.unsupported).toEqual([]);
    expect(migration.query).toMatchObject({ text: 'receipt', mode: 'text', textField: 'ocr' });
    expect(migration.query.filter).toEqual({
      personIds: { none: [personA] },
      or: [{ city: { eq: 'Banff' } }, { city: { eq: 'Jasper' } }],
    });
  });

  it('ignores "not in any album" beside an album list, exactly as the flat search does', () => {
    expect(migrateLegacySearch({ isNotInAlbum: true, albumIds: [albumId] }).query.filter).toEqual({
      albumIds: { all: [albumId] },
    });
    expect(migrateLegacySearch({ isNotInAlbum: false }).query.filter).toEqual({});
  });

  it('refuses what a structured query cannot carry instead of dropping it', () => {
    expect(migrateLegacySearch({ withDeleted: true, city: 'Banff' }).unsupported).toEqual(['withDeleted']);
    expect(migrateLegacySearch({ isOffline: true }).unsupported).toEqual(['isOffline']);
    expect(migrateLegacySearch({ suppressedOnly: true }).unsupported).toEqual(['suppressedOnly']);
    expect(migrateLegacySearch({ previewPath: '/x', thumbnailPath: '/y' }).unsupported).toEqual([
      'previewPath',
      'thumbnailPath',
    ]);
    expect(migrateLegacySearch({ somethingNew: 1 }).unsupported).toEqual(['somethingNew']);
    // a flat condition on a field the filter already constrains cannot ride beside it
    expect(migrateLegacySearch({ filter: { city: { ne: 'Banff' } }, city: 'Jasper' }).unsupported).toEqual(['city']);
    expect(migrateLegacySearch({ takenAfter: 'not a date' }).unsupported).toEqual(['takenAfter']);
    expect(migrateLegacySearch({ takenAfter: '2026-02-30' }).unsupported).toEqual(['takenAfter']);
    expect(migrateLegacySearch({ filter: { city: { like: 'x' } } }).unsupported).toEqual(['filter']);
    expect(migrateLegacySearch('nope').unsupported).toEqual(['query']);
  });

  it('carries the trash bounds that imply the trash, and the default that leaves it out', () => {
    const migration = migrateLegacySearch({ withDeleted: true, trashedAfter: '2026-01-01T00:00:00.000Z' });
    expect(migration.unsupported).toEqual([]);
    expect(migration.query.filter).toEqual({ trashedAt: { gte: '2026-01-01T00:00:00.000Z' } });
    expect(migrateLegacySearch({ withDeleted: false }).unsupported).toEqual([]);
  });

  it('migrates tagIds null to untagged', () => {
    expect(migrateLegacySearch({ tagIds: null }).query.filter).toEqual({ hasTags: { eq: false } });
  });
});

describe('the search a page shows', () => {
  it('reads the shared query from dq and the legacy request from query', () => {
    const query = everything();
    expect(readSearchLocation(urlOf(discoveryUrl(query)))).toEqual({ kind: 'discovery', query });

    const legacy = urlOf(`/search?query=${encodeURIComponent(JSON.stringify({ city: 'Banff' }))}`);
    const location = readSearchLocation(legacy);
    expect(location.kind).toBe('legacy');
    if (location.kind === 'legacy') {
      expect(location.terms).toEqual({ city: 'Banff' });
      expect(location.migration.query.filter).toEqual({ city: { eq: 'Banff' } });
    }
  });

  it('reports a damaged or newer link instead of throwing', () => {
    expect(readSearchLocation(urlOf('/search?query=%7Bbroken'))).toEqual({ kind: 'rejected', problem: 'malformed' });
    expect(readSearchLocation(urlOf('/search?query=%5B%5D'))).toEqual({ kind: 'rejected', problem: 'malformed' });
    const newer = urlOf('/search');
    newer.searchParams.set('dq', JSON.stringify({ ...everything(), version: 3 }));
    expect(readSearchLocation(newer)).toEqual({ kind: 'rejected', problem: 'unsupported-version' });
    expect(readSearchLocation(urlOf('/search'))).toEqual({ kind: 'empty' });
    expect(readSearchLocation(urlOf('/search?query=%7B%7D'))).toEqual({ kind: 'empty' });
  });

  it('reopens the search dialog on exactly the search the results page shows, even with an item open', () => {
    const query = everything();
    const [path, search] = discoveryUrl(query).split('?', 2);
    expect(contextDiscoveryState(urlOf(`${path}/photos/${assetId}?${search}`))).toEqual({ query, unsupported: [] });
  });

  it('reopens a legacy search migrated, and names what it could not carry', () => {
    const url = urlOf(`/search?query=${encodeURIComponent(JSON.stringify({ city: 'Banff', withDeleted: true }))}`);
    const context = contextDiscoveryState(url);
    expect(context.query.filter).toEqual({ city: { eq: 'Banff' } });
    expect(context.unsupported).toEqual(['withDeleted']);
  });

  it('opens on an empty query for a damaged link rather than failing', () => {
    expect(contextDiscoveryState(urlOf('/search?dq=nope'))).toEqual({ query: emptyDiscoveryQuery(), unsupported: [] });
  });
});

describe('searching from a scope keeps the scope', () => {
  const typed = (query: DiscoveryQuery, text: string): DiscoveryQuery => ({ ...query, text });

  it('keeps the album when only the text changes', () => {
    const { query } = contextDiscoveryState(urlOf(`/albums/${albumId}`));
    const request = discoverySearchRequest(typed(query, 'IMG_1'));
    expect(request.filter?.albumIds).toEqual({ any: [albumId] });
    expect(request.filter?.originalFileName).toEqual({ like: 'IMG_1' });
  });

  it('keeps the pet when only the text changes', () => {
    const { query } = contextDiscoveryState(urlOf(`/pets/${petId}`));
    expect(discoverySearchRequest(typed(query, 'garden')).filter?.petIds).toEqual({ any: [petId] });
  });

  it('keeps the shared space when only the text changes, as the album condition it is', () => {
    const { query } = contextDiscoveryState(urlOf(`/sharing/${spaceId}`));
    expect(query.spaceId).toBe(spaceId);
    const smart = { ...typed(query, 'birthday'), mode: 'smart' as const };
    expect(discoverySearchRequest(smart)).toMatchObject({
      query: 'birthday',
      filter: { albumIds: { any: [spaceId] } },
    });
    // and the space survives the results page's URL, so reopening the dialog there keeps it
    expect(roundTrip(smart).spaceId).toBe(spaceId);
  });

  it('never tags a search opened from the map with a map results view (FL-48 map/space follow-ups)', () => {
    // The prototype (App.jsx `exploreQuery`/`MapView`'s "Search this area") always lands a submitted
    // search on the plain grid results, never on a persisted map view the results page would ignore.
    const { query } = contextDiscoveryState(urlOf('/map'));
    expect(query.view).toBe('photos');
    expect(roundTrip(typed(query, 'harbour')).view).toBe('photos');
  });

  it('still round-trips an explicit map view once one is already on a query', () => {
    // A view the contract already carries (a stored preset, an older link) is never mutated on
    // read — only /map itself stops manufacturing one for a freshly opened search.
    const query: DiscoveryQuery = { ...emptyDiscoveryQuery(), view: 'map' };
    expect(roundTrip(typed(query, 'harbour')).view).toBe('map');
  });

  it('requires the space on top of an album condition rather than replacing it', () => {
    const query: DiscoveryQuery = { ...emptyDiscoveryQuery(), spaceId, filter: { albumIds: { any: [albumId] } } };
    expect(toSearchDto(query).filter?.albumIds).toEqual({ any: [albumId], all: [spaceId] });
  });

  it('keeps the similar-photo reference when the text changes', () => {
    const query: DiscoveryQuery = { ...emptyDiscoveryQuery(), mode: 'smart', queryAssetId: assetId };
    expect(discoverySearchRequest(typed(query, 'at night'))).toMatchObject({
      query: 'at night',
      queryAssetId: assetId,
    });
  });
});

describe('handing the query to the server', () => {
  it('writes text to the query text field, the file name by default', () => {
    const base = { ...emptyDiscoveryQuery(), text: 'receipt' };
    expect(toSearchDto(base)).toEqual({ originalFileName: 'receipt' });
    expect(toSearchDto({ ...base, textField: 'ocr' })).toEqual({ ocr: 'receipt' });
    expect(toSearchDto({ ...base, textField: 'ocr', mode: 'smart' })).toEqual({ query: 'receipt' });
  });

  it('turns calendar days into the instant ranges they mean', () => {
    expect(toServerDateCondition({ gte: '2026-08-01' })).toEqual({ gte: '2026-08-01T00:00:00.000Z' });
    expect(toServerDateCondition({ lte: '2026-08-31' })).toEqual({ lt: '2026-09-01T00:00:00.000Z' });
    expect(toServerDateCondition({ lt: '2026-08-31' })).toEqual({ lt: '2026-08-31T00:00:00.000Z' });
    expect(toServerDateCondition({ gt: '2026-08-31' })).toEqual({ gte: '2026-09-01T00:00:00.000Z' });
    expect(toServerDateCondition({ eq: '2024-02-29' })).toEqual({
      gte: '2024-02-29T00:00:00.000Z',
      lt: '2024-03-01T00:00:00.000Z',
    });
    // Datetimes pass through, and the narrowest bound on each side wins.
    expect(toServerDateCondition({ gte: '2026-08-02', lt: '2026-09-01T00:00:00.000Z' })).toEqual({
      gte: '2026-08-02T00:00:00.000Z',
      lt: '2026-09-01T00:00:00.000Z',
    });
    expect(toServerDateCondition({ lte: '2026-08-31', lt: '2026-08-15T12:00:00.000Z' })).toEqual({
      lt: '2026-08-15T12:00:00.000Z',
    });
    expect(toServerDateCondition({ eq: null })).toEqual({ eq: null });
  });

  it('converts dates inside or branches and leaves other fields alone', () => {
    const filter = {
      city: { eq: 'Banff' },
      or: [{ takenAt: { gte: '2026-01-01' } }, { createdAt: { lte: '2026-01-31' } }],
    };
    expect(toServerFilter(filter)).toEqual({
      city: { eq: 'Banff' },
      or: [{ takenAt: { gte: '2026-01-01T00:00:00.000Z' } }, { createdAt: { lt: '2026-02-01T00:00:00.000Z' } }],
    });
    expect(filter.or[0].takenAt).toEqual({ gte: '2026-01-01' });
  });

  it('applies the timeline and no-trash defaults only where the filter says nothing, in any branch', () => {
    expect(withSearchDefaults({})).toEqual({
      visibility: { eq: AssetVisibility.Timeline },
      trashedAt: { eq: null },
    });
    expect(
      withSearchDefaults({ or: [{ visibility: { eq: AssetVisibility.Archive } }, { isFavorite: { eq: true } }] }),
    ).toEqual({
      trashedAt: { eq: null },
      or: [
        { visibility: { eq: AssetVisibility.Archive } },
        { isFavorite: { eq: true }, visibility: { eq: AssetVisibility.Timeline } },
      ],
    });
  });

  it('ANDs typed text into a field the filter already uses, without losing either', () => {
    expect(
      structuredSearchRequest({ filter: { originalFileName: { startsWith: 'IMG' } }, originalFileName: '2026' }).filter
        ?.originalFileName,
    ).toEqual({ startsWith: 'IMG', like: '2026' });
    expect(
      structuredSearchRequest({ filter: { originalFileName: { like: 'IMG' } }, originalFileName: '2026' }).filter,
    ).toMatchObject({ originalFileName: { like: 'IMG' }, or: [{ originalFileName: { like: '2026' } }] });
  });

  it('sends every date bound of a query in the form the DTO accepts', () => {
    const query: DiscoveryQuery = {
      ...emptyDiscoveryQuery(),
      filter: { takenAt: { gte: '2026-08-01', lte: '2026-08-31' } },
    };
    expect(discoverySearchRequest(query).filter?.takenAt).toEqual({
      gte: '2026-08-01T00:00:00.000Z',
      lt: '2026-09-01T00:00:00.000Z',
    });
  });
});

describe('facets and empty searches', () => {
  it('adds a facet without dropping the all-of and exclude groups', () => {
    const query: DiscoveryQuery = {
      ...emptyDiscoveryQuery(),
      filter: { personIds: { all: [personA], none: [personC] } },
    };
    expect(withDiscoveryFacet(query, 'personIds', personB).filter.personIds).toEqual({
      all: [personA],
      none: [personC],
      any: [personB],
    });
  });

  it('knows a query that searches for nothing in particular', () => {
    expect(isEmptyDiscoverySearch(emptyDiscoveryQuery())).toBe(true);
    expect(isEmptyDiscoverySearch({ ...emptyDiscoveryQuery(), text: '  ' })).toBe(true);
    expect(isEmptyDiscoverySearch({ ...emptyDiscoveryQuery(), spaceId })).toBe(false);
    expect(isEmptyDiscoverySearch({ ...emptyDiscoveryQuery(), queryAssetId: assetId })).toBe(false);
    expect(isEmptyDiscoverySearch({ ...emptyDiscoveryQuery(), imageEnrichment: ImageEnrichmentFilter.Nsfw })).toBe(
      false,
    );
  });
});
