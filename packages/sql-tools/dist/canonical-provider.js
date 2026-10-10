import { FileMigrationProvider } from 'kysely/migration';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

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
    // Compiled runtime and CLI callers can keep Kysely's native import default.
    const provider = new FileMigrationProvider({ fs: { readdir }, path: { join }, migrationFolder, import: options.import });
    const migrations = await provider.getMigrations();
    const unexpected = Object.keys(migrations).filter((name) => !names.includes(name));
    const missing = names.filter((name) => !Object.hasOwn(migrations, name));
    if (unexpected.length || missing.length) {
      throw new Error(`Canonical migration ORDER mismatch: missing [${missing.join(', ')}], unlisted [${unexpected.join(', ')}]`);
    }
    return Object.fromEntries(names.map((name) => [name, migrations[name]]));
  },
});
