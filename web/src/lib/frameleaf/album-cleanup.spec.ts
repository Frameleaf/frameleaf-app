import {
  buildPlan,
  isDateOnly,
  operationsFor,
  splitName,
  type PlanNode,
} from '$lib/frameleaf/album-cleanup';
import type { AlbumCleanupAlbumFactDto, AlbumCleanupFactsDto } from '@frameleaf/sdk';

const uuid = (id: string) => id;
const fact = (id: string, name: string, count = 10, extra: Partial<AlbumCleanupAlbumFactDto> = {}) => ({
  id: uuid(id),
  name,
  count,
  createdAt: '2020-01-01T00:00:00.000Z',
  locked: false,
  shared: false,
  gps: null,
  span: null,
  coverAssetId: null,
  ...extra,
});
const facts = (albums: AlbumCleanupAlbumFactDto[], extra: Partial<AlbumCleanupFactsDto> = {}): AlbumCleanupFactsDto => ({
  albums,
  collections: [],
  sameName: [],
  samePhotos: [],
  sameTrip: [],
  homeAreas: [],
  lostDates: [],
  healSkipped: 0,
  ...extra,
});
const albums = (...names: string[]) => facts(names.map((name, index) => fact(`a${index}`, name, 10 + index)));
const names = (nodes: PlanNode[]) => nodes.map((node) => node.name);
const dayNumber = (year: number, month: number, day: number) => Date.UTC(year, month, day) / 86_400_000;
const place = (city: string, lat = 49.3, lon = -122.8) => ({ gps: { city, share: 0.9, lat, lon } });
const home = { city: 'Coquitlam', lat: 49.3, lon: -122.8, photoCount: 100 };

describe('splitName', () => {
  it('reads a date as one piece, whichever delimiter it contains', () => {
    expect(splitName('Coquitlam, May 24, 2020')).toEqual(['Coquitlam', 'May 24, 2020']);
    expect(splitName('Trips - 2016 - Disney - Family Trip')).toEqual(['Trips', '2016', 'Disney', 'Family Trip']);
    expect(splitName('Trips / 2020/05/24', ['/'])).toEqual(['Trips', '2020/05/24']);
  });

  it('leaves a hyphen without spaces and a comma without one alone', () => {
    expect(splitName("Mary-Anne's wedding")).toEqual(["Mary-Anne's wedding"]);
    expect(splitName('Hello,World')).toEqual(['Hello,World']);
  });
});

describe('isDateOnly', () => {
  it('counts only a whole date', () => {
    expect(isDateOnly('May 24, 2020')).toBe(true);
    expect(isDateOnly('2020-05-24')).toBe(true);
    expect(isDateOnly('Coquitlam, May 24, 2020')).toBe(false);
  });
});

describe('buildPlan', () => {
  it('merges duplicates before nesting and takes the winner from the snapshot', () => {
    const list = facts(
      [fact('a', 'Friends - Patrick', 10), fact('b', 'friends - patrick ', 3), fact('c', 'Friends - Patrick', 40), fact('d', 'Friends - Sarah')],
      { sameName: [{ key: 'friends - patrick', albumIds: ['a', 'b', 'c'], winnerId: 'a', union: 44 }] },
    );
    const plan = buildPlan(list);
    expect(plan.duplicates).toHaveLength(1);
    // Fewer visible photos than the largest, but the most by true count: the snapshot decided.
    expect(plan.duplicates[0].winner.id).toBe('a');
    expect(names(plan.structure[0].children)).toEqual(['Patrick', 'Sarah']);
    expect(plan.structure[0].children[0].photoCount).toBe(44);
  });

  it('makes a level only where two albums share it', () => {
    const plan = buildPlan(albums('Trips - 2016 - Disney - Family Trip', 'Trips - 2016 - Maui', 'Hello, World'));
    expect(names(plan.structure)).toEqual(['Trips']);
    expect(names(plan.structure[0].children)).toEqual(['2016']);
    expect(names(plan.structure[0].children[0].children)).toEqual(['Disney - Family Trip', 'Maui']);
    expect(names(plan.untouched)).toEqual(['Hello, World']);
  });

  it('never merges an album shared with others automatically', () => {
    const list = facts([fact('a', 'Friends - Patrick'), fact('b', 'Friends - Patrick', 10, { shared: true })], {
      sameName: [{ key: 'friends - patrick', albumIds: ['a', 'b'], winnerId: 'a', union: 12 }],
    });
    expect(buildPlan(list).duplicates[0].skipped).toBe(true);
    expect(buildPlan(list, { forcedDuplicates: new Set(['friends - patrick']) }).duplicates[0].skipped).toBe(false);
  });

  it('follows the chosen treatment for date-only albums', () => {
    const list = albums('May 24, 2020', 'May 25, 2020');
    expect(names(buildPlan(list).structure)).toEqual(['2020']);
    expect(names(buildPlan(list, { dateOnly: 'year-month' }).structure[0].children)).toEqual(['May']);
    expect(buildPlan(list, { dateOnly: 'leave' }).untouched).toHaveLength(2);
    expect(buildPlan(list, { dateOnly: 'remove' }).removed).toHaveLength(2);
  });

  it('groups a shared date-only album by year instead of removing it', () => {
    const list = facts([fact('a', 'May 24, 2020'), fact('b', 'May 25, 2020', 5, { shared: true })]);
    const plan = buildPlan(list, { dateOnly: 'remove' });
    expect(plan.removed.map(({ id }) => id)).toEqual(['a']);
    expect(names(plan.structure)).toEqual(['2020']);
  });

  it('makes back-to-back days in one place one album, up to a week', () => {
    const plan = buildPlan(albums('Coquitlam, May 24, 2020', 'Coquitlam, May 25, 2020', 'Coquitlam, May 27, 2020'));
    expect(plan.dayRuns).toHaveLength(1);
    expect(plan.dayRuns[0].name).toBe('Coquitlam, May 24–25, 2020');
    expect(names(plan.structure[0].children)).toEqual(['May 24–25, 2020', 'May 27, 2020']);
    const week = Array.from({ length: 9 }, (_, day) => `Whistler, Jul ${day + 1}, 2021`);
    expect(buildPlan(albums(...week)).dayRuns.map((run) => run.albums.length)).toEqual([7, 2]);
    expect(buildPlan(albums('May 24, 2020', 'May 25, 2020')).dayRuns).toHaveLength(0);
    expect(
      buildPlan(albums('Coquitlam, May 24, 2020', 'Coquitlam, May 25, 2020'), { combineDays: false }).summary.daysCombined,
    ).toBe(0);
  });

  it('merges the same photos under another name only when chosen', () => {
    const list = facts([fact('a', 'Trips - 2019 - Maui', 100), fact('b', 'Maui 2019', 90), fact('c', 'Trips - 2019 - Rome', 5)], {
      samePhotos: [{ firstId: 'a', secondId: 'b', winnerId: 'a', share: 0.95, union: 105 }],
    });
    const suggested = buildPlan(list);
    expect(suggested.similar).toHaveLength(1);
    expect(suggested.similar[0].winner.id).toBe('a');
    expect(suggested.summary.similarMerged).toBe(0);
    expect(names(suggested.untouched)).toEqual(['Maui 2019']);
    const merged = buildPlan(list, { mergedSimilar: new Set(['a+b']) });
    expect(merged.summary.similarMerged).toBe(1);
    expect(merged.untouched).toHaveLength(0);
    expect(merged.structure[0].children[0].children[0].photoCount).toBe(105);
  });

  it('files a date-only album under the place its photos were taken', () => {
    const list = facts(
      [fact('a', 'May 24, 2020', 5, place('Coquitlam')), fact('b', 'Jun 9, 2020', 5, place('Coquitlam'))],
      { homeAreas: [home] },
    );
    expect(names(buildPlan(list).structure)).toEqual(['Coquitlam']);
    expect(names(buildPlan(list, { usePhotoData: false }).structure)).toEqual(['2020']);
    expect(names(buildPlan(list, { keptPlaces: new Set(['a', 'b']) }).structure)).toEqual(['2020']);
  });

  it('links date-only days by location, and keeps apart days that were somewhere else', () => {
    const joined = buildPlan(
      facts([fact('a', 'May 24, 2020', 5, place('Coquitlam')), fact('b', 'May 25, 2020', 5, place('Coquitlam'))], {
        homeAreas: [home],
      }),
    );
    expect(joined.dayRuns[0].name).toBe('Coquitlam, May 24–25, 2020');
    const apart = buildPlan(
      facts([fact('a', 'Coquitlam, May 24, 2020', 5, place('Coquitlam')), fact('b', 'Coquitlam, May 25, 2020', 5, place('Squamish'))], {
        homeAreas: [home],
      }),
    );
    expect(apart.dayRuns).toHaveLength(0);
    expect(apart.keptApart).toBe(1);
  });

  describe('trips', () => {
    const maui = place('Maui', 20.8, -156.33);
    const kauai = place('Kauai', 22.05, -159.5);
    const list = () =>
      facts(
        [
          fact('a', 'Jul 3, 2019', 5, maui),
          fact('b', 'Jul 4, 2019', 9, maui),
          fact('c', 'Jul 5, 2019', 5, kauai),
        ],
        { homeAreas: [home, { city: 'Maui', lat: 20.8, lon: -156.33, photoCount: 20 }] },
      );

    it('makes days in a row away from home one trip under Trips', () => {
      const plan = buildPlan(list());
      expect(plan.trips[0].name).toBe('Maui, Jul 3–5, 2019');
      expect(plan.trips[0].cities).toEqual(['Maui', 'Kauai']);
      expect(names(plan.structure)).toEqual(['Trips']);
      expect(plan.structure[0].photoCount).toBe(19);
    });

    it('measures home from the chosen area', () => {
      expect(buildPlan(list(), { homeArea: 1 }).trips).toHaveLength(0);
    });

    it('stops a trip at a hop of 1,000 km or more', () => {
      const plan = buildPlan(
        facts([fact('a', 'Jul 3, 2019', 5, maui), fact('b', 'Jul 4, 2019', 5, place('Tokyo', 35.68, 139.69))], {
          homeAreas: [home],
        }),
      );
      expect(plan.trips).toHaveLength(0);
    });

    it('finds no trips and still plans when no photo has a location', () => {
      const plan = buildPlan(albums('Jul 3, 2019', 'Jul 4, 2019'));
      expect(plan.trips).toEqual([]);
      expect(plan.home).toBeNull();
    });
  });

  it('files a name that disagrees with its photos by the photos, renamed only on request', () => {
    const list = facts([
      fact('a', 'May 24, 2020', 5, {
        span: { from: dayNumber(2016, 5, 1), to: dayNumber(2016, 5, 3), middle: dayNumber(2016, 5, 2) },
      }),
      fact('b', 'Jun 9, 2016', 5),
    ]);
    const plan = buildPlan(list);
    expect(plan.mismatches[0].photoLabel).toBe('Jun 2, 2016');
    expect(names(plan.structure)).toEqual(['2016']);
    expect(names(plan.structure[0].children)).toEqual(['Jun 9, 2016', 'May 24, 2020']);
    expect(names(buildPlan(list, { renamedToPhotoDate: new Set(['a']) }).structure[0].children)).toEqual([
      'Jun 2, 2016',
      'Jun 9, 2016',
    ]);
  });

  it('merges albums with the same dates and place only when chosen', () => {
    const list = facts([fact('a', 'Trips - 2017 - Banff', 10), fact('b', 'Banff with friends 2017', 4)], {
      sameTrip: [{ firstId: 'a', secondId: 'b', winnerId: 'a', share: 0, union: 14 }],
    });
    expect(buildPlan(list).sameTrip[0].merged).toBe(false);
    const merged = buildPlan(list, { mergedSimilar: new Set(['a+b']) });
    expect(merged.summary.similarMerged).toBe(1);
    expect(names(merged.untouched)).toEqual(['Trips - 2017 - Banff']);
    expect(merged.untouched[0].photoCount).toBe(14);
  });

  it('reuses an existing collection level by level', () => {
    const list = facts([fact('a', 'Trips - 2016 - Disney'), fact('b', 'Trips - 2016 - Maui')], {
      collections: [
        { id: 'trips', name: 'Trips', parentId: null, createdAt: '2019-01-01T00:00:00.000Z' },
        { id: 'y2016', name: '2016', parentId: 'trips', createdAt: '2019-02-01T00:00:00.000Z' },
      ],
    });
    const plan = buildPlan(list);
    expect(plan.structure[0]).toMatchObject({ existing: true, existingId: 'trips' });
    expect(plan.structure[0].children[0]).toMatchObject({ existing: true, existingId: 'y2016' });
    expect(plan.summary.collections).toBe(0);
  });

  it('keeps a person with no photos or no located photos working, with no division by zero', () => {
    const plan = buildPlan(facts([fact('a', 'May 24, 2020', 0), fact('b', 'Empty - One', 0), fact('c', 'Empty - Two', 0)]));
    expect(plan.summary.lostPhotos).toBe(0);
    expect(names(plan.structure)).toContain('Empty');
    expect(Number.isFinite(plan.summary.topLevelAfter)).toBe(true);
  });
});

describe('operationsFor', () => {
  it('lists healing first, then every change as an explicit operation', () => {
    const list = facts(
      [
        fact('a', 'Friends - Patrick', 10),
        fact('b', 'Friends - Patrick', 3),
        fact('c', 'Friends - Sarah', 4),
        fact('d', 'Coquitlam, May 24, 2020', 2),
        fact('e', 'Coquitlam, May 25, 2020', 8),
        fact('g', 'Coquitlam, Jun 1, 2020', 2),
        fact('f', 'Holiday', 3),
      ],
      {
        sameName: [{ key: 'friends - patrick', albumIds: ['a', 'b'], winnerId: 'a', union: 12 }],
        lostDates: [
          {
            albumId: 'f',
            from: '2020-01-01',
            to: '2020-01-02',
            suggestions: [
              {
                assetId: 'photo',
                fileName: 'x.jpg',
                shownDay: '2023-01-01',
                day: '2020-01-01',
                dateTimeOriginal: '2020-01-01T12:00:00Z',
                precision: 'around',
                between: null,
              },
            ],
          },
        ],
      },
    );
    const plan = buildPlan(list, { healedAlbums: new Set(['f']) });
    const operations = operationsFor(plan);

    expect(operations[0]).toEqual({ type: 'heal', albumId: 'f', assetIds: ['photo'] });
    expect(operations).toContainEqual({ type: 'merge', albumIds: ['a', 'b'], allowShared: false });
    expect(operations).toContainEqual({ type: 'combine', albumIds: ['d', 'e'], name: 'May 24–25, 2020' });
    expect(operations).toContainEqual({ type: 'createCollection', tempId: '>friends', name: 'Friends', parentId: null });
    expect(operations).toContainEqual({ type: 'rename', albumId: 'a', name: 'Patrick' });
    expect(operations).toContainEqual({ type: 'move', albumId: 'a', parentTempId: '>friends' });
    expect(operations).toContainEqual({ type: 'move', albumId: 'e', parentTempId: '>coquitlam' });
  });

  it('sends a shared merge only when the person forced it, with the flag', () => {
    const list = facts([fact('a', 'Friends - Patrick', 10), fact('b', 'Friends - Patrick', 3, { shared: true })], {
      sameName: [{ key: 'friends - patrick', albumIds: ['a', 'b'], winnerId: 'a', union: 12 }],
    });
    expect(operationsFor(buildPlan(list)).filter(({ type }) => type === 'merge')).toEqual([]);
    expect(
      operationsFor(buildPlan(list, { forcedDuplicates: new Set(['friends - patrick']) })).filter(
        ({ type }) => type === 'merge',
      ),
    ).toEqual([{ type: 'merge', albumIds: ['a', 'b'], allowShared: true }]);
  });

  it('removes only what the person chose to remove', () => {
    const list = albums('May 24, 2020', 'May 25, 2020');
    expect(operationsFor(buildPlan(list, { dateOnly: 'remove' })).map(({ type, albumId }) => [type, albumId])).toEqual([
      ['remove', 'a0'],
      ['remove', 'a1'],
    ]);
  });

  it('leaves an album left out exactly as it is', () => {
    const list = facts([fact('a', 'Friends - Patrick'), fact('b', 'Friends - Patrick', 2), fact('c', 'Friends - Sarah')], {
      sameName: [{ key: 'friends - patrick', albumIds: ['a', 'b'], winnerId: 'a', union: 12 }],
    });
    const operations = operationsFor(buildPlan(list, { leftOut: new Set(['>friends']) }));
    expect(operations.filter(({ type }) => type === 'merge')).toEqual([]);
    expect(operations.filter(({ type }) => type === 'move')).toEqual([]);
    expect(operations.filter(({ type }) => type === 'rename')).toEqual([]);
  });
});
