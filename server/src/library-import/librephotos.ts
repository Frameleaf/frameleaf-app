import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import fixture from 'src/library-import/fixtures/librephotos/1.5.1-sqlite.json' with { type: 'json' };
import { librephotosProjections as projections } from 'src/library-import/librephotos-projections.js';
import { sqliteSchemaFingerprint } from 'src/library-import/sqlite.js';

export type LibrephotosTable = keyof typeof projections;
export type LibrephotosRow = Record<string, SQLOutputValue>;

class LibrephotosReadError extends Error {
  constructor(readonly code: string) {
    super(`LibrePhotos source refused: ${code}`);
  }
}

/** Reads a privately captured snapshot; source identity and file consistency remain caller obligations. */
export const openLibrephotosSnapshot = (path: string, version: string) => {
  if (version !== fixture.source.version) throw new LibrephotosReadError('LIBREPHOTOS_VERSION_UNQUALIFIED');
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    throw new LibrephotosReadError('LIBREPHOTOS_SNAPSHOT_UNAVAILABLE');
  }
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    if (sqliteSchemaFingerprint(database) !== fixture.schemaSha256) {
      throw new LibrephotosReadError('LIBREPHOTOS_SCHEMA_UNQUALIFIED');
    }
    const required = new Set(fixture.migrations.map(({ app, name }) => JSON.stringify([app, name])));
    for (const row of database.prepare('SELECT app,name,applied FROM django_migrations').iterate()) {
      const key = JSON.stringify([row.app, row.name]);
      if (
        !required.delete(key) ||
        typeof row.applied !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}[ T]/.test(row.applied) ||
        !Number.isFinite(Date.parse(row.applied))
      ) {
        throw new LibrephotosReadError('LIBREPHOTOS_MIGRATIONS_INCOMPLETE');
      }
    }
    if (required.size > 0) throw new LibrephotosReadError('LIBREPHOTOS_MIGRATIONS_INCOMPLETE');
    if (database.prepare('PRAGMA foreign_key_check').get()) {
      throw new LibrephotosReadError('LIBREPHOTOS_RELATIONSHIPS_INVALID');
    }
  } catch (error) {
    database.close();
    if (error instanceof LibrephotosReadError) throw error;
    throw new LibrephotosReadError('LIBREPHOTOS_SNAPSHOT_UNAVAILABLE');
  }
  return {
    version,
    schemaSha256: fixture.schemaSha256,
    *rows(table: LibrephotosTable): Generator<LibrephotosRow[]> {
      if (!Object.hasOwn(projections, table)) throw new LibrephotosReadError('LIBREPHOTOS_TABLE_NOT_ALLOWED');
      try {
        const select = `SELECT rowid AS __frameleaf_cursor,${projections[table]} FROM "${table}"`;
        const first = database.prepare(`${select} ORDER BY rowid LIMIT 1000`);
        first.setReadBigInts(true);
        const next = database.prepare(`${select} WHERE rowid>? ORDER BY rowid LIMIT 1000`);
        next.setReadBigInts(true);
        let batch = first.all();
        while (batch.length > 0) {
          const cursor = batch.at(-1)!.__frameleaf_cursor;
          yield batch.map(({ __frameleaf_cursor: _cursor, ...row }) => row);
          batch = next.all(cursor);
        }
      } catch {
        throw new LibrephotosReadError('LIBREPHOTOS_SNAPSHOT_READ_FAILED');
      }
    },
    close: () => database.close(),
  };
};
