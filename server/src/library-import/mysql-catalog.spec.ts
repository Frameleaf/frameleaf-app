import mysql from 'src/library-import/fixtures/pigallery2/3.5.2-mysql84.json' with { type: 'json' };
import maria from 'src/library-import/fixtures/piwigo/16.4.0-mariadb.json' with { type: 'json' };
import { readMysqlSourceSchema } from 'src/library-import/mysql-catalog.js';
import { mysqlSchemaFingerprint } from 'src/library-import/mysql-schema.js';

const tables = {
  TABLES: 'tables',
  COLUMNS: 'columns',
  STATISTICS: 'indexes',
  TABLE_CONSTRAINTS: 'constraints',
  KEY_COLUMN_USAGE: 'keys',
  TRIGGERS: 'triggers',
  ROUTINES: 'routines',
  EVENTS: 'events',
  REFERENTIAL_CONSTRAINTS: 'foreignKeys',
  CHECK_CONSTRAINTS: 'checks',
} as const;
const collector = (schema: Record<string, unknown>) =>
  vi.fn((sql: string) => {
    const table = /FROM information_schema\.(\w+)/.exec(sql)![1] as keyof typeof tables;
    const rows = schema[tables[table]];
    if (rows === undefined) throw new Error('Unexpected metadata table');
    return Promise.resolve([{ records: JSON.stringify(rows) }]);
  });

it('reads MySQL index visibility, expressions, enforced constraints and foreign-key/check rules', async () => {
  const query = collector(mysql.schema);
  const schema = await readMysqlSourceSchema(query, 'mysql');
  const statements = query.mock.calls.map(([statement]) => statement).join('\n');
  for (const column of [
    'IS_VISIBLE',
    'EXPRESSION',
    'ENFORCED',
    'UPDATE_RULE',
    'DELETE_RULE',
    'CHECK_CLAUSE',
    'REFERENCED_TABLE_SCHEMA',
    'UNIQUE_CONSTRAINT_SCHEMA',
  ])
    expect(statements).toContain('`' + column + '`');
  expect(statements).not.toContain('`IGNORED`');
  expect(statements).toContain('WHERE CAST(`TABLE_SCHEMA` AS BINARY)=CAST(DATABASE() AS BINARY)');
  expect(statements).toContain('CAST(`REFERENCED_TABLE_SCHEMA` AS BINARY)=CAST(DATABASE() AS BINARY)');
  expect(statements).toContain('CAST(`UNIQUE_CONSTRAINT_SCHEMA` AS BINARY)=CAST(DATABASE() AS BINARY)');
  expect(mysqlSchemaFingerprint(schema, '')).toBe(mysql.schemaSha256);
});

it('preserves the existing MariaDB catalog and fingerprint by default', async () => {
  const query = collector(maria.schema);
  expect(mysqlSchemaFingerprint(await readMysqlSourceSchema(query), maria.tablePrefix)).toBe(maria.schemaSha256);
  expect(query.mock.calls.map(([statement]) => statement).join('\n')).toContain('`IGNORED`');
});
