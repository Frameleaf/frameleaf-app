import { CompiledQuery, Kysely, sql } from 'kysely';
import type postgres from 'postgres';
import fixture from 'src/library-import/fixtures/librephotos/1.5.1-postgres18.json' with { type: 'json' };
import { openLibrephotosPostgresSnapshot } from 'src/library-import/librephotos-postgres-source.js';
import { postgresSchemaQueries } from 'src/library-import/postgres-schema.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

const transport = vi.hoisted(() => ({ unsafe: vi.fn() }));
vi.mock('postgres', async (importOriginal) => {
  const original = await importOriginal<{ default: typeof postgres }>();
  const connect = Object.assign((...args: unknown[]) => {
    if (args[0] === 'postgres://synthetic:unused@localhost/fixture') {
      return { reserve: () => Promise.resolve({ unsafe: transport.unsafe, release: vi.fn() }), end: vi.fn() };
    }
    return Reflect.apply(original.default, undefined, args);
  }, original.default);
  return { ...original, default: connect };
});

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => db?.destroy());

it('streams every native integer key across text-projected page boundaries', async () => {
  const columns = fixture.structure.columns.filter((column) => column.table_name === 'api_person');
  await sql
    .raw(`CREATE TABLE public.api_person (${columns.map((column) => `"${column.name}" ${column.type}`).join(',')})`)
    .execute(db);
  await sql`INSERT INTO public.api_person(id,name,kind,face_count,last_modified,share_location,share_other_people)
    SELECT n,'Pagination fixture '||n,'USER',0,now(),false,false FROM generate_series(1,2505) AS n`.execute(db);

  // Stub admission facts only; production paging statements execute on native PostgreSQL.
  transport.unsafe.mockImplementation(async (statement: string, parameters: unknown[] = []) => {
    if (statement.includes('FROM ONLY public."api_person"'))
      return (await db.executeQuery(CompiledQuery.raw(statement, parameters))).rows;
    if (statement.includes('rolsuper'))
      return [
        {
          readonly: 'on',
          rolsuper: false,
          rolbypassrls: false,
          elevated: false,
          writable: false,
          other_clients: false,
        },
      ];
    if (statement.includes("current_setting('server_version')")) return [{ version: fixture.source.database.version }];
    if (statement.includes('FROM public.django_migrations'))
      return fixture.migrations.map((row) => ({ ...row, finished: true }));
    const query = Object.entries(postgresSchemaQueries).find(([, value]) => value === statement);
    if (query) return fixture.structure[query[0] as keyof typeof fixture.structure];
    return [];
  });
  const source = await openLibrephotosPostgresSnapshot('postgres://synthetic:unused@localhost/fixture', '1.5.1', true);
  try {
    const ids: bigint[] = [];
    const sizes: number[] = [];
    for await (const page of source.rows('api_person')) {
      sizes.push(page.length);
      ids.push(...page.map((row) => row.id as bigint));
    }
    expect(ids).toHaveLength(2505);
    expect(ids).toEqual(Array.from({ length: 2505 }, (_, index) => BigInt(index + 1)));
    expect(new Set(ids).size).toBe(2505);
    expect(sizes).toEqual([1000, 1000, 505]);
  } finally {
    await source.close();
  }
});
