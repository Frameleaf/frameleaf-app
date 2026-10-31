import { MapRepository } from 'src/repositories/map.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('reverse-geocoding projections', () => {
  it.each([
    {
      place: { countryCode: 'US', name: 'Town', admin1Name: 'State' },
      boundary: undefined,
      expected: { country: 'United States of America', state: 'State', city: 'Town' },
    },
    {
      place: undefined,
      boundary: { id: 1, admin: 'Canada', admin_a3: 'CAN', type: 'Country' },
      expected: { country: 'Canada', state: null, city: null },
    },
    { place: undefined, boundary: undefined, expected: { country: null, state: null, city: null } },
  ])('retains place and country fallback results: $expected', async ({ place, boundary, expected }) => {
    const { db, queries } = scriptedKysely(({ sql }) => ({
      rows: sql.includes('"geodata_places"') ? (place ? [place] : []) : boundary ? [boundary] : [],
    }));
    const repository = new MapRepository(
      undefined as never,
      undefined as never,
      { setContext: vi.fn(), debug: vi.fn(), verboseFn: vi.fn(), log: vi.fn() } as never,
      db,
    );
    try {
      await expect(repository.reverseGeocode({ latitude: 45, longitude: -75 })).resolves.toEqual(expected);
      expect(queries[0].sql).toContain('select "countryCode", "name", "admin1Name" from "geodata_places"');
      expect(queries[0].parameters.slice(0, 2)).toEqual([45, -75]);
      expect(queries).toHaveLength(place ? 1 : 2);
      if (!place) {
        expect(queries[1].sql).toContain('select "id", "admin", "admin_a3", "type" from "naturalearth_countries"');
        expect(queries[1].parameters).toEqual([-75, 45, 1]);
      }
    } finally {
      await db.destroy();
    }
  });
});
