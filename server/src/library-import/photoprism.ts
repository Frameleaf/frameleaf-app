import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import fixture from 'src/library-import/fixtures/photoprism/261029-sqlite.json' with { type: 'json' };
import { sqliteSchemaFingerprint } from 'src/library-import/sqlite.js';

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
const projections = {
  ...Object.fromEntries(contentTables.map((name) => [name, { name, columns: '*' }])),
  users: {
    name: 'auth_users',
    columns:
      'user_uid,user_name,display_name,user_email,auth_provider,auth_method,created_at,updated_at,user_role,user_scope,user_attr,super_admin,can_login,base_path,upload_path,expires_at,deleted_at',
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
export type PhotoprismTable = (typeof contentTables)[number] | 'users' | 'markers' | 'links' | 'shares';
export type PhotoprismRow = Record<string, SQLOutputValue>;

class PhotoprismReadError extends Error {
  constructor(readonly code: string) {
    super(`PhotoPrism source refused: ${code}`);
  }
}

/** Reads only an already captured, privately staged snapshot. This establishes schema compatibility, not migration qualification. */
export const openPhotoprismSnapshot = (path: string, version: string) => {
  if (version !== fixture.source.version) throw new PhotoprismReadError('PHOTOPRISM_VERSION_UNQUALIFIED');
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    throw new PhotoprismReadError('PHOTOPRISM_SNAPSHOT_UNAVAILABLE');
  }
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    if (sqliteSchemaFingerprint(database) !== fixture.schemaSha256) {
      throw new PhotoprismReadError('PHOTOPRISM_SCHEMA_UNQUALIFIED');
    }
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
    if (
      required.size > 0 ||
      versionRow?.version !== fixture.source.executableVersion ||
      versionRow.error !== '' ||
      !finished(versionRow.migrated_at)
    ) {
      throw new PhotoprismReadError('PHOTOPRISM_MIGRATIONS_INCOMPLETE');
    }
  } catch (error) {
    database.close();
    if (error instanceof PhotoprismReadError) throw error;
    throw new PhotoprismReadError('PHOTOPRISM_SNAPSHOT_UNAVAILABLE');
  }
  return {
    version,
    schemaSha256: fixture.schemaSha256,
    *rows(table: PhotoprismTable): Generator<PhotoprismRow[]> {
      if (!Object.hasOwn(projections, table)) throw new PhotoprismReadError('PHOTOPRISM_TABLE_NOT_ALLOWED');
      const { name, columns } = projections[table];
      try {
        const select = `SELECT rowid AS __frameleaf_cursor,${columns} FROM "${name}"`;
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
        throw new PhotoprismReadError('PHOTOPRISM_SNAPSHOT_READ_FAILED');
      }
    },
    close: () => database.close(),
  };
};
