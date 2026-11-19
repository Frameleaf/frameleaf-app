import { schemaDiff } from '@frameleaf/sql-tools';
import { getFrameleafBaselineSchema, getFrameleafSchema } from 'src/schema/frameleaf-schema.js';

const wholeArray =
  "(ARRAY['completed'::character varying, 'cancelled'::character varying, 'failed'::character varying])::text[]";
const elementArray =
  "ARRAY[('completed'::character varying)::text, ('cancelled'::character varying)::text, ('failed'::character varying)::text]";

const replayPair = () => {
  const source = getFrameleafBaselineSchema();
  const target = structuredClone(source);
  const index = target.tables
    .flatMap(({ indexes }) => indexes)
    .find(({ name }) => name === 'media_operation_retryOfId_active_uq')!;
  index.definition = index.definition!.replace(wholeArray, () => elementArray);
  index.where = index.where!.replace(wholeArray, () => elementArray);
  return { source, target, index };
};

it('recognizes PostgreSQL replay of a varchar literal array cast without changing pinned catalogs', () => {
  const { source, target } = replayPair();
  expect(schemaDiff(source, target).asSql()).toEqual([]);
  expect(schemaDiff(target, source).asSql()).toEqual([]);
});

it.each([
  ["'failed'", "'needs_attention'"],
  ['<> ALL', '= ANY'],
  ['::text', '::citext'],
  ['CREATE UNIQUE INDEX', 'CREATE INDEX'],
])('still detects a real index change from %s to %s', (before, after) => {
  const { source, target, index } = replayPair();
  index.definition = index.definition!.replace(before, () => after);
  const changes = schemaDiff(source, target).asSql();
  expect(changes).toHaveLength(2);
  expect(changes[0]).toContain('DROP INDEX');
  expect(changes[1]).toContain('CREATE UNIQUE INDEX');
});

it.each([
  (value: string) => `'${value.replaceAll("'", "''")}'`,
  (value: string) => `E'${value.replaceAll("'", String.raw`\'`)}'`,
  (value: string) => `$value$${value}$value$`,
  (value: string) => `$é$${value}$é$`,
  (value: string) => `$💾$${value}$💾$`,
  (value: string) => `"${value}"`,
])('never normalizes SQL text inside a quoted value or identifier', (quote) => {
  const { source, target, index } = replayPair();
  const original = source.tables.flatMap(({ indexes }) => indexes).find(({ name }) => name === index.name)!;
  original.definition = `CREATE INDEX example ON example ((value = ${quote(wholeArray)}))`;
  index.definition = `CREATE INDEX example ON example ((value = ${quote(elementArray)}))`;
  expect(schemaDiff(source, target).asSql()).toHaveLength(2);
});

it('retains a real drift inside a lowercase escape string after an escaped quote', () => {
  const { source, target, index } = replayPair();
  const original = source.tables.flatMap(({ indexes }) => indexes).find(({ name }) => name === index.name)!;
  original.definition = String.raw`CREATE INDEX example ON example ((value = e'prefix\' (ARRAY[''::character varying])::text[]'))`;
  index.definition = String.raw`CREATE INDEX example ON example ((value = e'prefix\' ARRAY[(''::character varying)::text]'))`;
  expect(schemaDiff(source, target).asSql()).toHaveLength(2);
});

// The baseline was frozen on PostgreSQL 19 RC 1; the desired catalog is a 19.0 capture.
it('recognizes the PostgreSQL 19.0 parentheses around zoned date_trunc index expressions', () => {
  const names = ['asset_localDateTime_month_idx', 'asset_owner_taken_page_idx', 'asset_owner_added_page_idx'];
  const pick = (schema: ReturnType<typeof getFrameleafSchema>) => {
    const asset = structuredClone(schema.tables.find(({ name }) => name === 'asset')!);
    asset.indexes = asset.indexes.filter(({ name }) => names.includes(name));
    return { ...schema, tables: [asset] };
  };
  const rc = pick(getFrameleafBaselineSchema());
  const release = pick(getFrameleafSchema());
  const definitions = (schema: typeof rc) => schema.tables[0].indexes.map(({ definition }) => definition);
  expect(definitions(rc)).toHaveLength(3);
  expect(definitions(rc)).not.toEqual(expect.arrayContaining(definitions(release)));
  const indexSql = (changes: string[]) => changes.filter((statement) => names.some((name) => statement.includes(name)));
  expect(indexSql(schemaDiff(rc, release).asSql())).toEqual([]);
  expect(indexSql(schemaDiff(release, rc).asSql())).toEqual([]);

  const [index] = release.tables[0].indexes;
  index.definition = index.definition!.replace("'MONTH'", () => "'DAY'");
  expect(indexSql(schemaDiff(rc, release).asSql())).toHaveLength(2);
});
