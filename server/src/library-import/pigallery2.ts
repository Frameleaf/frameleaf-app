import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import fixture from 'src/library-import/fixtures/pigallery2/3.5.2-sqlite.json' with { type: 'json' };
import { sqliteSchemaFingerprint } from 'src/library-import/sqlite.js';

const projections = {
  directory_entity: '*',
  media_entity: '*',
  file_entity: '*',
  person_entry: '*',
  person_junction_table: '*',
  album_base_entity: '*',
  user_entity: 'id,name,role,overrideAllowBlockList,allowQuery,blockQuery',
  sharing_entity: 'id,searchQuery,password IS NOT NULL AS has_password,expires,timeStamp,creatorId',
} as const;
export type Pigallery2Table = keyof typeof projections;
export type Pigallery2Row = Record<string, SQLOutputValue>;
class Pigallery2ReadError extends Error {
  constructor(readonly code: string) {
    super(`PiGallery2 source refused: ${code}`);
  }
}

/** Reads a frozen snapshot; caller separately qualifies source identity, global policy, explicit owners and original bytes. */
export const openPigallery2Snapshot = (path: string, version: string) => {
  if (version !== fixture.source.version) throw new Pigallery2ReadError('PIGALLERY2_VERSION_UNQUALIFIED');
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    throw new Pigallery2ReadError('PIGALLERY2_SNAPSHOT_UNAVAILABLE');
  }
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    if (sqliteSchemaFingerprint(database) !== fixture.schemaSha256)
      throw new Pigallery2ReadError('PIGALLERY2_SCHEMA_UNQUALIFIED');
    const statement = database.prepare('SELECT version FROM version_entity');
    statement.setReadBigInts(true);
    const versions = statement.all();
    if (versions.length !== 1 || versions[0].version !== BigInt(fixture.runtime.dataStructureVersion))
      throw new Pigallery2ReadError('PIGALLERY2_STRUCTURE_VERSION_UNQUALIFIED');
    if (database.prepare('PRAGMA foreign_key_check').get())
      throw new Pigallery2ReadError('PIGALLERY2_RELATIONSHIPS_INVALID');
  } catch (error) {
    database.close();
    if (error instanceof Pigallery2ReadError) throw error;
    throw new Pigallery2ReadError('PIGALLERY2_SNAPSHOT_UNAVAILABLE');
  }
  return {
    version,
    schemaSha256: fixture.schemaSha256,
    *rows(table: Pigallery2Table): Generator<Pigallery2Row[]> {
      if (!Object.hasOwn(projections, table)) throw new Pigallery2ReadError('PIGALLERY2_TABLE_NOT_ALLOWED');
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
        throw new Pigallery2ReadError('PIGALLERY2_SNAPSHOT_READ_FAILED');
      }
    },
    close: () => database.close(),
  };
};
