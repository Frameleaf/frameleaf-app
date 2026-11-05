import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import fixture from 'src/library-import/fixtures/nextcloud/35-8-10.2-sqlite.json' with { type: 'json' };
import { ImportedPasswordContext } from 'src/library-import/passwords.js';
import { readSqlitePassword } from 'src/library-import/sqlite-password.js';
import { assertSqliteTextSafe, sqliteSchemaFingerprint } from 'src/library-import/sqlite.js';

// Wildcards cover content-only tables in this exact fingerprinted app installation.
export const nextcloudProjections = {
  oc_users: 'uid,displayname,uid_lower',
  oc_groups: '*',
  oc_group_user: '*',
  oc_storages: '*',
  oc_mounts: '*',
  oc_filecache: '*',
  oc_mimetypes: '*',
  oc_photos_albums: '*',
  oc_photos_albums_files: '*',
  oc_photos_albums_collabs:
    'id,album_id,CASE WHEN collaborator_type=3 THEN NULL ELSE collaborator_id END AS collaborator_id,collaborator_type',
  oc_share:
    'id,share_type,share_with,uid_owner,uid_initiator,parent,item_type,item_source,item_target,file_source,file_target,permissions,stime,accepted,expiration,share_name,note,hide_download,label,attributes,password IS NOT NULL AS has_password,password_expiration_time',
  oc_memories: '*',
  oc_files_metadata: 'id,file_id,json,last_update',
  oc_vcategory: '*',
  oc_vcategory_to_object: '*',
  oc_systemtag: '*',
  oc_systemtag_object_mapping: '*',
  oc_systemtag_group: '*',
} as const;
export type NextcloudTable = keyof typeof nextcloudProjections;
export type NextcloudRow = Record<string, SQLOutputValue>;
class NextcloudReadError extends Error {
  constructor(readonly code: string) {
    super(`Nextcloud source refused: ${code}`);
  }
}

/** Reads a frozen snapshot; storage resolution, source identity, global permissions and original bytes require separate evidence. */
export const openNextcloudSnapshot = (path: string, version: string, options: { bestEffort?: boolean } = {}) => {
  if (version !== fixture.source.version) throw new NextcloudReadError('NEXTCLOUD_VERSION_UNQUALIFIED');
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    throw new NextcloudReadError('NEXTCLOUD_SNAPSHOT_UNAVAILABLE');
  }
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    // Best effort (owner decision FL-1149): an untested schema or app state is read through the same projections.
    if (options.bestEffort) {
      if (database.prepare('PRAGMA foreign_key_check').get())
        throw new NextcloudReadError('NEXTCLOUD_RELATIONSHIPS_INVALID');
      return snapshotReader(database, version);
    }
    if (sqliteSchemaFingerprint(database) !== fixture.schemaSha256)
      throw new NextcloudReadError('NEXTCLOUD_SCHEMA_UNQUALIFIED');
    assertSqliteTextSafe(
      database,
      "SELECT appid,configkey,configvalue FROM oc_appconfig WHERE appid IN ('photos','memories') AND configkey IN ('installed_version','enabled') ORDER BY appid,configkey",
    );
    assertSqliteTextSafe(database, 'SELECT app,version FROM oc_migrations ORDER BY app,version');
    const state = database
      .prepare(
        "SELECT appid,configkey,configvalue FROM oc_appconfig WHERE appid IN ('photos','memories') AND configkey IN ('installed_version','enabled') ORDER BY appid,configkey",
      )
      .all();
    const migrations = database.prepare('SELECT app,version FROM oc_migrations ORDER BY app,version').all();
    if (
      JSON.stringify(state) !== JSON.stringify(fixture.appState) ||
      JSON.stringify(migrations) !== JSON.stringify(fixture.migrations)
    )
      throw new NextcloudReadError('NEXTCLOUD_APPLICATION_STATE_UNQUALIFIED');
    if (database.prepare('PRAGMA foreign_key_check').get())
      throw new NextcloudReadError('NEXTCLOUD_RELATIONSHIPS_INVALID');
  } catch (error) {
    database.close();
    if (error instanceof NextcloudReadError) throw error;
    throw new NextcloudReadError('NEXTCLOUD_SNAPSHOT_UNAVAILABLE');
  }
  return snapshotReader(database, version);
};

const snapshotReader = (database: DatabaseSync, version: string) => {
  return {
    version,
    schemaSha256: fixture.schemaSha256,
    password: (context: ImportedPasswordContext) =>
      readSqlitePassword(database, context, 'nextcloud-password', 'SELECT password FROM oc_users WHERE uid=?'),
    *rows(table: NextcloudTable): Generator<NextcloudRow[]> {
      if (!Object.hasOwn(nextcloudProjections, table)) throw new NextcloudReadError('NEXTCLOUD_TABLE_NOT_ALLOWED');
      try {
        const select = `SELECT rowid AS __frameleaf_cursor,${nextcloudProjections[table]} FROM "${table}"`;
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
        throw new NextcloudReadError('NEXTCLOUD_SNAPSHOT_READ_FAILED');
      }
    },
    close: () => database.close(),
  };
};

export { readNextcloudManifest } from 'src/library-import/nextcloud-manifest.js';
