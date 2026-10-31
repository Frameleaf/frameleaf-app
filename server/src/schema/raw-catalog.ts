import type { DatabaseSchema } from '@frameleaf/sql-tools';

type RawObject = { schema: string; table: string; name: string; definition: string };
export type RawCatalog = { constraints: RawObject[]; triggers: RawObject[] };

/** Independently cross-check pg_dump's companion pg_catalog query against the modeled reader. */
export const verifyRawCatalog = (catalog: DatabaseSchema, raw: RawCatalog): void => {
  for (const kind of ['constraints', 'triggers'] as const) {
    const notNullColumns = new Set(
      kind === 'constraints'
        ? catalog.tables.flatMap((table) =>
            table.columns.filter((column) => !column.nullable).map((column) => `${table.name}.${column.name}`),
          )
        : [],
    );
    const expected = new Map<string, string>(
      catalog.tables.flatMap((table) =>
        table[kind].map((item) => {
          if (!item.definition) throw new Error(`Catalog lacks exact definition for ${table.name}.${item.name}`);
          return [`${table.name}.${item.name}`, item.definition] as const;
        }),
      ),
    );
    for (const item of raw[kind]) {
      if (item.schema !== 'public' || ['frameleaf_migrations', 'frameleaf_migrations_lock'].includes(item.table))
        continue;
      const key = `${item.table}.${item.name}`;
      // PostgreSQL 19 represents NOT NULL as constraints; the reader represents it on the column.
      const notNull = item.definition.match(/^NOT NULL (?:"((?:[^"]|"")+)"|([A-Za-z_][\w$]*))$/u);
      if (kind === 'constraints' && notNull) {
        const column = (notNull[1] ?? notNull[2]).replaceAll('""', '"');
        if (
          catalog.tables.find(({ name }) => name === item.table)?.columns.find(({ name }) => name === column)
            ?.nullable !== false
        ) {
          throw new Error(`Raw NOT NULL definition missing from catalog: ${key}`);
        }
        notNullColumns.delete(`${item.table}.${column}`);
        continue;
      }
      if (!expected.has(key) || expected.get(key) !== item.definition)
        throw new Error(`Raw ${kind} differs from catalog: ${key}`);
      expected.delete(key);
    }
    if (notNullColumns.size > 0)
      throw new Error(`Raw NOT NULL capture is incomplete: ${notNullColumns.values().next().value}`);
    if (expected.size > 0) throw new Error(`Raw ${kind} capture is incomplete: ${expected.keys().next().value}`);
  }
};
