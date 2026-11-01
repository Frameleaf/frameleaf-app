import fixture from 'src/library-import/fixtures/librephotos/1.5.1-postgres18.json' with { type: 'json' };
import { librephotosProjections } from 'src/library-import/librephotos-projections.js';
import { LibrephotosRow, LibrephotosTable } from 'src/library-import/librephotos.js';
import { PostgresSourceSchema, postgresSchemaFingerprint } from 'src/library-import/postgres-schema.js';

class LibrephotosPostgresError extends Error {
  constructor(readonly code: string) {
    super(`LibrePhotos source refused: ${code}`);
  }
}

/** Catalog admission and scalar decoding only; the caller must hold a fenced, read-only source snapshot. */
export const createLibrephotosPostgresDecoder = (
  schema: PostgresSourceSchema,
  version: string,
  engineVersion: string,
) => {
  if (version !== fixture.source.version) throw new LibrephotosPostgresError('LIBREPHOTOS_VERSION_UNQUALIFIED');
  if (engineVersion !== fixture.source.database.version)
    throw new LibrephotosPostgresError('LIBREPHOTOS_POSTGRES_ENGINE_UNQUALIFIED');
  if (postgresSchemaFingerprint(schema) !== fixture.schemaSha256)
    throw new LibrephotosPostgresError('LIBREPHOTOS_POSTGRES_SCHEMA_UNQUALIFIED');
  const tables = Object.fromEntries(
    Object.entries(librephotosProjections).map(([table, projection]) => {
      const all = fixture.structure.columns.filter((column) => column.table_name === table);
      const names = projection === '*' ? all.map((column) => column.name) : projection.split(',');
      return [table, { names, columns: names.map((name) => all.find((column) => column.name === name)!) }];
    }),
  );

  return {
    schemaSha256: fixture.schemaSha256,
    decode(table: LibrephotosTable, row: Record<string, string | null>): LibrephotosRow {
      if (!Object.hasOwn(librephotosProjections, table))
        throw new LibrephotosPostgresError('LIBREPHOTOS_TABLE_NOT_ALLOWED');
      const { names, columns } = tables[table];
      try {
        if (Object.keys(row).length !== names.length || names.some((name) => !Object.hasOwn(row, name)))
          throw new Error('Column mismatch');
        return Object.fromEntries(
          columns.map((column) => {
            const name = column.name;
            const value = row[name];
            if (value === null) {
              if (column.not_null) throw new Error('Null required column');
              return [name, null];
            }
            if (typeof value !== 'string') throw new Error('Expected PostgreSQL text protocol');
            let decoded: LibrephotosRow[string];
            switch (column.type) {
              case 'smallint':
              case 'integer':
              case 'bigint': {
                if (!/^-?\d+$/u.test(value)) throw new Error('Invalid integer');
                decoded = BigInt(value);
                break;
              }
              case 'boolean': {
                if (value !== 'true' && value !== 'false') throw new Error('Invalid boolean');
                decoded = value === 'true' ? 1n : 0n;
                break;
              }
              case 'double precision': {
                if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) || !Number.isFinite(Number(value)))
                  throw new Error('Invalid finite number');
                decoded = Number(value);
                break;
              }
              case 'uuid': {
                if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(value))
                  throw new Error('Invalid UUID');
                decoded = value.replaceAll('-', '');
                break;
              }
              case 'timestamp with time zone': {
                // Source sessions use UTC; capture-time semantics remain the metadata adapter's responsibility.
                if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/u.test(value))
                  throw new Error('Expected UTC session');
                decoded = value.slice(0, -3);
                break;
              }
              case 'jsonb': {
                JSON.parse(value);
                decoded = value;
                break;
              }
              default: {
                if (
                  column.type !== 'text' &&
                  column.type !== 'date' &&
                  !/^character varying\(\d+\)$/u.test(column.type)
                )
                  throw new Error('Unqualified scalar type');
                decoded = value;
              }
            }
            return [name, decoded];
          }),
        );
      } catch {
        throw new LibrephotosPostgresError('LIBREPHOTOS_POSTGRES_ROW_INVALID');
      }
    },
  };
};
