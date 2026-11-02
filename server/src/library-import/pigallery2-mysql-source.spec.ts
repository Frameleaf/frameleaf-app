import { hash } from 'bcrypt';
import { createConnection } from 'mysql2/promise';
import content from 'src/library-import/fixtures/pigallery2/3.5.2-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/pigallery2/3.5.2-mysql84.json' with { type: 'json' };
import { ImportedPassword, verifyImportedPassword } from 'src/library-import/passwords.js';
import { readPigallery2MysqlRestore } from 'src/library-import/pigallery2-mysql-source.js';

vi.mock('mysql2/promise', () => ({ createConnection: vi.fn() }));
const config = {
  host: '127.0.0.1',
  port: 3306,
  user: 'import_reader',
  password: 'synthetic-only',
  database: 'pigallery',
  version: '3.5.2',
};
const privileges = ['SELECT', 'RELOAD', 'TRIGGER', 'EVENT', 'SHOW VIEW'];
const sections = {
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
const nativeRows = () =>
  Object.fromEntries(
    Object.entries(content.rows).map(([table, rows]) => [
      table,
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? BigInt(value) : value]),
        ),
      ),
    ]),
  );
let mode = '',
  destroy: ReturnType<typeof vi.fn>,
  query: ReturnType<typeof vi.fn>,
  records: ReturnType<typeof nativeRows>;
let fail: (() => void) | undefined;
let sourceHash: string;
beforeAll(async () => {
  sourceHash = await hash('Synthetic unit source password', 4);
});
beforeEach(() => {
  mode = '';
  records = nativeRows();
  destroy = vi.fn();
  fail = undefined;
  query = vi.fn(({ sql }: { sql: string }, parameters: string[] = []) =>
    // eslint-disable-next-line unicorn/prefer-promise-try -- Promise.try is absent in the pinned Node 22 runtime.
    Promise.resolve().then(() => {
      if (sql.includes('VERSION()'))
        return [
          [
            {
              version: fixture.runtime.databaseVersion,
              read_only: mode === 'writable' ? 0n : 1n,
              super_read_only: mode === 'super-writable' ? 0n : 1n,
              account: 'import_reader@%',
              roles: 'NONE',
              database: 'pigallery',
              lower_case_table_names: 0n,
              server_uuid: 'synthetic-source',
            },
          ],
          [],
        ];
      if (sql.includes('USER_PRIVILEGES'))
        return [
          (mode === 'privileges' ? privileges.slice(1) : privileges).map((PRIVILEGE_TYPE) => ({ PRIVILEGE_TYPE })),
          [],
        ];
      if (sql.includes('FROM information_schema.SCHEMATA'))
        return [[{ SCHEMA_NAME: 'pigallery' }, ...(mode === 'unrelated' ? [{ SCHEMA_NAME: 'other' }] : [])], []];
      const table = /FROM information_schema\.(\w+)/.exec(sql)?.[1] as keyof typeof sections | undefined;
      if (table && sections[table])
        return [
          [{ records: JSON.stringify(mode === 'schema' && table === 'TABLES' ? [] : fixture.schema[sections[table]]) }],
          [],
        ];
      if (sql.startsWith('SELECT password FROM')) return [[{ password: sourceHash }], []];
      if (sql.includes('FROM `pigallery`.`version_entity`'))
        return [[{ version: mode === 'structure' ? 40n : 41n }], []];
      if (sql.startsWith('SELECT 1 FROM')) return [mode === 'orphan' ? [{ invalid: 1 }] : [], []];
      const name = Object.keys(records).find((t) => sql.includes('FROM `pigallery`.`' + t + '`'));
      if (name) {
        if (sql.startsWith('SELECT COUNT(*)'))
          return [[{ count: BigInt(records[name].length) + (mode === 'missing' ? 1n : 0n) }], []];
        if (mode === 'query') throw new Error(config.password);
        if (mode === 'disconnect') fail?.();
        return [
          parameters.length > 0
            ? records[name].filter((row) => typeof row.id === 'bigint' && row.id > BigInt(parameters[0])).slice(0, 1000)
            : records[name].slice(0, 1000),
          [],
        ];
      }
      if (sql.startsWith('FLUSH TABLES') && mode === 'lock') throw new Error(config.password);
      return [[], []];
    }),
  );
  vi.mocked(createConnection).mockResolvedValue({
    query,
    destroy,
    on: vi.fn((_name, listener) => {
      fail = listener;
    }),
  } as never);
});
const collect = async () => {
  const out = [];
  for await (const batch of readPigallery2MysqlRestore(config)) out.push(batch);
  return out;
};
it('reads every allowed table under the complete readonly snapshot and releases it', async () => {
  const batches = await collect();
  expect(batches.flatMap((b) => b.rows)).toHaveLength(14);
  expect(new Set(batches.map((b) => b.table))).toEqual(
    new Set(
      Object.entries(records)
        .filter(([, rows]) => rows.length)
        .map(([t]) => t),
    ),
  );
  const calls = query.mock.calls.map(([q]) => q.sql as string);
  expect(calls.indexOf('FLUSH TABLES WITH READ LOCK')).toBeLessThan(
    calls.indexOf('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'),
  );
  expect(destroy).toHaveBeenCalledOnce();
  expect(JSON.stringify(batches, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(config.password);
});
it.each([
  ['writable', 'PIGALLERY2_RESTORE_NOT_ISOLATED'],
  ['super-writable', 'PIGALLERY2_RESTORE_NOT_ISOLATED'],
  ['unrelated', 'PIGALLERY2_RESTORE_NOT_ISOLATED'],
  ['privileges', 'PIGALLERY2_METADATA_VISIBILITY_UNQUALIFIED'],
  ['schema', 'PIGALLERY2_SCHEMA_UNQUALIFIED'],
  ['structure', 'PIGALLERY2_STRUCTURE_VERSION_UNQUALIFIED'],
  ['orphan', 'PIGALLERY2_RELATIONSHIPS_INVALID'],
  ['query', 'PIGALLERY2_SOURCE_UNAVAILABLE'],
  ['disconnect', 'PIGALLERY2_SOURCE_UNAVAILABLE'],
  ['lock', 'PIGALLERY2_SOURCE_UNAVAILABLE'],
  ['missing', 'PIGALLERY2_INVENTORY_CHANGED'],
])('refuses %s and releases its connection', async (state, code) => {
  mode = state;
  await expect(collect()).rejects.toThrow(code);
  expect(destroy).toHaveBeenCalledOnce();
});
it('closes the source when the consumer stops early', async () => {
  const stream = readPigallery2MysqlRestore(config);
  await stream.next();
  await stream.return(undefined);
  expect(destroy).toHaveBeenCalledOnce();
});

it('completes 1001 records over independent keyset pages', async () => {
  records.media_entity = Array.from({ length: 1001 }, (_, i) => ({
    id: BigInt(i + 1),
    name: 'synthetic-' + i + '.jpg',
  }));
  const batches = await collect();
  expect(batches.filter((b) => b.table === 'media_entity').map((b) => b.rows.length)).toEqual([1000, 1]);
  const pages = query.mock.calls.filter(([q]) => q.sql.startsWith('SELECT * FROM `pigallery`.`media_entity`'));
  expect(pages.map(([, p]) => p)).toEqual([[], ['1000'], ['1001']]);
});
it.each(['text', 'repeated', 'unordered'] as const)(
  'refuses %s cursors before returning the invalid page',
  async (kind) => {
    records.media_entity =
      kind === 'text' ? [{ id: '1' }] : kind === 'repeated' ? [{ id: 1n }, { id: 1n }] : [{ id: 2n }, { id: 1n }];
    await expect(collect()).rejects.toThrow('PIGALLERY2_SOURCE_CURSOR_INVALID');
    expect(destroy).toHaveBeenCalledOnce();
  },
);
it.each([
  ['version', { version: 'unknown' }, 'PIGALLERY2_VERSION_UNQUALIFIED'],
  ['remote plaintext', { host: 'photos.example.test' }, 'PIGALLERY2_SOURCE_TLS_REQUIRED'],
  ['remote IP', { host: '192.0.2.1', tls: {} }, 'PIGALLERY2_SOURCE_TLS_HOST_UNQUALIFIED'],
  ['bad config', { database: 'bad\0name' }, 'PIGALLERY2_SOURCE_CONFIG_INVALID'],
] as const)('refuses %s before opening a connection', async (_name, changes, code) => {
  await expect(
    (async () => {
      for await (const _batch of readPigallery2MysqlRestore({ ...config, ...changes })) {
        expect.unreachable('Source should refuse before emitting content');
      }
    })(),
  ).rejects.toThrow(code);
  expect(createConnection).not.toHaveBeenCalled();
});
it('keeps protected passwords separate and refuses escaped callback use', async () => {
  const context = {
    operationId: '11111111-1111-4111-8111-111111111111',
    sourceUserId: '2',
    destinationUserId: '22222222-2222-4222-8222-222222222222',
  };
  let escaped: ((input: typeof context) => Promise<ImportedPassword | undefined>) | undefined;
  let credential: ImportedPassword | undefined;
  const batches = [];
  for await (const batch of readPigallery2MysqlRestore(config, async (password) => {
    escaped = password;
    credential = await password(context);
  }))
    batches.push(batch);
  expect(await verifyImportedPassword('Synthetic unit source password', credential!.forImport())).toBe(true);
  expect(JSON.stringify(batches, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(sourceHash);
  await expect(escaped!(context)).rejects.toThrow('PIGALLERY2_PASSWORD_UNAVAILABLE');
  expect(destroy).toHaveBeenCalledOnce();
});
it.each(['2e0', ' 2', '02', '2.0', '2147483648', '-2147483649'])(
  'refuses coerced or out-of-range owner ID %s',
  async (sourceUserId) => {
    await expect(
      (async () => {
        for await (const _batch of readPigallery2MysqlRestore(config, async (password) => {
          await password({
            operationId: '11111111-1111-4111-8111-111111111111',
            sourceUserId,
            destinationUserId: '22222222-2222-4222-8222-222222222222',
          });
        })) {
          expect.unreachable('Source should refuse before emitting content');
        }
      })(),
    ).rejects.toThrow('PIGALLERY2_PASSWORD_UNAVAILABLE');
    expect(query.mock.calls.some(([q]) => q.sql.startsWith('SELECT password'))).toBe(false);
  },
);
it('sanitizes consumer failures and releases the read lock', async () => {
  await expect(
    (async () => {
      for await (const _batch of readPigallery2MysqlRestore(config, () => Promise.reject(new Error(config.password)))) {
        expect.unreachable('Source should refuse before emitting content');
      }
    })(),
  ).rejects.toThrow(/^PiGallery2 source refused: PIGALLERY2_SOURCE_UNAVAILABLE$/);
  expect(destroy).toHaveBeenCalledOnce();
});

it('uses credential-free projections without reading password or share-token values', async () => {
  await collect();
  const statements = query.mock.calls.map(([q]) => q.sql as string);
  expect(statements.some((s) => s.startsWith('SELECT password FROM'))).toBe(false);
  const userStatements = statements.filter(
    (s) =>
      s.startsWith('SELECT ') &&
      !s.startsWith('SELECT COUNT') &&
      !s.startsWith('SELECT 1') &&
      s.includes('FROM `pigallery`.`user_entity`'),
  );
  expect(userStatements.length).toBeGreaterThan(0);
  for (const statement of userStatements) {
    expect(statement).not.toContain('SELECT *');
    expect(statement).not.toMatch(/\bpassword\b/i);
  }
  const sharingStatements = statements.filter(
    (s) =>
      s.startsWith('SELECT ') &&
      !s.startsWith('SELECT COUNT') &&
      !s.startsWith('SELECT 1') &&
      s.includes('FROM `pigallery`.`sharing_entity`'),
  );
  expect(sharingStatements.length).toBeGreaterThan(0);
  for (const statement of sharingStatements) {
    expect(statement).not.toContain('SELECT *');
    expect(statement).not.toContain('sharingKey');
    expect(statement).toContain('password IS NOT NULL AS has_password');
  }
});
