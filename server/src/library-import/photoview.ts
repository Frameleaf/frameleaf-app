import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import fixture from 'src/library-import/fixtures/photoview/2.4.0-sqlite.json' with { type: 'json' };
import { sqliteSchemaFingerprint } from 'src/library-import/sqlite.js';

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

/** Source identity, stopped-writer evidence, ownership and original bytes remain caller obligations. */
export const openPhotoviewSnapshot = (path: string, version: string) => {
  if (version !== fixture.source.version) throw new PhotoviewReadError('PHOTOVIEW_VERSION_UNQUALIFIED');
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    throw new PhotoviewReadError('PHOTOVIEW_SNAPSHOT_UNAVAILABLE');
  }
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    if (sqliteSchemaFingerprint(database) !== fixture.schemaSha256)
      throw new PhotoviewReadError('PHOTOVIEW_SCHEMA_UNQUALIFIED');
    if (database.prepare('PRAGMA foreign_key_check').get())
      throw new PhotoviewReadError('PHOTOVIEW_RELATIONSHIPS_INVALID');
  } catch (error) {
    database.close();
    if (error instanceof PhotoviewReadError) throw error;
    throw new PhotoviewReadError('PHOTOVIEW_SNAPSHOT_UNAVAILABLE');
  }
  return {
    version,
    schemaSha256: fixture.schemaSha256,
    *rows(table: PhotoviewTable): Generator<PhotoviewRow[]> {
      if (!Object.hasOwn(projections, table)) throw new PhotoviewReadError('PHOTOVIEW_TABLE_NOT_ALLOWED');
      try {
        const select = `SELECT rowid AS __frameleaf_cursor,${projections[table]} FROM "${table}"`;
        const first = database.prepare(`${select} ORDER BY rowid LIMIT 1000`);
        const next = database.prepare(`${select} WHERE rowid>? ORDER BY rowid LIMIT 1000`);
        first.setReadBigInts(true);
        next.setReadBigInts(true);
        let batch = first.all();
        while (batch.length > 0) {
          const cursor = batch.at(-1)!.__frameleaf_cursor;
          yield batch.map(({ __frameleaf_cursor: _cursor, ...row }) => row);
          batch = next.all(cursor);
        }
      } catch {
        throw new PhotoviewReadError('PHOTOVIEW_SNAPSHOT_READ_FAILED');
      }
    },
    close: () => database.close(),
  };
};
