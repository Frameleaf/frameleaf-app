import { frozenSource } from 'src/immich-import/adapters.js';
import { normalizeSchemaSql, verifySourceStructure } from 'src/immich-import/schema.js';

const versions = ['3.0.0', '3.0.1', '3.0.2', '3.0.3', '3.1.0', '3.2.0', '3.2.1', '3.2.2', '3.2.3', '3.2.4'];
describe('frozen source structure', () => {
  it.each(versions)('contains every column and a full constraint catalog for %s', (version) => {
    const fixture = frozenSource(version);
    expect(Object.keys(fixture.structure.tables).sort()).toEqual(Object.keys(fixture.tables).sort());
    for (const [table, shape] of Object.entries(fixture.tables)) {
      expect(Object.keys(fixture.structure.tables[table]).sort()).toEqual([...shape.columns].sort());
    }
    expect(fixture.structure.constraints.length).toBeGreaterThan(100);
    expect(fixture.structure.uniqueIndexes.some(({ name }) => name === 'UQ_assets_owner_checksum')).toBe(true);
  });

  it.each(['nullable', 'default', 'identity', 'type', 'foreign-key', 'check', 'unique-index', 'enum'])(
    'refuses %s drift even with the correct version and migration ledger',
    (change) => {
      const expected = frozenSource('3.2.4').structure;
      const actual = structuredClone(expected);
      switch (change) {
        case 'nullable': {
          actual.tables.asset.ownerId.not_null = false;
          break;
        }
        case 'default': {
          actual.tables.user.password.default = "'unexpected'::character varying";
          break;
        }
        case 'identity': {
          actual.tables.naturalearth_countries.id.identity = '';
          break;
        }
        case 'type': {
          actual.tables.face_search.embedding.type = 'vector(768)';
          break;
        }
        case 'foreign-key': {
          actual.constraints = actual.constraints.filter(({ definition }) => !definition.includes('FOREIGN KEY'));
          break;
        }
        case 'check': {
          actual.constraints = actual.constraints.filter(({ definition }) => !definition.includes('CHECK'));
          break;
        }
        case 'unique-index': {
          actual.uniqueIndexes = [];
          break;
        }
        case 'enum': {
          actual.enums[0].labels.reverse();
          break;
        }
      }
      expect(() => verifySourceStructure(actual, expected)).toThrow('UNKNOWN_SOURCE_SCHEMA');
    },
  );

  it('normalizes equivalent qualification without changing quoted data', () => {
    expect(normalizeSchemaSql('FOREIGN KEY ("id") REFERENCES public."user" ("id") ON DELETE NO ACTION')).toBe(
      normalizeSchemaSql('FOREIGN KEY (id) REFERENCES "user"(id)'),
    );
    expect(normalizeSchemaSql("'literal ON DELETE NO ACTION'::text")).toContain('ON DELETE NO ACTION');
    expect(normalizeSchemaSql("'public.foo two  spaces'::text")).not.toBe(normalizeSchemaSql("'foo two spaces'::text"));
  });
});
