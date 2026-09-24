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
  paletteSearchLabel,
  smartAlbumCriteria,
  typedTokensFromQuery,
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
      lensModel: { like: '24-70' },
      rating: { gte: 4 },
      isFavorite: { eq: true },
      localDateTime: { gte: '2026-01-01T00:00:00.000Z', lt: '2027-01-01T00:00:00.000Z' },
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
      make: { notLike: 'Canon' },
      lensModel: { notLike: 'RF' },
      tagIds: { none: [WATER] },
      originalFileName: { notLike: 'tmp' },
      originalPath: { notLike: 'cache' },
      isFavorite: { eq: false },
    });
    expect(isDiscoveryFilter(filter)).toBe(true);
  });

  it('excludes a camera by "does not contain", which keeps photos without one, as the prototype does', () => {
    expect(parseSearchInput('-camera:sony', catalog).filter).toEqual({ make: { notLike: 'Sony' } });
  });

  it('matches cameras and lenses by "contains", as the prototype does', () => {
    // An exact make, else a model containing it, else a make containing it
    expect(parseSearchInput('camera:canon', catalog).filter).toEqual({ make: { eq: 'Canon' } });
    expect(parseSearchInput('camera:EOS', catalog).filter).toEqual({ model: { like: 'EOS' } });
    expect(parseSearchInput('camera:Nikon lens:85mm', catalog).filter).toEqual({
      make: { like: 'Nikon' },
      lensModel: { like: '85mm' },
    });
    expect(parseSearchInput('-camera:Nikon', catalog).filter).toEqual({ make: { notLike: 'Nikon' } });
    expect(isDiscoveryFilter(parseSearchInput('camera:Nikon -lens:85mm', catalog).filter)).toBe(true);
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
      localDateTime: { gte: '2026-08-13T00:00:00.000Z', lt: '2026-08-15T00:00:00.000Z' },
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
    expect(commitCompletedTokens('person:Nobody person:Jamie ', catalog)).toEqual({
      tokens: ['person:Jamie'],
      rest: 'person:Nobody ',
    });
  });

  it('replaces a typed chip when a graphical pick sets the same field', () => {
    const tokens = ['person:Jamie', 'place:Banff', 'year:2026', 'after:2026-01-02'];
    expect(withoutTokensForFields(tokens, ['personIds'], catalog)).toEqual([
      'place:Banff',
      'year:2026',
      'after:2026-01-02',
    ]);
    expect(withoutTokensForFields(tokens, new Set(['localDateTime', 'city']), catalog)).toEqual(['person:Jamie']);
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
    expect(parseSearchInput(tokens.join(' '), catalog).filter.localDateTime).toEqual({
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
  const compiled = (input: string, mode: 'smart' | 'all' = 'smart') =>
    compilePaletteQuery(emptyDiscoveryQuery(), parseSearchInput(input, catalog), mode)!;

  it('keeps five recent searches, one per compiled query', () => {
    let recent = rememberRecentSearch([], { query: compiled('person:Jamie beach') });
    recent = rememberRecentSearch(recent, { query: compiled('beach', 'all') });
    recent = rememberRecentSearch(recent, { query: compiled('person:Jamie beach') });
    expect(recent).toHaveLength(2);
    for (let index = 0; index < 10; index++) {
      recent = rememberRecentSearch(recent, { query: compiled(`term ${index}`) });
    }
    expect(recent).toHaveLength(5);
    expect(rememberRecentSearch(recent, { query: emptyDiscoveryQuery() })).toBe(recent);
  });

  it('stores the compiled query with resolved ids and no typed names', () => {
    const query = compiled('person:Jamie -tag:water beach');
    const saved = toSavedSearch('  Jamie at the beach  ', query);
    expect(saved.name).toBe('Jamie at the beach');
    expect(saved.query).toMatchObject({ filter: { personIds: { all: [JAMIE] }, tagIds: { none: [WATER] } } });
    // The server withholds a search naming a Locked id by looking for the id; no name is stored to leak
    const stored = JSON.stringify(saved.query);
    expect(stored).toContain(JAMIE);
    expect(stored).not.toContain('Jamie');
    expect(stored).not.toContain('water');
    expect(fromSavedSearch(saved)).toEqual(query);
    expect(fromSavedSearch({ name: 'broken', query: { version: 99 } })).toBeUndefined();
    const list = upsertSavedSearch([toSavedSearch('Other', query), saved], toSavedSearch('jamie AT the beach', query));
    expect(list.map((item) => item.name)).toEqual(['jamie AT the beach', 'Other']);
  });

  it('shows a saved search from the ids it can still resolve', () => {
    const query = compiled('person:Jamie -tag:water year:2026 beach');
    expect(paletteSearchLabel(query, catalog)).toBe('person:Jamie -tag:water year:2026 beach');
    // Once Jamie cannot be resolved (hidden, or Locked), no name is shown and the condition stays a filter
    const withoutJamie = { ...catalog, people: [] };
    expect(paletteSearchLabel(query, withoutJamie)).toBe('-tag:water year:2026 beach');
    expect(typedTokensFromQuery(readPaletteState(query).base, withoutJamie).base.filter.personIds).toEqual({
      all: [JAMIE],
    });
  });
});

describe('typed chips from a query (FL-48 round trip)', () => {
  it('reads every condition an operator can say back as its chips, exactly', () => {
    const input =
      'person:Jamie -person:"Robin Lee" tag:water place:Banff -type:photo camera:Canon lens:24-70 rating:4 ' +
      'is:favorite month:2026-08 file:IMG_ text:"lake agnes" -path:cache';
    const query = compilePaletteQuery(emptyDiscoveryQuery(), parseSearchInput(input, catalog), 'smart')!;
    const { tokens, base } = typedTokensFromQuery(query, catalog);
    expect(base.filter).toEqual({});
    const again = compilePaletteQuery(base, parseSearchInput(tokens.join(' '), catalog), 'smart')!;
    expect(paletteSearchBody(again)).toEqual(paletteSearchBody(query));
    expect(tokens).toContain('month:2026-08');
    expect(tokens).toContain('-person:"Robin Lee"');
  });

  it('keeps in the base what no operator can say', () => {
    const query: DiscoveryQuery = {
      ...emptyDiscoveryQuery(),
      filter: {
        albumIds: { any: [ALBUM] },
        personIds: { any: [JAMIE, ROBIN] },
        localDateTime: { gte: '2026-08-01T10:00:00.000Z' },
        rating: { eq: 3 },
        city: { eq: 'Banff' },
      },
    };
    const { tokens, base } = typedTokensFromQuery(query, catalog);
    expect(tokens).toEqual(['place:Banff']);
    expect(Object.keys(base.filter).sort()).toEqual(['albumIds', 'localDateTime', 'personIds', 'rating']);
  });

  it('reads after/before days back from a date range', () => {
    const query: DiscoveryQuery = {
      ...emptyDiscoveryQuery(),
      filter: { localDateTime: { gte: '2026-08-13T00:00:00.000Z', lt: '2026-08-15T00:00:00.000Z' } },
    };
    expect(typedTokensFromQuery(query, catalog).tokens).toEqual(['after:2026-08-12', 'before:2026-08-15']);
  });
});

describe('saving as a smart album', () => {
  it('turns people, tags, media type, dates and smart text into an FL-60 rule', () => {
    const query = compilePaletteQuery(
      emptyDiscoveryQuery(),
      parseSearchInput('person:Jamie tag:water type:video month:2026-08 sunset', catalog),
      'smart',
    )!;
    expect(smartAlbumCriteria(query)).toEqual({
      ok: true,
      criteria: {
        personIds: [JAMIE],
        tagIds: [WATER],
        mediaType: 'video',
        takenAfter: '2026-08-01',
        takenBefore: '2026-08-31',
        visualQueries: ['sunset'],
      },
    });
  });

  it('reads the local capture days from every bound, without one overwriting another', () => {
    const rule = (localDateTime: Record<string, string>) =>
      smartAlbumCriteria({ ...emptyDiscoveryQuery(), filter: { localDateTime } as never });
    expect(rule({ lt: '2026-09-01T00:00:00.000Z' })).toEqual({ ok: true, criteria: { takenBefore: '2026-08-31' } });
    expect(rule({ gte: '2026-08-01', lte: '2026-08-31' })).toEqual({
      ok: true,
      criteria: { takenAfter: '2026-08-01', takenBefore: '2026-08-31' },
    });
    // The narrower of a strict and a non-strict bound wins
    expect(rule({ gt: '2026-08-01', gte: '2026-07-01', lte: '2026-08-31', lt: '2026-08-20T00:00:00.000Z' })).toEqual({
      ok: true,
      criteria: { takenAfter: '2026-08-02', takenBefore: '2026-08-19' },
    });
    expect(rule({ gte: '2026-08-01T10:00:00.000Z' })).toEqual({ ok: false, fields: ['localDateTime'] });
    // takenAt is the UTC date, not the local day a rule compares
    expect(smartAlbumCriteria({ ...emptyDiscoveryQuery(), filter: { takenAt: { gte: '2026-08-01' } } })).toEqual({
      ok: false,
      fields: ['takenAt'],
    });
  });

  it('refuses a search a rule cannot say, naming what stops it', () => {
    const query = compilePaletteQuery(
      emptyDiscoveryQuery(),
      parseSearchInput('-person:Jamie place:Banff', catalog),
      'originalFileName',
    )!;
    expect(smartAlbumCriteria({ ...query, text: 'IMG' })).toEqual({
      ok: false,
      fields: ['personIds', 'city', 'text'],
    });
    expect(smartAlbumCriteria(emptyDiscoveryQuery())).toEqual({ ok: false, fields: [] });
  });
});
