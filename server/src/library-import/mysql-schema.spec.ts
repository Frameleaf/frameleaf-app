import mysql from 'src/library-import/fixtures/pigallery2/3.5.2-mysql84.json' with { type: 'json' };
import maria from 'src/library-import/fixtures/piwigo/16.4.0-mariadb.json' with { type: 'json' };
import { mysqlSchemaFingerprint } from 'src/library-import/mysql-schema.js';

it('matches the independently computed native MySQL8 fingerprint including foreign-key rules', () => {
  expect(mysqlSchemaFingerprint(mysql.schema, '')).toBe(mysql.schemaSha256);
});

it('keeps the existing Piwigo MariaDB fingerprint unchanged', () => {
  expect(mysqlSchemaFingerprint(maria.schema, maria.tablePrefix)).toBe(maria.schemaSha256);
});

it('ignores metadata record and object-key order on MySQL', () => {
  const schema = Object.fromEntries(
    Object.entries(mysql.schema)
      .toReversed()
      .map(([name, rows]) => [
        name,
        rows.toReversed().map((row) => Object.fromEntries(Object.entries(row).toReversed())),
      ]),
  );
  expect(mysqlSchemaFingerprint(schema, '')).toBe(mysql.schemaSha256);
});

it.each(['UPDATE_RULE', 'DELETE_RULE'] as const)('detects changed MySQL foreign-key %s', (rule) => {
  const schema = structuredClone(mysql.schema);
  const current = schema.foreignKeys[0][rule];
  schema.foreignKeys[0][rule] = current === 'CASCADE' ? 'RESTRICT' : 'CASCADE';
  expect(mysqlSchemaFingerprint(schema, '')).not.toBe(mysql.schemaSha256);
});

it('detects a changed check expression without relying on its name', () => {
  const schema = { ...mysql.schema, checks: [{ CONSTRAINT_NAME: 'synthetic', CHECK_CLAUSE: 'id>0' }] };
  const before = mysqlSchemaFingerprint(schema, '');
  schema.checks[0].CHECK_CLAUSE = 'id>1';
  expect(mysqlSchemaFingerprint(schema, '')).not.toBe(before);
});

it.each([
  { ...mysql.schema, foreignKeys: undefined },
  { ...mysql.schema, checks: undefined },
  { ...maria.schema, foreignKeys: [] },
])('refuses an incomplete extended metadata contract', (schema) => {
  expect(() => mysqlSchemaFingerprint(schema, '')).toThrow('MYSQL_SCHEMA_INVALID');
});
