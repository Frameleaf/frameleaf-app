// Replays one Immich tag's own Kysely migrations into an empty database and records its catalog.
// Usage: tsx replay.ts <tag> <database url> <output json> <migrations dir>
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres from 'postgres';
import { readdirSync, writeFileSync } from 'node:fs';
const [tag, url, out, dir] = process.argv.slice(2);
const db = new Kysely<any>({
  dialect: new PostgresJSDialect({
    postgres: postgres(url, { onnotice: () => {} }),
  }),
});
await sql`CREATE TABLE IF NOT EXISTS kysely_migrations (name varchar(255) PRIMARY KEY, timestamp varchar(255) NOT NULL)`.execute(
  db,
);
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.ts'))
  .sort()) {
  const m = await import(`${dir}/${file}`);
  try {
    await m.up(db);
  } catch (e) {
    console.error(`${tag} ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
  await sql`INSERT INTO kysely_migrations VALUES (${file.replace(/\.ts$/, '')}, now()::text)`.execute(
    db,
  );
}
const q = async (s: string) => (await sql.raw(s).execute(db)).rows as any[];
const columns =
  await q(`SELECT c.relname AS t, a.attname AS c, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS nn,
  pg_get_expr(d.adbin,d.adrelid) AS def, a.attidentity AS ident, a.attgenerated AS gen
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY 1,2`);
const enums = await q(
  `SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname='public' GROUP BY 1 ORDER BY 1`,
);
const tables: Record<
  string,
  Record<string, { type: string; nn: boolean }>
> = {};
const structure: Record<string, Record<string, unknown>> = {};
for (const r of columns) {
  (tables[r.t] ??= {})[r.c] = { type: r.type, nn: r.nn };
  (structure[r.t] ??= {})[r.c] = {
    type: r.type,
    not_null: r.nn,
    default: r.def,
    identity: r.ident,
    generated: r.gen,
  };
}
writeFileSync(
  out,
  JSON.stringify(
    {
      tag,
      structure,
      migrations: readdirSync(dir)
        .filter((f) => f.endsWith('.ts'))
        .sort()
        .map((f) => f.slice(0, -3)),
      tables,
      enums,
    },
    null,
    1,
  ),
);
await db.destroy();
