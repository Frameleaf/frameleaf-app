import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import fixture from 'src/library-import/fixtures/lychee/7.12.0-sqlite.json' with { type: 'json' };
import { ImportedPasswordContext } from 'src/library-import/passwords.js';
import { readSqlitePassword } from 'src/library-import/sqlite-password.js';
import { assertSqliteTextSafe, sqliteSchemaFingerprint } from 'src/library-import/sqlite.js';

const projections = {
  photos: '*',
  size_variants: '*',
  base_albums: '*',
  albums: '*',
  albums_tags: '*',
  photo_album: '*',
  photo_ratings: '*',
  tags: '*',
  photos_tags: '*',
  user_groups: '*',
  users_user_groups: '*',
  persons: '*',
  tag_albums: '*',
  tag_albums_tags: '*',
  person_albums: '*',
  person_albums_persons: '*',
  users:
    'id,username,email,display_name,may_upload,may_edit_own_settings,may_administrate,quota_kb,shared_albums_visibility,is_ldap,upload_trust_level,created_at,updated_at',
  access_permissions:
    'id,user_id,user_group_id,base_album_id,is_link_required,password IS NOT NULL AS has_password,grants_full_photo_access,grants_download,grants_upload,grants_edit,grants_delete,grants_move,created_at,updated_at',
  faces: 'id,photo_id,person_id,x,y,width,height,is_dismissed,cluster_label,created_at,updated_at',
} as const;
export type LycheeTable = keyof typeof projections;
export type LycheeRow = Record<string, SQLOutputValue>;
class LycheeReadError extends Error {
  constructor(readonly code: string) {
    super(`Lychee source refused: ${code}`);
  }
}

/** Reads a privately captured snapshot; caller establishes source identity, fencing, complete privacy evidence and original bytes. */
export const openLycheeSnapshot = (path: string, version: string, options: { bestEffort?: boolean } = {}) => {
  if (version !== fixture.source.version) throw new LycheeReadError('LYCHEE_VERSION_UNQUALIFIED');
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    throw new LycheeReadError('LYCHEE_SNAPSHOT_UNAVAILABLE');
  }
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    // Best effort (owner decision FL-1149): an untested schema is read through the same projections.
    if (options.bestEffort) {
      if (database.prepare('PRAGMA foreign_key_check').get()) throw new LycheeReadError('LYCHEE_RELATIONSHIPS_INVALID');
      return snapshotReader(database, version);
    }
    if (sqliteSchemaFingerprint(database) !== fixture.schemaSha256)
      throw new LycheeReadError('LYCHEE_SCHEMA_UNQUALIFIED');
    assertSqliteTextSafe(database, 'SELECT migration,batch FROM migrations');
    const expected = new Set(fixture.migrations.map((row) => row.migration));
    const migrations = database.prepare('SELECT migration,batch FROM migrations');
    migrations.setReadBigInts(true);
    for (const row of migrations.iterate()) {
      if (
        typeof row.migration !== 'string' ||
        !expected.delete(row.migration) ||
        typeof row.batch !== 'bigint' ||
        row.batch <= 0n
      )
        throw new LycheeReadError('LYCHEE_MIGRATIONS_UNQUALIFIED');
    }
    if (expected.size > 0) throw new LycheeReadError('LYCHEE_MIGRATIONS_UNQUALIFIED');
    if (database.prepare('PRAGMA foreign_key_check').get()) throw new LycheeReadError('LYCHEE_RELATIONSHIPS_INVALID');
  } catch (error) {
    database.close();
    if (error instanceof LycheeReadError) throw error;
    throw new LycheeReadError('LYCHEE_SNAPSHOT_UNAVAILABLE');
  }
  return snapshotReader(database, version);
};

const snapshotReader = (database: DatabaseSync, version: string) => {
  return {
    version,
    schemaSha256: fixture.schemaSha256,
    password: (context: ImportedPasswordContext) =>
      readSqlitePassword(
        database,
        context,
        'php-password',
        'SELECT CASE WHEN is_ldap=0 THEN password ELSE NULL END AS password FROM users WHERE id=?',
      ),
    *rows(table: LycheeTable): Generator<LycheeRow[]> {
      if (!Object.hasOwn(projections, table)) throw new LycheeReadError('LYCHEE_TABLE_NOT_ALLOWED');
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
        throw new LycheeReadError('LYCHEE_SNAPSHOT_READ_FAILED');
      }
    },
    close: () => database.close(),
  };
};

export { readLycheeManifest } from 'src/library-import/lychee-manifest.js';
