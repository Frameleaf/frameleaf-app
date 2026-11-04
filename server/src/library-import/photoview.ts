import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import fixture from 'src/library-import/fixtures/photoview/2.4.0-sqlite.json' with { type: 'json' };
import { ImportedPasswordContext } from 'src/library-import/passwords.js';
import { readSqlitePassword } from 'src/library-import/sqlite-password.js';
import { assertSqliteTextSafe, sqliteSchemaFingerprint } from 'src/library-import/sqlite.js';

// Wildcards cover content-only tables in the exact fingerprinted source schema.
const projections = {
  users: 'id,username,admin,created_at,updated_at',
  albums: '*',
  media: '*',
  media_exif: '*',
  video_metadata: '*',
  user_albums: '*',
  user_media_data: '*',
  face_groups: '*',
  image_faces: 'id,created_at,updated_at,face_group_id,media_id,rectangle',
  media_urls: 'id,created_at,updated_at,media_id,width,height,purpose,content_type,file_size',
  user_preferences: '*',
  share_tokens: 'id,created_at,updated_at,owner_id,album_id,media_id,expire,password IS NOT NULL AS has_password',
} as const;
export type PhotoviewTable = keyof typeof projections;
export type PhotoviewRow = Record<string, SQLOutputValue>;
class PhotoviewReadError extends Error {
  constructor(readonly code: string) {
    super(`Photoview source refused: ${code}`);
  }
}

const qualifiedSchema = (database: DatabaseSync) => {
  const schemaSha256 = sqliteSchemaFingerprint(database);
  if (schemaSha256 === fixture.schemaSha256) return schemaSha256;
  const objects = database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  const normalized = objects.map((object) => {
    const expected = fixture.objects.find((entry) => entry.type === object.type && entry.name === object.name);
    if (object.type !== 'table' || typeof object.sql !== 'string' || !expected?.sql) return object;
    // Native migrations reorder these known foreign-key and unique clauses; all other SQL must still match.
    const separator = ',CONSTRAINT ';
    const [columns, ...constraints] = expected.sql.slice(0, -1).split(separator);
    if (
      constraints.length === 0 ||
      constraints.some((clause) => !clause.startsWith('`fk_') && !clause.startsWith('`uni_'))
    )
      return object;
    const prefix = columns + separator;
    if (!object.sql.startsWith(prefix) || !object.sql.endsWith(')')) return object;
    const actualConstraints = object.sql.slice(prefix.length, -1).split(separator);
    return JSON.stringify(actualConstraints.toSorted()) === JSON.stringify(constraints.toSorted())
      ? { ...object, sql: expected.sql }
      : object;
  });
  const actual = {
    applicationId: database.prepare('PRAGMA application_id').get(),
    userVersion: database.prepare('PRAGMA user_version').get(),
    objects: normalized,
  };
  const expected = { applicationId: fixture.applicationId, userVersion: fixture.userVersion, objects: fixture.objects };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new PhotoviewReadError('PHOTOVIEW_SCHEMA_UNQUALIFIED');
  return schemaSha256;
};

/** Source identity, stopped-writer evidence, ownership and original bytes remain caller obligations. */
export const openPhotoviewSnapshot = (path: string, version: string) => {
  if (version !== fixture.source.version) throw new PhotoviewReadError('PHOTOVIEW_VERSION_UNQUALIFIED');
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    throw new PhotoviewReadError('PHOTOVIEW_SNAPSHOT_UNAVAILABLE');
  }
  let schemaSha256: string;
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    schemaSha256 = qualifiedSchema(database);
    if (database.prepare('PRAGMA foreign_key_check').get())
      throw new PhotoviewReadError('PHOTOVIEW_RELATIONSHIPS_INVALID');
  } catch (error) {
    database.close();
    if (error instanceof PhotoviewReadError) throw error;
    throw new PhotoviewReadError('PHOTOVIEW_SNAPSHOT_UNAVAILABLE');
  }
  return {
    version,
    schemaSha256,
    password: (context: ImportedPasswordContext) =>
      readSqlitePassword(database, context, 'bcrypt', 'SELECT password FROM users WHERE id=?'),
    *rows(table: PhotoviewTable): Generator<PhotoviewRow[]> {
      if (!Object.hasOwn(projections, table)) throw new PhotoviewReadError('PHOTOVIEW_TABLE_NOT_ALLOWED');
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
        throw new PhotoviewReadError('PHOTOVIEW_SNAPSHOT_READ_FAILED');
      }
    },
    close: () => database.close(),
  };
};

export { readPhotoviewManifest } from 'src/library-import/photoview-manifest.js';
