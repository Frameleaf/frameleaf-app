import { sql } from 'kysely';
import { FileMigrationProvider } from 'kysely/migration';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Runtime and CLI must execute exactly the same checked-in canonical migration chain. */
export const createMigrationProvider = (migrationFolder, options = {}) => ({
  async getMigrations() {
    const content = await readFile(join(migrationFolder, 'ORDER'), 'utf8');
    const names = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (names.length === 0 || names.some((name) => !/^\d{13}-[A-Za-z0-9_-]+$/.test(name))) {
      throw new Error('Invalid canonical migration ORDER');
    }
    if (new Set(names).size !== names.length || names.some((name, index) => index > 0 && name <= names[index - 1])) {
      throw new Error('Canonical migration ORDER must be unique and ascending');
    }
    const filenames = (await readdir(migrationFolder)).filter((name) => /\.(?:js|mjs|ts|mts)$/.test(name) && !/\.d\.(?:ts|mts)$/.test(name));
    const unlisted = filenames.map((name) => name.replace(/\.[^.]+$/, '')).filter((name) => !names.includes(name));
    if (unlisted.length) throw new Error(`Canonical migration ORDER mismatch: unlisted [${unlisted.join(', ')}]`);
    // Source runners must resolve migrations in their own module loader (e.g. Vitest's TS aliases).
    // Native Node imports require file URLs for Windows drives and URL-significant characters.
    const provider = new FileMigrationProvider({ fs: { readdir }, path: { join }, migrationFolder,
      import: options.import ?? ((filename) => import(pathToFileURL(filename).href)) });
    const migrations = await provider.getMigrations();
    const unexpected = Object.keys(migrations).filter((name) => !names.includes(name));
    const missing = names.filter((name) => !Object.hasOwn(migrations, name));
    if (unexpected.length || missing.length) {
      throw new Error(`Canonical migration ORDER mismatch: missing [${missing.join(', ')}], unlisted [${unexpected.join(', ')}]`);
    }
    await readRenames(migrationFolder, names);
    return Object.fromEntries(names.map((name) => [name, migrations[name]]));
  },
});

/** Adopt explicitly renamed, unchanged migration bodies before taking a migrator connection. */
export async function adoptMigrationRenames(db, migrationFolder, options = {}) {
  const migrations = await createMigrationProvider(migrationFolder, options).getMigrations();
  const names = Object.keys(migrations);
  const renames = await readRenames(migrationFolder, names);
  if (renames.length) await adoptRenamedMigrations(db, names, renames);
}

async function readRenames(migrationFolder, names) {
  const content = await readFile(join(migrationFolder, 'RENAMES'), 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const renames = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.split(/\s+/));
  if (renames.some(([from, to, extra]) => extra || !/^\d{13}-[A-Za-z0-9_-]+$/.test(from) || names.includes(from) || !names.includes(to)) ||
    new Set(renames.map(([from]) => from)).size !== renames.length || new Set(renames.map(([, to]) => to)).size !== renames.length) {
    throw new Error('Invalid canonical migration RENAMES');
  }
  return renames;
}

// Renames only adopt already-executed bodies; the strict migrator still validates and runs the canonical chain.
async function adoptRenamedMigrations(db, names, renames) {
  const { rows: present } =
    await sql`SELECT to_regclass('public.frameleaf_migrations') IS NOT NULL AS present`.execute(
      db,
    );
  if (!present[0]?.present) return;
  const adopt = async (tx) => {
    await sql`LOCK TABLE public.frameleaf_migrations IN ACCESS EXCLUSIVE MODE`.execute(
      tx,
    );
    const { rows } =
      await sql`SELECT name, timestamp FROM public.frameleaf_migrations`.execute(
        tx,
      );
    const aliases = new Map(renames);
    const changed = rows.filter(({ name }) => aliases.has(name));
    if (!changed.length) return;
    const adopted = rows.map(({ name }) => aliases.get(name) ?? name).sort();
    if (adopted.some((name, index) => name !== names[index]))
      throw new Error('Cannot adopt noncanonical migration RENAMES history');
    const canonicalRows = new Map(
      rows.map((row) => [aliases.get(row.name) ?? row.name, row]),
    );
    if (rows.some((row) => !Number.isFinite(Date.parse(row.timestamp))))
      throw new Error('Cannot adopt invalid migration timestamp');
    for (const row of changed.sort((a, b) =>
      aliases.get(a.name).localeCompare(aliases.get(b.name)),
    )) {
      const name = aliases.get(row.name);
      const previous = canonicalRows.get(names[names.indexOf(name) - 1]);
      // Kysely breaks equal timestamps by name: share the predecessor's timestamp to keep later rows ordered too.
      const timestamp = previous?.timestamp ?? row.timestamp;
      await sql`UPDATE public.frameleaf_migrations SET name = ${name}, timestamp = ${timestamp} WHERE name = ${row.name}`.execute(
        tx,
      );
      row.timestamp = timestamp;
    }
  };
  if (db.isTransaction) await adopt(db);
  else await db.transaction().execute(adopt);
}
