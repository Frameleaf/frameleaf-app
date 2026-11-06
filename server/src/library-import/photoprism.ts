import { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';
import fixture from 'src/library-import/fixtures/photoprism/261029-sqlite.json' with { type: 'json' };
import { ImportedPasswordContext } from 'src/library-import/passwords.js';
import { readSqlitePassword } from 'src/library-import/sqlite-password.js';
import { assertSqliteTextSafe, sqliteSchemaFingerprint } from 'src/library-import/sqlite.js';

const contentTables = [
  'photos',
  'files',
  'albums',
  'photos_albums',
  'albums_users',
  'photos_users',
  'photos_labels',
  'photos_keywords',
  'labels',
  'keywords',
  'details',
  'subjects',
  'reactions',
  'cameras',
  'lenses',
  'places',
  'cells',
  'countries',
  'folders',
  'duplicates',
] as const;
export const photoprismProjections = {
  ...Object.fromEntries(contentTables.map((name) => [name, { name, columns: '*' }])),
  users: {
    name: 'auth_users',
    columns:
      'id,user_uid,user_name,display_name,user_email,auth_provider,auth_method,created_at,updated_at,user_role,user_scope,user_attr,super_admin,can_login,base_path,upload_path,expires_at,deleted_at',
  },
  'user-settings': {
    name: 'auth_users_settings',
    columns:
      'user_uid,ui_theme,ui_start_page,ui_language,ui_time_zone,maps_style,maps_animate,index_path,index_rescan,import_path,import_move,download_originals,download_media_raw,download_media_sidecar,search_list_view,search_show_titles,search_show_captions,upload_path,created_at,updated_at',
  },
  markers: {
    name: 'markers',
    columns:
      'marker_uid,file_uid,marker_type,marker_src,marker_name,marker_review,marker_invalid,subj_uid,subj_src,face_id,x,y,w,h,size,score,created_at,updated_at',
  },
  links: {
    name: 'links',
    columns:
      'link_uid,share_uid,share_slug,link_expires,link_views,max_views,comment,perm,created_by,created_at,modified_at',
  },
  shares: {
    name: 'auth_users_shares',
    columns: 'user_uid,share_uid,link_uid,expires_at,comment,perm,created_at,updated_at',
  },
} as Record<PhotoprismTable, { name: string; columns: string }>;
export type PhotoprismTable =
  (typeof contentTables)[number] | 'users' | 'user-settings' | 'markers' | 'links' | 'shares';
export type PhotoprismRow = Record<string, SQLOutputValue>;
export const photoprismTables = Object.keys(photoprismProjections) as PhotoprismTable[];

export const photoprismRelationshipChecks = [
  [
    'PHOTOPRISM_FILE_PHOTO_MISMATCH',
    'SELECT 1 FROM files f LEFT JOIN photos p ON p.photo_uid=f.photo_uid WHERE p.id IS NULL OR f.photo_id IS NULL OR f.photo_id<>p.id LIMIT 1',
  ],
  [
    'PHOTOPRISM_DETAILS_PHOTO_MISSING',
    'SELECT 1 FROM details d LEFT JOIN photos p ON p.id=d.photo_id WHERE p.id IS NULL LIMIT 1',
  ],
  [
    'PHOTOPRISM_MEMBERSHIP_ALBUM_MISSING',
    'SELECT 1 FROM photos_albums m LEFT JOIN albums a ON a.album_uid=m.album_uid WHERE a.id IS NULL LIMIT 1',
  ],
  [
    'PHOTOPRISM_ALBUM_MEMBERSHIP_INVALID',
    'SELECT 1 FROM photos_albums WHERE hidden IS NULL OR missing IS NULL OR hidden NOT IN (0,1) OR missing NOT IN (0,1) LIMIT 1',
  ],
  [
    'PHOTOPRISM_ALBUM_PHOTO_MISSING',
    'SELECT 1 FROM photos_albums m LEFT JOIN photos p ON p.photo_uid=m.photo_uid WHERE p.id IS NULL AND m.hidden=0 AND m.missing=0 LIMIT 1',
  ],
  [
    'PHOTOPRISM_PHOTO_WITHOUT_ORIGINAL',
    "SELECT 1 FROM photos p WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.photo_id=p.id AND f.photo_uid=p.photo_uid AND f.file_root='/' AND f.file_sidecar=0) LIMIT 1",
  ],
] as const;

class PhotoprismReadError extends Error {
  constructor(readonly code: string) {
    super(`PhotoPrism source refused: ${code}`);
  }
}

/**
 * Reads only an already captured, privately staged snapshot. This establishes schema compatibility, not migration
 * qualification. `bestEffort` (owner decision FL-1149) skips the version, schema-fingerprint, required-migration and
 * build pins while keeping every integrity check; `qualified` then reports whether those pins would have passed.
 */
export const openPhotoprismSnapshot = (path: string, version: string, options: { bestEffort?: boolean } = {}) => {
  const bestEffort = options.bestEffort === true;
  if (!bestEffort && version !== fixture.source.version)
    throw new PhotoprismReadError('PHOTOPRISM_VERSION_UNQUALIFIED');
  let database: DatabaseSync;
  let photoDetails: StatementSync;
  let schemaSha256: string;
  let qualified = true;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    throw new PhotoprismReadError('PHOTOPRISM_SNAPSHOT_UNAVAILABLE');
  }
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    // A pin either refuses (qualified read) or marks the read untested (best effort).
    const pin = (passed: boolean, code: string) => {
      if (passed) return;
      if (!bestEffort) throw new PhotoprismReadError(code);
      qualified = false;
    };
    schemaSha256 = sqliteSchemaFingerprint(database);
    pin(schemaSha256 === fixture.schemaSha256, 'PHOTOPRISM_SCHEMA_UNQUALIFIED');
    assertSqliteTextSafe(database, 'SELECT id,error,finished_at FROM migrations');
    assertSqliteTextSafe(database, 'SELECT version,error,migrated_at FROM versions ORDER BY id DESC LIMIT 1');
    const required = new Set(fixture.migrations.map(({ id }) => id));
    // Go's zero completion timestamp is year 0001, not a completed migration.
    const finished = (value: SQLOutputValue | undefined) =>
      typeof value === 'string' && !value.startsWith('0001-01-01') && Number.isFinite(Date.parse(value));
    for (const row of database.prepare('SELECT id,error,finished_at FROM migrations').iterate()) {
      if (typeof row.id !== 'string' || !row.id || row.error !== '' || !finished(row.finished_at)) {
        throw new PhotoprismReadError('PHOTOPRISM_MIGRATIONS_INCOMPLETE');
      }
      required.delete(row.id);
    }
    const versionRow = database
      .prepare('SELECT version,error,migrated_at FROM versions ORDER BY id DESC LIMIT 1')
      .get();
    if (!versionRow || versionRow.error !== '' || !finished(versionRow.migrated_at)) {
      throw new PhotoprismReadError('PHOTOPRISM_MIGRATIONS_INCOMPLETE');
    }
    pin(required.size === 0, 'PHOTOPRISM_MIGRATIONS_INCOMPLETE');
    pin(versionRow.version === fixture.source.executableVersion, 'PHOTOPRISM_BUILD_UNQUALIFIED');
    photoDetails = database.prepare('SELECT * FROM details WHERE photo_id=?');
    photoDetails.setReadBigInts(true);
  } catch (error) {
    database.close();
    if (error instanceof PhotoprismReadError) throw error;
    throw new PhotoprismReadError('PHOTOPRISM_SNAPSHOT_UNAVAILABLE');
  }
  return {
    version,
    schemaSha256,
    /** The schema, migrations and build match the qualified fixture (always true unless best effort). */
    qualified,
    password: (context: ImportedPasswordContext) =>
      readSqlitePassword(
        database,
        context,
        'photoprism-bcrypt',
        'SELECT p.hash AS password FROM auth_users u LEFT JOIN passwords p ON p.uid=u.user_uid WHERE u.user_uid=?',
      ),
    validateRelationships: () => {
      try {
        for (const [code, sql] of photoprismRelationshipChecks) {
          if (database.prepare(sql).get()) throw new PhotoprismReadError(code);
        }
      } catch (error) {
        if (error instanceof PhotoprismReadError) throw error;
        throw new PhotoprismReadError('PHOTOPRISM_SNAPSHOT_READ_FAILED');
      }
    },
    photoDetails: (id: bigint) => {
      try {
        assertSqliteTextSafe(database, 'SELECT * FROM details WHERE photo_id=?', [id]);
        return photoDetails.get(id);
      } catch {
        throw new PhotoprismReadError('PHOTOPRISM_SNAPSHOT_READ_FAILED');
      }
    },
    *rows(table: PhotoprismTable): Generator<PhotoprismRow[]> {
      if (!Object.hasOwn(photoprismProjections, table)) throw new PhotoprismReadError('PHOTOPRISM_TABLE_NOT_ALLOWED');
      const { name, columns } = photoprismProjections[table];
      try {
        const select = `SELECT rowid AS __frameleaf_cursor,${columns} FROM "${name}"`;
        const first = database.prepare(`${select} ORDER BY rowid LIMIT 1000`);
        first.setReadBigInts(true);
        const next = database.prepare(`${select} WHERE rowid>? ORDER BY rowid LIMIT 1000`);
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
        throw new PhotoprismReadError('PHOTOPRISM_SNAPSHOT_READ_FAILED');
      }
    },
    close: () => database.close(),
  };
};
