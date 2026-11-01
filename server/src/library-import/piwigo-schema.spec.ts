import { describe, expect, it } from 'vitest';
import fixture from 'src/library-import/fixtures/piwigo/16.4.0-mariadb.json' with { type: 'json' };
import { mysqlSchemaFingerprint } from 'src/library-import/mysql-schema.js';
import { admitPiwigoSchema } from 'src/library-import/piwigo-schema.js';

const admit = (
  schema: unknown = fixture.schema,
  prefix = fixture.tablePrefix,
  version = fixture.source.version,
  databaseVersion = fixture.runtime.databaseVersion,
) => admitPiwigoSchema({ schema, prefix, version, databaseVersion });
const renamed = (prefix: string) =>
  Object.fromEntries(
    Object.entries(fixture.schema).map(([section, rows]) => [
      section,
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            ['TABLE_NAME', 'REFERENCED_TABLE_NAME', 'EVENT_OBJECT_TABLE'].includes(key) && typeof value === 'string'
              ? prefix + value.slice(fixture.tablePrefix.length)
              : value,
          ]),
        ),
      ),
    ]),
  );
describe('Pinned native Piwigo schema admission', () => {
  it('admits the actual 34-table native MyISAM schema and independently computed checksum', () => {
    expect(fixture.schema.tables).toHaveLength(34);
    expect(new Set(fixture.schema.tables.map((table) => table.ENGINE))).toEqual(new Set(['MyISAM']));
    expect(mysqlSchemaFingerprint(fixture.schema, fixture.tablePrefix)).toBe(fixture.schemaSha256);
    expect(admit()).toBe(fixture.schemaSha256);
  });
  it.each(['piwigo_', '', 'custom$1_'])(
    'resolves explicitly configured prefix %s without changing the schema identity',
    (prefix) => {
      expect(admit(renamed(prefix), prefix)).toBe(fixture.schemaSha256);
    },
  );
  it('ignores metadata row order and object property order', () => {
    const schema = Object.fromEntries(
      Object.entries(fixture.schema)
        .toReversed()
        .map(([section, rows]) => [
          section,
          rows.toReversed().map((row) => Object.fromEntries(Object.entries(row).toReversed())),
        ]),
    );
    expect(admit(schema)).toBe(fixture.schemaSha256);
  });
  it.each(['wrong_', '`', 'a-b', String.raw`a\b`, '9bad', 'x'.repeat(21)])(
    'refuses unsafe or mismatched prefixes %s',
    (prefix) => {
      expect(() => admit(fixture.schema, prefix)).toThrow('PIWIGO_SCHEMA_UNQUALIFIED');
    },
  );
  it('requires the pinned application and engine builds', () => {
    expect(() => admit(fixture.schema, fixture.tablePrefix, '16.3.0')).toThrow('PIWIGO_VERSION_UNQUALIFIED');
    expect(() => admit(fixture.schema, fixture.tablePrefix, fixture.source.version, '8.4.0')).toThrow(
      'PIWIGO_ENGINE_UNQUALIFIED',
    );
  });
  it('refuses missing, extra, duplicated, renamed and altered schema records', () => {
    const mutations = [
      (s: typeof fixture.schema) => s.tables.pop(),
      (s: typeof fixture.schema) => {
        s.tables.push({ ...s.tables[0], TABLE_NAME: 'flq_unknown' });
      },
      (s: typeof fixture.schema) => {
        s.columns.push(s.columns[0]);
      },
      (s: typeof fixture.schema) => {
        s.columns[0].COLUMN_TYPE = 'varchar(3)';
      },
      (s: typeof fixture.schema) => {
        s.tables[0].ENGINE = 'InnoDB';
      },
      (s: typeof fixture.schema) => {
        s.indexes[0].NON_UNIQUE = 1;
      },
      (s: typeof fixture.schema) => s.constraints.pop(),
      (s: typeof fixture.schema) => {
        s.keys[0].COLUMN_NAME = 'unknown';
      },
    ];
    for (const mutate of mutations) {
      const schema = structuredClone(fixture.schema);
      mutate(schema);
      expect(() => admit(schema)).toThrow('PIWIGO_SCHEMA_UNQUALIFIED');
    }
    expect(() => admit({ ...fixture.schema, triggers: [{ TRIGGER_NAME: 'extra' }] })).toThrow(
      'PIWIGO_SCHEMA_UNQUALIFIED',
    );
    expect(() => admit({ ...fixture.schema, routines: [{ ROUTINE_NAME: 'extra' }] })).toThrow(
      'PIWIGO_SCHEMA_UNQUALIFIED',
    );
    expect(() => admit({ ...fixture.schema, events: [{ EVENT_NAME: 'extra' }] })).toThrow('PIWIGO_SCHEMA_UNQUALIFIED');
  });
  it.each([
    null,
    {},
    { ...fixture.schema, columns: [{ TABLE_NAME: 'flq_images', nested: {} }] },
    { ...fixture.schema, extra: [] },
    { ...fixture.schema, tables: [{ TABLE_NAME: 'flq_images', count: Number.MAX_SAFE_INTEGER + 1 }] },
  ])('refuses malformed schema descriptors', (schema) => {
    expect(() => admit(schema)).toThrow('PIWIGO_SCHEMA_UNQUALIFIED');
  });
});
