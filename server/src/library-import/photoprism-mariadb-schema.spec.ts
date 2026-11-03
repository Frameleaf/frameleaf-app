import fixture from 'src/library-import/fixtures/photoprism/261029-mariadb114.json' with { type: 'json' };
import { admitPhotoprismMariadbSchema } from 'src/library-import/photoprism-mariadb-schema.js';

const input = () => ({
  schema: structuredClone(fixture.schema),
  version: fixture.source.version,
  databaseVersion: fixture.runtime.databaseVersion,
  lowerCaseTableNames: fixture.runtime.lowerCaseTableNames,
  migrations: structuredClone(fixture.migrations),
  versions: structuredClone(fixture.versions),
});

it('admits the application-generated pinned MariaDB schema with completed migrations', () => {
  expect(admitPhotoprismMariadbSchema(input())).toBe(fixture.schemaSha256);
  expect(fixture.schema.tables).toHaveLength(41);
  expect(fixture.schema.tables.every((row) => row.ENGINE === 'InnoDB')).toBe(true);
});

it.each([
  ['version', 'unknown', 'PHOTOPRISM_VERSION_UNQUALIFIED'],
  ['databaseVersion', '11.4.6-MariaDB-ubu2404', 'PHOTOPRISM_ENGINE_UNQUALIFIED'],
  ['lowerCaseTableNames', 2, 'PHOTOPRISM_ENGINE_UNQUALIFIED'],
] as const)('refuses unqualified %s', (field, value, code) => {
  expect(() => admitPhotoprismMariadbSchema({ ...input(), [field]: value })).toThrow(code);
});

it('refuses incomplete catalogs, altered columns and unexpected database objects', () => {
  const changed = input().schema;
  changed.columns[0].COLUMN_TYPE = 'unexpected';
  for (const schema of [
    changed,
    { ...fixture.schema, foreignKeys: undefined },
    { ...fixture.schema, checks: undefined },
    { ...fixture.schema, tables: fixture.schema.tables.slice(1) },
    { ...fixture.schema, triggers: [{ TRIGGER_NAME: 'unexpected' }] },
    { ...fixture.schema, extra: [] },
  ])
    expect(() => admitPhotoprismMariadbSchema({ ...input(), schema })).toThrow('PHOTOPRISM_SCHEMA_UNQUALIFIED');
});

it('refuses missing, duplicate, unknown, failed and unfinished migrations', () => {
  const original = input().migrations;
  for (const migrations of [
    original.slice(1),
    [...original, original[0]],
    original.map((row, i) => (i === 0 ? { ...row, id: 'unknown' } : row)),
    original.map((row, i) => (i === 0 ? { ...row, error: 'failed' } : row)),
    original.map((row, i) => (i === 0 ? { ...row, finished_at: '0001-01-01 00:00:00' } : row)),
    original.map((row, i) => (i === 0 ? { ...row, dialect: 'sqlite' } : row)),
  ])
    expect(() => admitPhotoprismMariadbSchema({ ...input(), migrations })).toThrow('PHOTOPRISM_MIGRATIONS_INCOMPLETE');
});

it('refuses a changed build or unsuccessful latest version migration', () => {
  for (const change of [{ version: 'unknown' }, { error: 'failed' }, { migrated_at: '0001-01-01 00:00:00' }])
    expect(() =>
      admitPhotoprismMariadbSchema({ ...input(), versions: [{ ...fixture.versions[0], ...change }] }),
    ).toThrow('PHOTOPRISM_BUILD_UNQUALIFIED');
  expect(() => admitPhotoprismMariadbSchema({ ...input(), versions: [] })).toThrow('PHOTOPRISM_BUILD_UNQUALIFIED');
});
