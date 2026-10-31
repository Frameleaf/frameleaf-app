import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import type { AssetFileSearchDto } from 'src/dtos/asset-file.dto.js';
import type { DB } from 'src/schema/index.js';
import { AssetFileType } from 'src/enum.js';
import { AssetFileRepository } from 'src/repositories/asset-file.repository.js';

const queries: { sql: string; parameters: readonly unknown[] }[] = [];
const db = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
  log(event) {
    if (event.level === 'query') queries.push(event.query);
  },
});
const repository = new AssetFileRepository(db);
afterAll(() => db.destroy());

const cases: AssetFileSearchDto[] = [];
for (const type of [undefined, AssetFileType.Preview])
  for (const isEdited of [undefined, false, true])
    for (const isProgressive of [undefined, false, true])
      for (const isTransparent of [undefined, false, true])
        cases.push({ assetId: 'asset-fixture', type, isEdited, isProgressive, isTransparent });

it.each(cases)('preserves search SQL and parameter bindings for %j', async (dto) => {
  queries.length = 0;
  expect(await repository.search(dto)).toEqual([]);
  const parameters: unknown[] = [dto.assetId];
  const predicates = ['"assetId" = $1'];
  for (const field of ['type', 'isEdited', 'isProgressive', 'isTransparent'] as const) {
    if (dto[field] !== undefined) {
      parameters.push(dto[field]);
      predicates.push(`"${field}" = $${parameters.length}`);
    }
  }
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatchObject({
    sql: `select * from "asset_file" where ${predicates.join(' and ')}`,
    parameters,
  });
});
