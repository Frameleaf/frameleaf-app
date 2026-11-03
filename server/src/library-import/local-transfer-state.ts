import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Refusal } from '#library-import-transfer/contracts';
import { openImportRoot } from '#library-import-transfer/import-copy';
import { ImportTransferJournal } from '#library-import-transfer/import-transfer-journal';
import { assertImportExecutionLock } from 'src/library-import/execution-lock.js';

const refuse = (): never => {
  throw new Refusal('import_local_journal_unavailable');
};
const privateFile = (value: BigIntStats) =>
  value.isFile() &&
  value.nlink === 1n &&
  (value.mode & 0o777n) === 0o600n &&
  value.uid === BigInt(process.geteuid?.() ?? -1);
const phaseSchema = z.enum([
  'prepared',
  'copying',
  'verifying',
  'activating',
  'activated',
  'rolling-back',
  'abandoned',
]);
export type ImportExecutionPhase = z.infer<typeof phaseSchema>;

/** The execution lock protects this journal across complete commands, not just individual SQLite intents. */
export class LocalLibraryImportState {
  private constructor(
    readonly db: DatabaseSync,
    private root: FileHandle,
    readonly identity: { database: { device: string; inode: string }; lock: { device: string; inode: string } },
    private readOnly: boolean,
  ) {}

  static async open(directory: string, options: { create: boolean; readOnly?: boolean }) {
    if (options.create && options.readOnly) return refuse();
    const root = await openImportRoot(directory);
    let db: DatabaseSync | undefined;
    try {
      const info = await root.stat({ bigint: true });
      if ((info.mode & 0o777n) !== 0o700n || info.uid !== BigInt(process.geteuid?.() ?? -1)) return refuse();
      if (!options.readOnly) await assertImportExecutionLock(directory);
      const path = `/proc/self/fd/${root.fd}/library-import.sqlite`;
      let file: FileHandle;
      try {
        file = await open(
          path,
          (options.readOnly ? constants.O_RDONLY : constants.O_RDWR) |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK |
            (options.create ? constants.O_CREAT : 0),
          0o600,
        );
      } catch {
        return refuse();
      }
      let identity;
      try {
        const value = await file.stat({ bigint: true });
        if (!privateFile(value)) return refuse();
        identity = { device: String(value.dev), inode: String(value.ino) };
      } finally {
        await file.close();
      }
      for (const name of ['library-import.sqlite-wal', 'library-import.sqlite-shm', 'execution.lock']) {
        let file: FileHandle | undefined;
        try {
          file = await open(
            `/proc/self/fd/${root.fd}/${name}`,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          if (!privateFile(await file.stat({ bigint: true }))) return refuse();
        } catch (error) {
          if (name === 'execution.lock' || (error as NodeJS.ErrnoException).code !== 'ENOENT') return refuse();
        } finally {
          await file?.close();
        }
      }
      const lock = await open(`/proc/self/fd/${root.fd}/execution.lock`, constants.O_RDONLY | constants.O_NOFOLLOW);
      let lockIdentity;
      try {
        const value = await lock.stat({ bigint: true });
        if (!privateFile(value)) return refuse();
        lockIdentity = { device: String(value.dev), inode: String(value.ino) };
      } finally {
        await lock.close();
      }
      db = new DatabaseSync(path, { readOnly: !!options.readOnly, allowExtension: false });
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (
        version === 0 &&
        !options.readOnly &&
        db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' LIMIT 1").get() === undefined
      ) {
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
          CREATE TABLE operations(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,active INTEGER,value TEXT NOT NULL);
          CREATE UNIQUE INDEX single_operation ON operations(active) WHERE active=1;`);
        new ImportTransferJournal({ db });
        db.exec('PRAGMA user_version=1; COMMIT');
        await root.sync();
      } else if (version !== 1) return refuse();
      if (!options.readOnly) db.exec('PRAGMA synchronous=FULL');
      return new LocalLibraryImportState(db, root, { database: identity, lock: lockIdentity }, !!options.readOnly);
    } catch {
      try {
        db?.close();
      } finally {
        await root.close();
      }
      return refuse();
    }
  }

  bind(operationId: string, input: { binding: unknown; destinationId: string; destinationNonce: string }) {
    if (this.readOnly) return refuse();
    const expected = JSON.stringify(input);
    const row = this.db.prepare('SELECT id,value FROM operations LIMIT 1').get();
    if (row) {
      const value = JSON.parse(String(row.value));
      if (
        row.id !== operationId ||
        value.kind !== 'import' ||
        value.state !== 'running' ||
        JSON.stringify(value.input) !== expected
      )
        return refuse();
    } else {
      this.db
        .prepare('INSERT INTO operations VALUES(?,?,1,?)')
        .run(operationId, operationId, JSON.stringify({ kind: 'import', state: 'running', input, phase: 'prepared' }));
    }
    return new ImportTransferJournal({ db: this.db });
  }

  inspect(operationId: string) {
    const operation = this.db.prepare('SELECT value FROM operations WHERE id=?').get(operationId);
    if (!operation) return null;
    const run = this.db
      .prepare('SELECT writers_starting,abandoned FROM library_import_runs WHERE operation_id=?')
      .get(operationId);
    return {
      phase: phaseSchema.parse(JSON.parse(String(operation.value)).phase),
      writersMayHaveStarted: run?.writers_starting === 1,
      abandoned: run?.abandoned === 1,
      files: this.db
        .prepare(
          'SELECT state,count(*) AS count FROM library_import_transfers WHERE operation_id=? GROUP BY state ORDER BY state',
        )
        .all(operationId)
        .map(({ state, count }) => ({ state: String(state), count: Number(count) })),
    };
  }

  mark(operationId: string, phase: ImportExecutionPhase) {
    if (this.readOnly) return refuse();
    const row = this.db.prepare('SELECT value FROM operations WHERE id=?').get(operationId);
    if (!row) return refuse();
    const value = { ...JSON.parse(String(row.value)), phase: phaseSchema.parse(phase) };
    if (
      this.db
        .prepare('UPDATE operations SET value=? WHERE id=? AND value=?')
        .run(JSON.stringify(value), operationId, row.value).changes !== 1
    )
      return refuse();
  }

  async close() {
    try {
      this.db.close();
    } finally {
      await this.root.close();
    }
  }
}
