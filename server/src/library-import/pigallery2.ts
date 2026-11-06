import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import fixture from 'src/library-import/fixtures/pigallery2/3.5.2-sqlite.json' with { type: 'json' };
import { ImportedPasswordContext } from 'src/library-import/passwords.js';
import { pigallery2Projections as projections } from 'src/library-import/pigallery2-projections.js';
import { readSqlitePassword } from 'src/library-import/sqlite-password.js';
import { assertSqliteTextSafe, sqliteSchemaFingerprint } from 'src/library-import/sqlite.js';

export { readPigallery2Manifest } from 'src/library-import/pigallery2-manifest.js';

export type Pigallery2Table = keyof typeof projections;
export type Pigallery2Row = Record<string, SQLOutputValue>;
class Pigallery2ReadError extends Error {
  constructor(readonly code: string) {
    super(`PiGallery2 source refused: ${code}`);
  }
}

/**
 * Reads a frozen snapshot; caller separately qualifies source identity, global policy, explicit owners and original
 * bytes. `bestEffort` (owner decision FL-1149) skips the version, schema-fingerprint and data-structure-version pins and
 * keeps the relationship check; `qualified` reports whether those pins would have passed.
 */
export const openPigallery2Snapshot = (path: string, version: string, options: { bestEffort?: boolean } = {}) => {
  const bestEffort = options.bestEffort === true;
  if (!bestEffort && version !== fixture.source.version)
    throw new Pigallery2ReadError('PIGALLERY2_VERSION_UNQUALIFIED');
  let database: DatabaseSync;
  let schemaSha256: string;
  let qualified = true;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    throw new Pigallery2ReadError('PIGALLERY2_SNAPSHOT_UNAVAILABLE');
  }
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    const pin = (passed: boolean, code: string) => {
      if (passed) return;
      if (!bestEffort) throw new Pigallery2ReadError(code);
      qualified = false;
    };
    schemaSha256 = sqliteSchemaFingerprint(database);
    pin(schemaSha256 === fixture.schemaSha256, 'PIGALLERY2_SCHEMA_UNQUALIFIED');
    let versions: Record<string, SQLOutputValue>[] = [];
    try {
      const statement = database.prepare('SELECT version FROM version_entity');
      statement.setReadBigInts(true);
      versions = statement.all();
    } catch (error) {
      // A best-effort source may have renamed its structure-version table; that only makes it untested.
      if (!bestEffort) throw error;
    }
    pin(
      versions.length === 1 && versions[0].version === BigInt(fixture.runtime.dataStructureVersion),
      'PIGALLERY2_STRUCTURE_VERSION_UNQUALIFIED',
    );
    if (database.prepare('PRAGMA foreign_key_check').get())
      throw new Pigallery2ReadError('PIGALLERY2_RELATIONSHIPS_INVALID');
  } catch (error) {
    database.close();
    if (error instanceof Pigallery2ReadError) throw error;
    throw new Pigallery2ReadError('PIGALLERY2_SNAPSHOT_UNAVAILABLE');
  }
  return {
    version,
    schemaSha256,
    /** The schema and data-structure version match the qualified fixture (always true unless best effort). */
    qualified,
    password: (context: ImportedPasswordContext) =>
      readSqlitePassword(database, context, 'bcrypt', 'SELECT password FROM user_entity WHERE id=?'),
    *rows(table: Pigallery2Table): Generator<Pigallery2Row[]> {
      if (!Object.hasOwn(projections, table)) throw new Pigallery2ReadError('PIGALLERY2_TABLE_NOT_ALLOWED');
      try {
        const select = `SELECT rowid AS __frameleaf_cursor,${projections[table]} FROM "${table}"`;
        const first = database.prepare(`${select} ORDER BY rowid LIMIT 1000`);
        const next = database.prepare(`${select} WHERE rowid>? ORDER BY rowid LIMIT 1000`);
        first.setReadBigInts(true);
        next.setReadBigInts(true);
        assertSqliteTextSafe(database, first.sourceSQL);
        let batch = first.all();
        while (batch.length > 0) {
          const cursor = batch.at(-1)!.__frameleaf_cursor;
          yield batch.map(({ __frameleaf_cursor: _cursor, ...row }) => row);
          assertSqliteTextSafe(database, next.sourceSQL, [cursor]);
          batch = next.all(cursor);
        }
      } catch {
        throw new Pigallery2ReadError('PIGALLERY2_SNAPSHOT_READ_FAILED');
      }
    },
    close: () => database.close(),
  };
};
