import {
  BURST_SECONDS,
  EVENT_GAP_HOURS,
  MAX_PET_STORY_ASSETS,
  MIN_EVENT_ASSETS,
  MIN_PET_STORY_ASSETS,
  type StoryCandidate,
  birthdayAge,
  birthdayOn,
  calendarDayWindow,
  diversifyByDay,
  diversifyByMonth,
  dominantPlace,
  groupEventStories,
  groupPetStories,
  placeLabel,
  suppressBursts,
} from 'src/utils/memory-story.js';

/**
 * `localDateTime` is a wall clock stored as a UTC instant, so every fixture below is built
 * with an explicit `Z`: that is exactly how the column reads back, and it is what makes the
 * grouping independent of the machine running the tests.
 */
const at = (iso: string, place: Partial<Pick<StoryCandidate, 'city' | 'state' | 'country'>> = {}): StoryCandidate => ({
  id: iso,
  localDateTime: new Date(iso),
  city: place.city ?? null,
  state: place.state ?? null,
  country: place.country ?? null,
});

/** `count` captures on one local day, one hour apart, starting at 09:00 local */
const day = (date: string, count: number, place: Partial<Pick<StoryCandidate, 'city' | 'state' | 'country'>> = {}) =>
  Array.from({ length: count }, (_, index) => at(`${date}T${String(9 + index).padStart(2, '0')}:00:00.000Z`, place));

describe('memory story grouping', () => {
  describe('suppressBursts', () => {
    it('keeps the first capture of a burst and drops the rest', () => {
      const burst = [
        at('2026-06-01T09:00:00.000Z'),
        at('2026-06-01T09:00:05.000Z'),
        at('2026-06-01T09:00:10.000Z'),
        at('2026-06-01T09:05:00.000Z'),
      ];

      expect(suppressBursts(burst).map(({ id }) => id)).toEqual([
        '2026-06-01T09:00:00.000Z',
        '2026-06-01T09:05:00.000Z',
      ]);
    });

    it('keeps captures exactly at the burst boundary', () => {
      const pair = [
        at('2026-06-01T09:00:00.000Z'),
        at(`2026-06-01T09:00:${String(BURST_SECONDS).padStart(2, '0')}.000Z`),
      ];

      expect(suppressBursts(pair)).toHaveLength(2);
    });
  });

  describe('diversifyByDay', () => {
    it('spreads the kept assets across days instead of taking the busiest one', () => {
      const candidates = [...day('2026-06-01', 10), ...day('2026-06-02', 2)];

      const kept = diversifyByDay(candidates, 4);

      expect(kept).toHaveLength(4);
      expect(kept.filter(({ id }) => id.startsWith('2026-06-02'))).toHaveLength(2);
    });

    it('returns the input untouched when it is already within the limit', () => {
      const candidates = day('2026-06-01', 3);
      expect(diversifyByDay(candidates, 10)).toBe(candidates);
    });

    it('keeps capture order', () => {
      const candidates = [...day('2026-06-01', 5), ...day('2026-06-02', 5)];
      const kept = diversifyByDay(candidates, 6).map(({ id }) => id);

      expect(kept).toEqual([...kept].sort());
    });
  });

  describe('dominantPlace', () => {
    it('picks the place most of the assets carry', () => {
      const candidates = [
        at('2026-06-01T09:00:00.000Z', { city: 'Lisbon', country: 'Portugal' }),
        at('2026-06-01T10:00:00.000Z', { city: 'Lisbon', country: 'Portugal' }),
        at('2026-06-01T11:00:00.000Z', { city: 'Sintra', country: 'Portugal' }),
      ];

      expect(dominantPlace(candidates)).toEqual({ city: 'Lisbon', state: null, country: 'Portugal' });
    });

    it('is null when nothing has a location', () => {
      expect(dominantPlace(day('2026-06-01', 3))).toBeNull();
    });
  });

  describe('groupEventStories', () => {
    it('groups a multi-day trip into one story', () => {
      const trip = [
        ...day('2026-06-01', 5, { city: 'Lisbon', country: 'Portugal' }),
        ...day('2026-06-02', 5, { city: 'Lisbon', country: 'Portugal' }),
      ];

      const [story, ...rest] = groupEventStories(trip);

      expect(rest).toHaveLength(0);
      expect(story).toMatchObject({
        startDate: '2026-06-01',
        endDate: '2026-06-02',
        dayCount: 2,
        place: { city: 'Lisbon', state: null, country: 'Portugal' },
      });
      expect(story.assetIds).toHaveLength(10);
    });

    it('does not make a story out of a single day', () => {
      expect(groupEventStories(day('2026-06-01', MIN_EVENT_ASSETS + 5))).toEqual([]);
    });

    it('does not make a story out of too few captures', () => {
      const sparse = [...day('2026-06-01', 2), ...day('2026-06-02', 2)];
      expect(groupEventStories(sparse)).toEqual([]);
    });

    it('splits on a gap longer than the event gap', () => {
      const first = [...day('2026-06-01', 5), ...day('2026-06-02', 5)];
      const second = [...day('2026-06-20', 5), ...day('2026-06-21', 5)];

      const stories = groupEventStories([...first, ...second]);

      expect(stories).toHaveLength(2);
      expect(stories[0].endDate).toBe('2026-06-02');
      expect(stories[1].startDate).toBe('2026-06-20');
    });

    it('splits a continuous run when the place changes after a travel gap', () => {
      // an overnight flight: same trip by the clock, two different places
      const away = [
        ...day('2026-06-01', 5, { city: 'Lisbon', country: 'Portugal' }),
        ...day('2026-06-02', 5, { city: 'Lisbon', country: 'Portugal' }),
        at('2026-06-02T22:00:00.000Z', { city: 'Lisbon', country: 'Portugal' }),
        ...day('2026-06-03', 5, { city: 'Reykjavik', country: 'Iceland' }),
        ...day('2026-06-04', 5, { city: 'Reykjavik', country: 'Iceland' }),
      ];

      const stories = groupEventStories(away);

      expect(stories).toHaveLength(2);
      expect(stories[0].place?.city).toBe('Lisbon');
      expect(stories[1].place?.city).toBe('Reykjavik');
    });

    it('keeps local days, not UTC-offset days, when a trip crosses midnight', () => {
      // 23:00 and 01:00 local are two different local days but only two hours apart, which
      // is well inside the event gap: the story must span both of them.
      const overnight = [
        ...day('2026-06-01', 5),
        at('2026-06-01T23:00:00.000Z'),
        at('2026-06-02T01:00:00.000Z'),
        at('2026-06-02T02:00:00.000Z'),
        ...day('2026-06-02', 3),
      ];

      const [story] = groupEventStories(overnight);

      expect(story.dayCount).toBe(2);
      expect(story.startDate).toBe('2026-06-01');
      expect(story.endDate).toBe('2026-06-02');
    });

    it('reports the pre-diversity count and caps the kept assets', () => {
      // 24 captures a day at half-hour spacing: dense enough to exceed the cap, but never
      // close enough together to look like a burst, and never far enough apart to split
      const dense = (date: string) =>
        Array.from({ length: 24 }, (_, index) =>
          at(`${date}T${String(9 + Math.floor(index / 2)).padStart(2, '0')}:${index % 2 === 0 ? '00' : '30'}:00.000Z`),
        );
      const long = Array.from({ length: 5 }, (_, index) => dense(`2026-06-0${index + 1}`)).flat();

      const [story] = groupEventStories(long);

      expect(story.totalAssets).toBeGreaterThan(story.assetIds.length);
      expect(story.assetIds.length).toBeLessThanOrEqual(60);
    });

    it('returns nothing for an empty library', () => {
      expect(groupEventStories([])).toEqual([]);
    });

    it('uses the documented gap threshold', () => {
      expect(EVENT_GAP_HOURS).toBe(20);
    });
  });

  describe('placeLabel', () => {
    it('prefers the city over the region', () => {
      expect(placeLabel({ city: 'Lisbon', state: 'Lisboa', country: 'Portugal' })).toBe('Lisbon, Portugal');
    });

    it('falls back to the region when there is no city', () => {
      expect(placeLabel({ city: null, state: 'Lisboa', country: 'Portugal' })).toBe('Lisboa, Portugal');
    });

    it('is undefined when there is nothing to say', () => {
      expect(placeLabel(null)).toBeUndefined();
      expect(placeLabel({ city: null, state: null, country: null })).toBeUndefined();
    });
  });
});

describe('groupPetStories (FL-58)', () => {
  const row = (petId: string, name: string, date: string, assetId = `${petId}-${date}`) => ({
    petId,
    name,
    species: 'cat',
    assetId,
    localDateTime: new Date(`${date}T12:00:00.000Z`),
  });

  it('makes one story per named pet and local month with enough photos', () => {
    const rows = [
      ...['01', '02', '03', '04', '05'].map((day) => row('biscuit', 'Biscuit', `2026-08-${day}`)),
      ...['01', '02', '03', '04'].map((day) => row('rex', 'Rex', `2026-08-${day}`)),
      ...['01', '02', '03', '04', '05'].map((day) => row('nameless', '  ', `2026-08-${day}`)),
    ];

    const stories = groupPetStories(rows);

    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ petId: 'biscuit', name: 'Biscuit', month: '2026-08', assetCount: 5 });
  });

  it('splits months on the owner’s local calendar and counts a photo once', () => {
    const rows = [
      ...['01', '02', '03', '04', '05'].map((day) => row('biscuit', 'Biscuit', `2026-07-${day}`)),
      row('biscuit', 'Biscuit', '2026-07-05', 'biscuit-2026-07-05'),
      row('biscuit', 'Biscuit', '2026-08-01'),
    ];

    const stories = groupPetStories(rows);

    expect(stories.map(({ month, assetCount }) => [month, assetCount])).toEqual([['2026-07', 5]]);
    expect(MIN_PET_STORY_ASSETS).toBe(5);
  });

  it('keeps at most the story limit, spread across days', () => {
    const rows = Array.from({ length: 80 }, (_, index) =>
      row('biscuit', 'Biscuit', `2026-08-${String((index % 20) + 1).padStart(2, '0')}`, `a-${index}`),
    );

    const [story] = groupPetStories(rows);

    expect(story.assetIds).toHaveLength(MAX_PET_STORY_ASSETS);
    expect(story.assetCount).toBe(80);
  });
});

describe('birthdays and recaps (FL-62)', () => {
  it('keeps the month and day of a birth date in the given year', () => {
    expect(birthdayOn('1990-09-25', 2026)).toBe('2026-09-25');
    expect(birthdayOn('1990-01-01T00:00:00.000Z', 2027)).toBe('2027-01-01');
  });

  it('keeps a leap-day birthday on 28 February outside leap years', () => {
    expect(birthdayOn('2000-02-29', 2026)).toBe('2026-02-28');
    expect(birthdayOn('2000-02-29', 2028)).toBe('2028-02-29');
  });

  it('returns null for an unreadable birth date', () => {
    expect(birthdayOn('not a date', 2026)).toBeNull();
  });

  it('counts the age reached, and none for a missing birth year', () => {
    expect(birthdayAge('1990-09-25', 2026)).toBe(36);
    expect(birthdayAge('0001-09-25', 2026)).toBeNull();
    expect(birthdayAge('2030-01-01', 2026)).toBeNull();
  });

  it('shows a calendar day from its first moment anywhere to its last moment anywhere', () => {
    const { showAt, hideAt } = calendarDayWindow('2026-09-25');
    expect(showAt.toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(hideAt.toISOString()).toBe('2026-09-26T11:59:59.999Z');
  });

  it('spreads a recap across the months instead of one busy weekend', () => {
    const busy = Array.from({ length: 40 }, (_, index) => ({
      id: `june-${index}`,
      localDateTime: new Date(Date.UTC(2025, 5, 1, 0, index)),
    }));
    const quiet = [1, 3, 8, 11].map((month) => ({
      id: `month-${month}`,
      localDateTime: new Date(Date.UTC(2025, month, 5)),
    }));
    const kept = diversifyByMonth(
      [...busy, ...quiet].toSorted((a, b) => +a.localDateTime - +b.localDateTime),
      8,
    );
    expect(kept).toHaveLength(8);
    expect(kept.map(({ id }) => id)).toEqual(expect.arrayContaining(quiet.map(({ id }) => id)));
  });
});
