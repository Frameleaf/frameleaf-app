import { AssetTypeEnum, ImageEnrichmentFilter, SearchFacetField } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { emptyDiscoveryQuery, isDiscoveryFilter, type DiscoveryQuery } from '$lib/components/discovery/query';
import { emptyFilterPanelOptions } from '$lib/frameleaf/search-options';
import {
  allTextBranches,
  bucketsByYear,
  buildPaletteCatalog,
  commitCompletedTokens,
  compilePaletteQuery,
  facetsByField,
  formatScopeCount,
  fromSavedSearch,
  histogramBars,
  histogramUnitFor,
  narrowToBar,
  paletteScopeOf,
  paletteSearchBody,
  paletteStatisticsBody,
  parseSearchInput,
  readAllText,
  readPaletteState,
  rememberRecentSearch,
  removeSearchToken,
  suggestSearchTokens,
  tokenLabel,
  toSavedSearch,
  upsertSavedSearch,
  withAllText,
  withoutPaletteScope,
  withoutTokensForFields,
  withPaletteScope,
  type PaletteCatalog,
} from '$lib/frameleaf/search-palette';

const JAMIE = '00000000-0000-4000-8000-000000000001';
const ROBIN = '00000000-0000-4000-8000-000000000002';
const UNNAMED = '00000000-0000-4000-8000-000000000003';
const WATER = '00000000-0000-4000-8000-000000000010';
const ALBUM = '00000000-0000-4000-8000-000000000020';
const OTHER_ALBUM = '00000000-0000-4000-8000-000000000021';

const catalog: PaletteCatalog = {
  people: [
    { id: JAMIE, name: 'Jamie', count: 40 },
    { id: ROBIN, name: 'Robin Lee', count: 12 },
    { id: UNNAMED, name: '', count: 99 },
  ],
  tags: [{ id: WATER, label: 'water', count: 7 }],
  places: [
    { value: 'Banff', count: 30 },
    { value: 'Lake Louise', count: 9 },
  ],
  makes: [{ value: 'Sony', count: 50 }, { value: 'Canon' }],
  models: [{ value: 'ILCE-7M4' }, { value: 'EOS R5' }],
  lenses: [{ value: 'FE 24-70mm F2.8 GM' }, { value: 'RF 15-35mm' }],
  years: [
    { value: '2026', count: 80 },
    { value: '2025', count: 20 },
  ],
  typeCounts: { [AssetTypeEnum.Image]: 90, [AssetTypeEnum.Video]: 10 },
  favoriteCount: 5,
};

const translate = ((key: string, options?: { values?: Record<string, unknown> }) =>
  options?.values ? `${key}(${JSON.stringify(options.values)})` : key) as never;

describe('parseSearchInput', () => {
  it('compiles every operator to the structured search filter', () => {
    const { text, filter, tokens } = parseSearchInput(
      'hiking person:Jamie -person:"Robin Lee" tag:water place:Banff type:video camera:sony lens:24-70 ' +
        'rating:4 is:favorite year:2026 file:IMG_ text:"lake agnes" path:2026/',
      catalog,
    );
    expect(text).toBe('hiking');
    expect(filter).toEqual({
      personIds: { all: [JAMIE], none: [ROBIN] },
      tagIds: { all: [WATER] },
      city: { eq: 'Banff' },
      type: { eq: AssetTypeEnum.Video },
      make: { eq: 'Sony' },
      lensModel: { eq: 'FE 24-70mm F2.8 GM' },
      rating: { gte: 4 },
      isFavorite: { eq: true },
      takenAt: { gte: '2026-01-01T00:00:00.000Z', lt: '2027-01-01T00:00:00.000Z' },
      originalFileName: { like: 'IMG_' },
      ocr: { matches: 'lake agnes' },
      originalPath: { like: '2026/' },
    });
    expect(tokens.map((token) => token.key)).toEqual([
      'person',
      'person',
      'tag',
      'place',
      'type',
      'camera',
      'lens',
      'rating',
      'is',
      'year',
      'file',
      'text',
      'path',
    ]);
    // Everything the palette compiles is a filter the server accepts
    expect(isDiscoveryFilter(filter)).toBe(true);
  });

  it('excludes with a leading minus using ne, notIn, none and notLike', () => {
    const { filter } = parseSearchInput(
      '-place:Banff -place:"Lake Louise" -type:photo -camera:canon -lens:RF -tag:water -file:tmp -path:cache -is:fav',
      catalog,
    );
    expect(filter).toEqual({
      city: { notIn: ['Banff', 'Lake Louise'] },
      type: { ne: AssetTypeEnum.Image },
      make: { ne: 'Canon' },
      lensModel: { ne: 'RF 15-35mm' },
      tagIds: { none: [WATER] },
      originalFileName: { notLike: 'tmp' },
      originalPath: { notLike: 'cache' },
      isFavorite: { eq: false },
    });
    expect(isDiscoveryFilter(filter)).toBe(true);
  });

  it('matches cameras and lenses by "contains" over the library vocabulary only', () => {
    expect(parseSearchInput('camera:EOS', catalog).filter).toEqual({ model: { eq: 'EOS R5' } });
    expect(parseSearchInput('camera:o', catalog).filter).toEqual({ make: { in: ['Sony', 'Canon'] } });
    // Nothing in the library matches: the operator stays text instead of inventing a condition
    const unknown = parseSearchInput('camera:Nikon lens:85mm', catalog);
    expect(unknown.filter).toEqual({});
    expect(unknown.text).toBe('camera:Nikon lens:85mm');
  });

  it('leaves unresolvable and unsupported operators in the text', () => {
    const result = parseSearchInput(
      'person:Nobody person:unnamed -rating:3 rating:9 -text:menu month:2026-13 after:2026-02-30 is:archived foo:bar',
      catalog,
    );
    expect(result.filter).toEqual({});
    expect(result.tokens).toEqual([]);
    expect(result.text).toBe(
      'person:Nobody person:unnamed -rating:3 rating:9 -text:menu month:2026-13 after:2026-02-30 is:archived foo:bar',
    );
  });

  it('narrows capture dates to the tightest range and brackets after/before as the prototype does', () => {
    expect(parseSearchInput('month:2026-08 after:2026-08-12 before:2026-08-15', catalog).filter).toEqual({
      takenAt: { gte: '2026-08-13T00:00:00.000Z', lt: '2026-08-15T00:00:00.000Z' },
    });
  });

  it('reads two places or types as either one', () => {
    expect(parseSearchInput('place:Banff place:"Lake Louise"', catalog).filter).toEqual({
      city: { in: ['Banff', 'Lake Louise'] },
    });
  });

  it('labels chips in plain language', () => {
    const { tokens } = parseSearchInput('-person:Jamie camera:Sony rating:4 type:video', catalog);
    expect(tokens.map((token) => tokenLabel(translate, token))).toEqual([
      'frameleaf_search_token_not({"label":"Jamie"})',
      'frameleaf_search_token_camera({"value":"Sony"})',
      'frameleaf_search_token_rating({"count":4})',
      'videos',
    ]);
  });
});

describe('token editing', () => {
  it('removes one token by its raw text', () => {
    expect(removeSearchToken('beach person:Jamie sunset', 'person:Jamie')).toBe('beach sunset');
  });

  it('commits completed operators to chips and leaves the one being typed', () => {
    expect(commitCompletedTokens('person:Jamie beach type:vid', catalog)).toEqual({
      tokens: ['person:Jamie'],
      rest: 'beach type:vid',
    });
    expect(commitCompletedTokens('camera:Nikon person:Jamie ', catalog)).toEqual({
      tokens: ['person:Jamie'],
      rest: 'camera:Nikon ',
    });
  });

  it('replaces a typed chip when a graphical pick sets the same field', () => {
    const tokens = ['person:Jamie', 'place:Banff', 'year:2026', 'after:2026-01-02'];
    expect(withoutTokensForFields(tokens, ['personIds'], catalog)).toEqual([
      'place:Banff',
      'year:2026',
      'after:2026-01-02',
    ]);
    expect(withoutTokensForFields(tokens, new Set(['takenAt', 'city']), catalog)).toEqual(['person:Jamie']);
  });
});

describe('suggestSearchTokens', () => {
  it('completes a bare word into operator tokens with counts, busiest first', () => {
    const suggestions = suggestSearchTokens('beach ba', catalog);
    expect(suggestions[0]).toMatchObject({
      kind: 'place',
      label: 'Banff',
      detail: 'place:Banff',
      count: 30,
      insert: 'beach place:Banff ',
    });
  });

  it('skips unnamed people and carries the person id for the face photo', () => {
    const people = suggestSearchTokens('person:', catalog);
    expect(people.map((item) => item.label)).toEqual(['Jamie', 'Robin Lee']);
    expect(people[0].personId).toBe(JAMIE);
    expect(people[1].insert).toBe('person:"Robin Lee" ');
  });

  it('keeps the exclusion and offers operators for a typed key', () => {
    expect(suggestSearchTokens('-ja', catalog)[0].insert).toBe('-person:Jamie ');
    const operators = suggestSearchTokens('ca', catalog).filter((item) => item.kind === 'operator');
    expect(operators.map((item) => item.insert)).toEqual(['camera:']);
  });

  it('suggests nothing for an empty word', () => {
    expect(suggestSearchTokens('beach ', catalog)).toEqual([]);
  });
});

describe('date histogram', () => {
  it('chooses days, months or years from the span', () => {
    expect(histogramUnitFor([{ date: '2026-08-01' }, { date: '2026-09-01' }])).toBe('day');
    expect(histogramUnitFor([{ date: '2024-01-01' }, { date: '2026-08-01' }])).toBe('month');
    expect(histogramUnitFor([{ date: '2019-01-01' }, { date: '2026-08-01' }])).toBe('year');
  });

  it('folds months into years and fills the gaps', () => {
    const years = bucketsByYear([
      { date: '2019-03-01', count: 2 },
      { date: '2019-07-01', count: 3 },
      { date: '2021-01-01', count: 1 },
    ]);
    expect(years).toEqual([
      { date: '2019-01-01', count: 5 },
      { date: '2021-01-01', count: 1 },
    ]);
    expect(histogramBars(years, 'year')).toEqual([
      { start: '2019-01-01', end: '2020-01-01', count: 5 },
      { start: '2020-01-01', end: '2021-01-01', count: 0 },
      { start: '2021-01-01', end: '2022-01-01', count: 1 },
    ]);
  });

  it('narrows to a clicked bar, replacing typed date chips', () => {
    const [bar] = histogramBars([{ date: '2026-08-01', count: 4 }], 'month');
    const tokens = narrowToBar(['person:Jamie', 'year:2026', 'before:2026-12-01'], bar);
    expect(tokens).toEqual(['person:Jamie', 'after:2026-07-31', 'before:2026-09-01']);
    // The chips select exactly the bar's range
    expect(parseSearchInput(tokens.join(' '), catalog).filter.takenAt).toEqual({
      gte: '2026-08-01T00:00:00.000Z',
      lt: '2026-09-01T00:00:00.000Z',
    });
  });
});

describe('compiling the palette', () => {
  const base = (): DiscoveryQuery => ({ ...emptyDiscoveryQuery(), filter: { albumIds: { any: [ALBUM] } } });

  it('puts typed filters over the base and the text in the mode field', () => {
    const parsed = parseSearchInput('beach person:Jamie', catalog);
    expect(compilePaletteQuery(base(), parsed, 'smart')).toMatchObject({
      mode: 'smart',
      text: 'beach',
      filter: { albumIds: { any: [ALBUM] }, personIds: { all: [JAMIE] } },
    });
    const description = compilePaletteQuery(base(), parsed, 'description')!;
    expect(description).toMatchObject({ mode: 'text', text: 'beach', textField: 'description' });
    expect(compilePaletteQuery(base(), parsed, 'originalFileName')!.textField).toBeUndefined();
  });

  it('searches every text field for "All text" and reads it back', () => {
    const query = compilePaletteQuery(base(), parseSearchInput('agnes', catalog), 'all')!;
    expect(query.text).toBe('');
    expect(query.filter.or).toEqual(allTextBranches('agnes'));
    expect(isDiscoveryFilter(query.filter)).toBe(true);
    expect(readAllText(query.filter)).toBe('agnes');
    expect(readPaletteState(query)).toMatchObject({ input: 'agnes', mode: 'all' });
    expect(readPaletteState(query).base.filter.or).toBeUndefined();
  });

  it('distributes "All text" into an existing or, within the branch limit', () => {
    const filter = withAllText({ or: [{ city: { eq: 'Banff' } }, { originalFileName: { like: 'x' } }] }, 'lake');
    expect(filter?.or).toHaveLength(7);
    expect(
      withAllText({ or: Array.from({ length: 20 }, () => ({ isFavorite: { eq: true } })) }, 'lake'),
    ).toBeUndefined();
  });

  it('opens a query in its mode with its text', () => {
    expect(readPaletteState({ ...emptyDiscoveryQuery(), text: 'IMG', textField: 'originalPath' })).toMatchObject({
      input: 'IMG',
      mode: 'originalPath',
      base: { text: '' },
    });
    expect(readPaletteState({ ...emptyDiscoveryQuery(), text: 'dogs', mode: 'smart' }).mode).toBe('smart');
  });

  it('sends the results page body, and only filter and enrichment to the count endpoints', () => {
    const query: DiscoveryQuery = {
      ...emptyDiscoveryQuery(),
      text: 'IMG',
      imageEnrichment: ImageEnrichmentFilter.NsfwReview,
    };
    const body = paletteSearchBody(query);
    expect(body.filter?.originalFileName).toEqual({ like: 'IMG' });
    expect(body.filter?.visibility).toEqual({ eq: 'timeline' });
    expect(paletteStatisticsBody(body)).toEqual({ filter: body.filter, imageEnrichment: 'nsfw-review' });
  });
});

describe('scope', () => {
  it('reads the collection a page stands for and searches the library without it', () => {
    const query: DiscoveryQuery = {
      ...emptyDiscoveryQuery(),
      filter: { albumIds: { any: [ALBUM] }, isFavorite: { eq: true } },
    };
    const scope = paletteScopeOf(query);
    expect(scope).toEqual({ kind: 'album', id: ALBUM });
    expect(withoutPaletteScope(query, scope).filter).toEqual({ isFavorite: { eq: true } });
    expect(paletteScopeOf({ ...emptyDiscoveryQuery(), spaceId: ALBUM })).toEqual({ kind: 'space', id: ALBUM });
    expect(
      withoutPaletteScope({ ...emptyDiscoveryQuery(), spaceId: ALBUM }, { kind: 'space', id: ALBUM }).spaceId,
    ).toBe(undefined);
  });

  it('requires the scope again without widening it', () => {
    const scope = { kind: 'album' as const, id: ALBUM };
    expect(withPaletteScope(emptyDiscoveryQuery(), scope).filter).toEqual({ albumIds: { any: [ALBUM] } });
    const picked: DiscoveryQuery = { ...emptyDiscoveryQuery(), filter: { albumIds: { any: [OTHER_ALBUM] } } };
    expect(withPaletteScope(picked, scope).filter.albumIds).toEqual({ any: [OTHER_ALBUM], all: [ALBUM] });
  });

  it('shows a capped smart count as "1,000+"', () => {
    expect(formatScopeCount({ total: 1000, capped: true }, 'en')).toBe('1,000+');
    expect(formatScopeCount({ total: 1204, capped: false }, 'en')).toBe('1,204');
    expect(formatScopeCount(null)).toBe('…');
  });
});

describe('catalog and facets', () => {
  it('attaches facet counts to the vocabularies and keeps values only facets know', () => {
    const facets = facetsByField({
      total: 100,
      facets: [
        { fieldName: SearchFacetField.People, counts: [{ value: JAMIE, label: 'Jamie', count: 40 }] },
        { fieldName: SearchFacetField.City, counts: [{ value: 'Oslo', count: 3 }] },
        {
          fieldName: SearchFacetField.Type,
          counts: [
            { value: 'IMAGE', count: 90 },
            { value: 'VIDEO', count: 10 },
          ],
        },
        { fieldName: SearchFacetField.IsFavorite, counts: [{ value: 'true', count: 5 }] },
      ],
    });
    const options = {
      ...emptyFilterPanelOptions(),
      people: [{ id: JAMIE, name: 'Jamie' }] as never,
      cities: ['Banff'],
    };
    const built = buildPaletteCatalog(options, facets, [{ date: '2026-01-01', count: 80 }]);
    expect(built.people).toEqual([{ id: JAMIE, name: 'Jamie', count: 40 }]);
    expect(built.places).toEqual([
      { value: 'Banff', count: undefined },
      { value: 'Oslo', count: 3 },
    ]);
    expect(built.typeCounts).toEqual({ IMAGE: 90, VIDEO: 10 });
    expect(built.favoriteCount).toBe(5);
    expect(built.years).toEqual([{ value: '2026', count: 80 }]);
  });
});

describe('recent and saved searches', () => {
  const search = { input: 'person:Jamie beach', mode: 'smart' as const, query: emptyDiscoveryQuery() };

  it('keeps five recent searches, one per input and mode', () => {
    let recent = rememberRecentSearch([], search);
    recent = rememberRecentSearch(recent, { ...search, mode: 'ocr' });
    recent = rememberRecentSearch(recent, search);
    expect(recent.map((item) => item.mode)).toEqual(['smart', 'ocr']);
    for (let index = 0; index < 10; index++) {
      recent = rememberRecentSearch(recent, { ...search, input: `term ${index}` });
    }
    expect(recent).toHaveLength(5);
    expect(rememberRecentSearch(recent, { ...search, input: '  ' })).toBe(recent);
  });

  it('stores the portable query with the typed input and restores it', () => {
    const saved = toSavedSearch('  Jamie at the beach  ', search);
    expect(saved.name).toBe('Jamie at the beach');
    expect(fromSavedSearch(saved)).toEqual(search);
    expect(fromSavedSearch({ name: 'broken', query: { version: 99 } })).toBeUndefined();
    const list = upsertSavedSearch(
      [toSavedSearch('Other', search), saved],
      toSavedSearch('jamie AT the beach', search),
    );
    expect(list.map((item) => item.name)).toEqual(['jamie AT the beach', 'Other']);
  });
});
