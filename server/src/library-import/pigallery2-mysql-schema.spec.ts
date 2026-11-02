import fixture from 'src/library-import/fixtures/pigallery2/3.5.2-mysql84.json' with { type: 'json' };
import { admitPigallery2MysqlSchema } from 'src/library-import/pigallery2-mysql-schema.js';

const admit = (schema: unknown = fixture.schema, overrides: Record<string, unknown> = {}) =>
  admitPigallery2MysqlSchema({
    schema,
    version: fixture.source.version,
    databaseVersion: fixture.runtime.databaseVersion,
    structureVersion: fixture.runtime.dataStructureVersion,
    ...overrides,
  });

it('admits only the pinned native MySQL schema and structure version', () => {
  expect(admit()).toBe(fixture.schemaSha256);
  expect(fixture.schema.tables).toHaveLength(12);
  expect(fixture.schema.foreignKeys).toHaveLength(12);
  expect(fixture.schema.tables.every((table) => table.ENGINE === 'InnoDB')).toBe(true);
});

it.each([
  ['version', '3.5.1', 'PIGALLERY2_VERSION_UNQUALIFIED'],
  ['databaseVersion', '8.4.12', 'PIGALLERY2_ENGINE_UNQUALIFIED'],
  ['structureVersion', 40, 'PIGALLERY2_STRUCTURE_VERSION_UNQUALIFIED'],
  ['structureVersion', '41', 'PIGALLERY2_STRUCTURE_VERSION_UNQUALIFIED'],
] as const)('refuses unqualified %s=%s', (field, value, code) => {
  expect(() => admit(fixture.schema, { [field]: value })).toThrow(code);
});

it('refuses missing sections, extra objects and changed foreign-key/index rules', () => {
  const changed = structuredClone(fixture.schema);
  changed.foreignKeys[0].DELETE_RULE = changed.foreignKeys[0].DELETE_RULE === 'CASCADE' ? 'RESTRICT' : 'CASCADE';
  const hidden = structuredClone(fixture.schema);
  hidden.indexes[0].IS_VISIBLE = 'NO';
  for (const schema of [
    { ...fixture.schema, foreignKeys: undefined },
    { ...fixture.schema, checks: undefined },
    { ...fixture.schema, tables: fixture.schema.tables.slice(1) },
    { ...fixture.schema, triggers: [{ TRIGGER_NAME: 'unexpected' }] },
    { ...fixture.schema, extra: [] },
    changed,
    hidden,
  ]) {
    expect(() => admit(schema)).toThrow(/^PiGallery2 source refused: PIGALLERY2_SCHEMA_UNQUALIFIED$/);
  }
});

it.each(['keys', 'foreignKeys'] as const)('refuses an external referenced schema in %s', (section) => {
  const schema = structuredClone(fixture.schema);
  if (section === 'keys') {
    schema.keys.find((key) => key.REFERENCED_TABLE_SCHEMA === 'source')!.REFERENCED_TABLE_SCHEMA = 'external';
  } else {
    schema.foreignKeys[0].UNIQUE_CONSTRAINT_SCHEMA = 'external';
  }
  expect(() => admit(schema)).toThrow('PIGALLERY2_SCHEMA_UNQUALIFIED');
});
