import { canonicalJson } from 'src/immich-import/adapters.js';
import { ImportDatabase, ImportRefused } from 'src/immich-import/types.js';

export type ColumnStructure = {
  type: string;
  not_null: boolean;
  default: string | null;
  identity: string;
  generated: string;
};
export type SourceStructure = {
  tables: Record<string, Record<string, ColumnStructure>>;
  constraints: { table_name: string; name: string; definition: string }[];
  uniqueIndexes: { table_name: string; name: string; definition: string }[];
  enums: { name: string; labels: string[] }[];
};
const bookkeeping = new Set(['migrations', 'kysely_migrations', 'kysely_migrations_lock']);

/** Preserve quoted string contents and identifier case. Ignore only equivalent public qualification and layout. */
export const normalizeSchemaSql = (sql: string): string => {
  const tokens = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[a-zA-Z_][\w$]*|\d+(?:\.\d+)?|::|<>|<=|>=|[^\s]/gu) ?? [];
  const normalized = tokens.map((token) => (/^"[a-z_][a-z_\d]*"$/u.test(token) ? token.slice(1, -1) : token));
  const output: string[] = [];
  for (let index = 0; index < normalized.length; index++) {
    const token = normalized[index];
    if (token === 'public' && normalized[index + 1] === '.') {
      index++;
      continue;
    }
    if (
      token === 'ON' &&
      ['UPDATE', 'DELETE'].includes(normalized[index + 1]) &&
      normalized[index + 2] === 'NO' &&
      normalized[index + 3] === 'ACTION'
    ) {
      index += 3;
      continue;
    }
    // Index storage parameters are not key/constraint semantics. Never apply replacements inside literals.
    if (
      token === 'WITH' &&
      normalized[index + 1] === '(' &&
      normalized[index + 2] === 'fillfactor' &&
      normalized[index + 3] === '=' &&
      /^'?\d+'?$/u.test(normalized[index + 4]) &&
      normalized[index + 5] === ')'
    ) {
      index += 5;
      continue;
    }
    output.push(token);
  }
  return output.join(' ');
};
const normalizeDefault = (value: string | null): string | null =>
  value === null || /^NULL(?:\s*::.*)?$/u.test(value) ? null : normalizeSchemaSql(value);
const canonicalStructure = (structure: SourceStructure): string =>
  canonicalJson({
    tables: Object.fromEntries(
      Object.entries(structure.tables)
        .filter(([table]) => !bookkeeping.has(table))
        .map(([table, columns]) => [
          table,
          Object.fromEntries(
            Object.entries(columns).map(([column, shape]) => [
              column,
              {
                ...shape,
                // CLIP dimensions are an upstream configuration setting; admission inspects the actual typmod.
                type:
                  table === 'smart_search' &&
                  column === 'embedding' &&
                  /^(?:(?:public|vectors)\.)?vector\([1-9]\d*\)$/u.test(shape.type)
                    ? 'vector(configurable)'
                    : shape.type.replace(/^(?:public|vectors)\./u, ''),
                default: normalizeDefault(shape.default),
              },
            ]),
          ),
        ]),
    ),
    constraints: structure.constraints
      .filter((entry) => !bookkeeping.has(entry.table_name))
      .map((entry) => ({
        ...entry,
        definition: normalizeSchemaSql(entry.definition),
      }))
      .sort((a, b) => a.table_name.localeCompare(b.table_name) || a.name.localeCompare(b.name)),
    uniqueIndexes: structure.uniqueIndexes
      .filter((entry) => !bookkeeping.has(entry.table_name))
      .map((entry) => ({
        ...entry,
        definition: normalizeSchemaSql(entry.definition),
      }))
      .sort((a, b) => a.table_name.localeCompare(b.table_name) || a.name.localeCompare(b.name)),
    enums: [...structure.enums].sort((a, b) => a.name.localeCompare(b.name)),
  });

export const readSourceStructure = async (db: ImportDatabase): Promise<SourceStructure> => {
  const columns = await db.query(`SELECT c.relname AS table_name, a.attname AS column_name,
    format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null,
    pg_get_expr(d.adbin,d.adrelid) AS default, a.attidentity AS identity, a.attgenerated AS generated
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname,a.attname`);
  const tables: SourceStructure['tables'] = {};
  for (const column of columns) {
    (tables[String(column.table_name)] ??= {})[String(column.column_name)] = {
      type: String(column.type),
      not_null: column.not_null === true,
      default: column.default === null ? null : String(column.default),
      identity: String(column.identity),
      generated: String(column.generated),
    };
  }
  const constraints = await db.query(`SELECT c.relname AS table_name, p.conname AS name,
    pg_get_constraintdef(p.oid) AS definition FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND p.contype <> 'n'
    ORDER BY c.relname,p.conname`);
  const uniqueIndexes = await db.query(`SELECT c.relname AS table_name, i.relname AS name,
    substring(pg_get_indexdef(i.oid) from 'USING .*$') || CASE WHEN p.indisvalid AND p.indisready THEN '' ELSE ' INVALID' END AS definition
    FROM pg_index p JOIN pg_class i ON i.oid=p.indexrelid JOIN pg_class c ON c.oid=p.indrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND p.indisunique
      AND NOT EXISTS (SELECT 1 FROM pg_constraint constraint_owner WHERE constraint_owner.conindid=i.oid AND constraint_owner.contype IN ('p','u','x'))
    ORDER BY c.relname,i.relname`);
  const enums = await db.query(`SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
    WHERE n.nspname='public' GROUP BY t.typname ORDER BY t.typname`);
  return { tables, constraints, uniqueIndexes, enums } as SourceStructure;
};

export const verifySourceStructure = (actual: SourceStructure, expected: SourceStructure): void => {
  if (canonicalStructure(actual) !== canonicalStructure(expected)) {
    throw new ImportRefused('UNKNOWN_SOURCE_SCHEMA');
  }
};
