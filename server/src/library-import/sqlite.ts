import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

/** The caller fences source writers and authorizes both paths; a snapshot alone does not qualify an app schema. */
export const captureSqliteSnapshot = async (
  sourcePath: string,
  stagingRoot: string,
): Promise<{ path: string; schemaSha256: string }> => {
  let directory: string | undefined;
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true, allowExtension: false });
    try {
      source.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
      // Establish a read snapshot before backup, including committed pages still resident in the source WAL.
      source.prepare('SELECT count(*) FROM sqlite_schema').get();
      directory = await mkdtemp(join(stagingRoot, 'sqlite-import-'));
      const path = join(directory, 'snapshot.sqlite');
      // Reserve a private file before the native backup API opens it; no world-readable creation window.
      const reserved = await open(path, 'wx', 0o600);
      await reserved.close();
      await backup(source, path);
      const snapshot = new DatabaseSync(path, { readOnly: true, allowExtension: false });
      try {
        snapshot.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
        const integrity = snapshot.prepare('PRAGMA integrity_check').all();
        if (
          integrity.length !== 1 ||
          Object.values(integrity[0])[0] !== 'ok' ||
          snapshot.prepare('PRAGMA foreign_key_check').all().length > 0
        ) {
          throw new Error('Invalid SQLite snapshot');
        }
        return { path, schemaSha256: sqliteSchemaFingerprint(snapshot) };
      } finally {
        snapshot.close();
      }
    } finally {
      source.close();
    }
  } catch {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        throw new Error('SQLite snapshot refused: SQLITE_SNAPSHOT_CLEANUP_FAILED');
      }
    }
    throw new Error('SQLite snapshot refused: SQLITE_SNAPSHOT_FAILED');
  }
};

/** Schema identity only: source content and source application identity are verified separately. */
export const sqliteSchemaFingerprint = (database: DatabaseSync): string => {
  const structure = {
    applicationId: database.prepare('PRAGMA application_id').get(),
    userVersion: database.prepare('PRAGMA user_version').get(),
    objects: database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
  };
  return createHash('sha256').update(JSON.stringify(structure)).digest('hex');
};
