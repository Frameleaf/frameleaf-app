import { createConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import content from 'src/library-import/fixtures/piwigo/16.4.0-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/piwigo/16.4.0-mariadb.json' with { type: 'json' };
import { readPiwigoRestore } from 'src/library-import/piwigo-source.js';

vi.mock('mysql2/promise', () => ({ createConnection: vi.fn() }));
const config = {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: 'private-fixture-only',
  database: 'piwigo',
  prefix: 'flq_',
  version: '16.4.0',
};
const privileges = ['SELECT', 'LOCK TABLES', 'TRIGGER', 'EVENT', 'SHOW VIEW', 'SHOW CREATE ROUTINE'];
const profile = () => ({
  version: fixture.runtime.databaseVersion,
  read_only: 1n,
  wsrep_on: 0n,
  account: 'root@localhost',
});
let mode = '',
  destroy: ReturnType<typeof vi.fn>,
  query: ReturnType<typeof vi.fn<(options: { sql: string }, parameters?: unknown[]) => Promise<unknown[]>>>,
  listener: ((error: Error) => void) | undefined;
const metadataTables = [
  'TABLES',
  'COLUMNS',
  'STATISTICS',
  'TABLE_CONSTRAINTS',
  'KEY_COLUMN_USAGE',
  'TRIGGERS',
  'ROUTINES',
  'EVENTS',
];
const sections = Object.keys(fixture.schema) as (keyof typeof fixture.schema)[];
const collect = async () => {
  const result = [];
  for await (const batch of readPiwigoRestore(config)) result.push(batch);
  return result;
};
beforeEach(() => {
  mode = '';
  listener = undefined;
  destroy = vi.fn();
  query = vi.fn((options: { sql: string }, parameters: unknown[] = []) =>
    // eslint-disable-next-line unicorn/prefer-promise-try -- Promise.try is absent in the pinned Node 22 runtime.
    Promise.resolve().then(() => {
      const sql = options.sql;
      if (sql.includes('VERSION()'))
        return [
          [
            {
              ...profile(),
              ...(mode === 'engine' ? { version: 'unknown' } : {}),
              ...(mode === 'writable' ? { read_only: 0n } : {}),
              ...(mode === 'galera' ? { wsrep_on: 1n } : {}),
            },
          ],
          [],
        ];
      if (sql.includes('USER_PRIVILEGES'))
        return [
          (mode === 'privileges' ? privileges.slice(0, -1) : privileges).map((PRIVILEGE_TYPE) => ({ PRIVILEGE_TYPE })),
          [],
        ];
      if (sql.startsWith('LOCK TABLES') && mode === 'lock') throw new Error('private-source-credentials');
      const index = metadataTables.findIndex((table) => sql.includes('FROM information_schema.' + table + ' '));
      if (index !== -1) {
        const section = sections[index];
        return [
          [{ records: JSON.stringify(mode === 'schema' && section === 'tables' ? [] : fixture.schema[section]) }],
          [],
        ];
      }
      if (sql.includes('FROM `piwigo`.`flq_lounge`'))
        return [mode === 'lounge' ? [{ image_id: 1n, category_id: 1n }] : [], []];
      const table = Object.keys(content.rows).find((table) => sql.includes('FROM `piwigo`.`flq_' + table + '`'));
      if (table) {
        if (mode === 'query') throw new Error('private-source-credentials');
        return [
          parameters.length > 0
            ? []
            : content.rows[table as keyof typeof content.rows].map((row) =>
                Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'number' ? BigInt(v) : v])),
              ),
          [],
        ];
      }
      return [[], []];
    }),
  );
  vi.mocked(createConnection).mockResolvedValue({
    query,
    destroy,
    on: vi.fn((event, fn) => {
      if (event === 'error') listener = fn;
    }),
  } as never);
});
describe('Piwigo restored database transport', () => {
  it('reads every allowlisted source table in bounded batches while locking all 34 native tables', async () => {
    const batches = await collect();
    expect(batches.reduce((sum, b) => sum + b.rows.length, 0)).toBe(
      Object.values(content.rows).reduce((sum, rows) => sum + rows.length, 0),
    );
    const statements = query.mock.calls.map(([options]) => options.sql as string);
    const lock = statements.find((sql) => sql.startsWith('LOCK TABLES'))!;
    expect(lock.match(/ READ/g)).toHaveLength(34);
    expect(lock).not.toContain('LOCAL');
    expect(statements.some((sql) => /START TRANSACTION|BEGIN|INSERT|UPDATE|DELETE|COMMIT/.test(sql))).toBe(false);
    for (const sql of statements) {
      if (sql.startsWith('SELECT ') && sql.includes('FROM `piwigo`')) expect(sql).toContain('LIMIT 1000');
    }
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('preserves integers and manual dates and never selects source credentials or caches', async () => {
    const batches = await collect();
    const image = batches.find((b) => b.table === 'images')!.rows.find((row) => row.id === 4n)!;
    expect(image.date_creation).toBe('2019-03-17 14:15:16');
    expect(image.added_by).toBe(1n);
    for (const [options] of query.mock.calls) {
      if (options.sql.startsWith('SELECT '))
        expect(options.sql).not.toMatch(/\bpassword\b|activation_key|secret_key|user_cache|FROM .*sessions/i);
    }
    const options = vi.mocked(createConnection).mock.calls[0][0] as Record<string, unknown>;
    expect(options).toMatchObject({
      dateStrings: true,
      decimalNumbers: false,
      multipleStatements: false,
      jsonStrings: true,
    });
  });
  it.each(['engine', 'writable', 'galera', 'privileges', 'schema', 'lounge', 'lock', 'query'])(
    'refuses %s and always destroys its private connection',
    async (value) => {
      mode = value;
      await expect(collect()).rejects.toThrow(/^Piwigo source refused: /);
      expect(destroy).toHaveBeenCalledOnce();
    },
  );
  it('refuses source drift before declaring complete', async () => {
    let tables = 0;
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (options, parameters) => {
      if (options.sql.includes('FROM information_schema.TABLES ') && ++tables === 3) mode = 'schema';
      return original(options, parameters);
    });
    await expect(collect()).rejects.toThrow('PIWIGO_SCHEMA_UNQUALIFIED');
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('releases locks when a consumer stops before completion', async () => {
    for await (const _batch of readPiwigoRestore(config)) break;
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('does not reconnect after a transport failure', async () => {
    const iterator = readPiwigoRestore(config);
    await iterator.next();
    listener!(new Error('private-source-credentials'));
    await expect(iterator.next()).rejects.toThrow('PIWIGO_SOURCE_UNAVAILABLE');
    expect(createConnection).toHaveBeenCalledOnce();
  });
  it('normalizes connection errors without exposing credentials', async () => {
    vi.mocked(createConnection).mockRejectedValueOnce(new Error(config.password));
    await expect(collect()).rejects.toThrow(/^Piwigo source refused: PIWIGO_SOURCE_UNAVAILABLE$/);
  });
  it('validates source options before connecting', async () => {
    for (const changed of [{ prefix: 'bad`prefix' }, { port: 0 }, { user: '' }, { version: 'unknown' }]) {
      const iterator = readPiwigoRestore({ ...config, ...changed });
      await expect(iterator.next()).rejects.toThrow(/^Piwigo source refused: /);
    }
    expect(createConnection).not.toHaveBeenCalled();
  });
});

it('paginates numeric and composite source keys without offsets', async () => {
  const original = query.getMockImplementation()!;
  query.mockImplementation(async (options, parameters = []) => {
    if (options.sql.startsWith('SELECT ') && options.sql.includes('FROM `piwigo`.`flq_images`')) {
      const start = parameters.length > 0 ? Number(parameters[0]) : 0;
      return [
        Array.from({ length: Math.min(1000, 1001 - start) }, (_, index) => ({ id: BigInt(start + index + 1) })),
        [],
      ];
    }
    if (options.sql.startsWith('SELECT ') && options.sql.includes('FROM `piwigo`.`flq_image_category`')) {
      if (parameters.length === 0)
        return [Array.from({ length: 1000 }, (_, index) => ({ image_id: 2n, category_id: BigInt(index + 1) })), []];
      if (parameters[0] === '2') return [[{ image_id: 3n, category_id: 1n }], []];
      return [[], []];
    }
    return original(options, parameters);
  });
  const batches = await collect();
  expect(batches.filter((batch) => batch.table === 'images').map((batch) => batch.rows.length)).toEqual([1000, 1]);
  expect(batches.filter((batch) => batch.table === 'image_category').map((batch) => batch.rows.length)).toEqual([
    1000, 1,
  ]);
  expect(
    query.mock.calls.some(
      ([options, parameters]) =>
        options.sql.includes('WHERE (`image_id`,`category_id`)>(?,?)') && parameters?.join(',') === '2,1000',
    ),
  ).toBe(true);
  expect(query.mock.calls.some(([options]) => options.sql.includes('OFFSET'))).toBe(false);
});
it('decodes full-width integers and nulls without converting decimals to numbers', async () => {
  await collect();
  const options = vi.mocked(createConnection).mock.calls[0][0] as {
    typeCast: (field: unknown, next: () => unknown) => unknown;
  };
  expect(options.typeCast({ type: 'LONGLONG', string: () => '18446744073709551615' }, () => null)).toBe(
    18_446_744_073_709_551_615n,
  );
  expect(options.typeCast({ type: 'LONG', string: () => null }, () => 'bad')).toBeNull();
  expect(options.typeCast({ type: 'NEWDECIMAL' }, () => '12345678901234567890.123456789')).toBe(
    '12345678901234567890.123456789',
  );
});

it('keeps safe primary failures when cleanup also fails, and normalizes isolated cleanup failures', async () => {
  destroy.mockImplementation(() => {
    throw new Error(config.password);
  });
  await expect(collect()).rejects.toThrow(/^Piwigo source refused: PIWIGO_SOURCE_UNAVAILABLE$/);
  mode = 'schema';
  await expect(collect()).rejects.toThrow(/^Piwigo source refused: PIWIGO_SCHEMA_UNQUALIFIED$/);
});
