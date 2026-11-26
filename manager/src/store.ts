import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Refusal, type Operation, type OperationKind } from './contracts.js';

/**
 * FL-1770: whether an operation keeps the single-operation lock. Every state but complete keeps it. With Docker, a
 * failed Start, Stop or Restart does not: its only effect is Compose bringing the stack up or down, and restore,
 * rollback and update stop the stack themselves, so keeping the lock would only refuse them (and backup) while
 * Resume keeps failing. Resume takes the lock again and is refused while another operation holds it. The native
 * runtime keeps the lock: a failed native Stop can leave the server running with no other owner to stop it.
 */
export function holdsLock(operation: Pick<Operation, 'kind' | 'state'>, releaseFailedControl = true): boolean {
  if (operation.state === 'complete') return false;
  return !(releaseFailedControl && operation.state === 'failed' && ['start', 'stop', 'restart'].includes(operation.kind));
}

/** SQLite owns the cross-process operation lock. Every destructive call has a durable intent first. */
export class Store {
  readonly db: DatabaseSync;
  private versions = new WeakMap<Operation, string>();
  private decode(value: string): Operation {
    const operation: Operation = JSON.parse(value);
    this.versions.set(operation, value);
    return operation;
  }
  constructor(
    readonly directory: string,
    /** Docker only, see holdsLock. */
    readonly options: { releaseFailedControl?: boolean } = {},
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, 'manager.sqlite'));
    chmodSync(join(directory, 'manager.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL,
        active INTEGER, value TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS single_operation ON operations(active) WHERE active=1;
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);`);
    // FL-1770: a failed Start, Stop or Restart saved by an older Manager still holds the lock; release it.
    const held = this.db.prepare('SELECT id, value FROM operations WHERE active=1').get() as
      | { id: string; value: string }
      | undefined;
    if (held && !this.holdsLock(JSON.parse(held.value) as Operation))
      this.db.prepare('UPDATE operations SET active=NULL WHERE id=? AND value=?').run(held.id, held.value);
  }
  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key=?').run(key);
  }
  /** Setting keys that start with a prefix, e.g. every `restore:` review. */
  keys(prefix: string): string[] {
    return (
      this.db.prepare("SELECT key FROM settings WHERE substr(key, 1, ?) = ? AND value <> 'null' ORDER BY key").all(prefix.length, prefix) as {
        key: string;
      }[]
    ).map((row) => row.key);
  }
  createOnce(key: string, value: unknown): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run(key, JSON.stringify(value)).changes === 1;
  }
  /** An ambiguous in-flight side effect stays locked after a restart until its receipt is reconciled. */
  interrupt(): void {
    for (const operation of this.history().filter((o) => o.state === 'running')) {
      operation.state = 'interrupted';
      operation.error = 'operation_interrupted';
      this.save(operation);
    }
  }
  start(
    kind: OperationKind,
    requestKey: string,
    input: Record<string, unknown>,
    reviewedImport?: { id: string; sha256: string },
  ): { operation: Operation; created: boolean } {
    if (
      reviewedImport &&
      (kind !== 'import' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(reviewedImport.id) ||
        !/^[a-f0-9]{64}$/u.test(reviewedImport.sha256))
    ) throw new Refusal('invalid_import_authority');
    const prior = this.request(kind, requestKey, input);
    if (prior) {
      if (reviewedImport && (prior.id !== reviewedImport.id || prior.receipts['reviewed-common-import'] !== reviewedImport.sha256))
        throw new Refusal('invalid_import_authority');
      return { operation: prior, created: false };
    }
    const operation: Operation = {
      id: reviewedImport?.id ?? randomUUID(),
      kind,
      state: 'running',
      step: null,
      completed: [],
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      input,
      receipts: reviewedImport ? { 'reviewed-common-import': reviewedImport.sha256 } : {},
    };
    const value = JSON.stringify(operation);
    try {
      this.db
        .prepare('INSERT INTO operations VALUES (?,?,1,?)')
        .run(operation.id, requestKey, value);
    } catch {
      throw new Refusal('operation_in_progress');
    }
    this.versions.set(operation, value);
    return { operation, created: true };
  }
  request(kind: OperationKind | undefined, requestKey: string, input: Record<string, unknown>): Operation | null {
    const prior = this.db.prepare('SELECT value FROM operations WHERE request_key=?').get(requestKey) as
      { value: string } | undefined;
    if (prior) {
      const operation = this.decode(prior.value);
      if ((kind && operation.kind !== kind) || JSON.stringify(operation.input) !== JSON.stringify(input))
        throw new Refusal('request_key_reused');
      return operation;
    }
    return null;
  }
  save(operation: Operation): void {
    const previous = this.versions.get(operation);
    if (previous === undefined) throw new Refusal('operation_journal_changed');
    operation.updatedAt = Date.now();
    const value = JSON.stringify(operation);
    // Failed/interrupted operations retain ownership: a new operation cannot race recovery (see holdsLock).
    let saved;
    try {
      saved = this.db
        .prepare('UPDATE operations SET active=?, value=? WHERE id=? AND value=?')
        .run(this.holdsLock(operation) ? 1 : null, value, operation.id, previous);
    } catch (error) {
      // Resuming an operation that released the lock while another operation now holds it.
      const holder = this.locked();
      if (holder && holder.id !== operation.id) throw new Refusal('operation_in_progress');
      throw error;
    }
    if (saved.changes !== 1) throw new Refusal('operation_journal_changed');
    this.versions.set(operation, value);
  }
  holdsLock(operation: Pick<Operation, 'kind' | 'state'>): boolean {
    return holdsLock(operation, !!this.options.releaseFailedControl);
  }
  /** The operation holding the single-operation lock (see holdsLock and save). */
  locked(): Operation | null {
    const row = this.db.prepare('SELECT value FROM operations WHERE active=1').get() as { value: string } | undefined;
    return row ? this.decode(row.value) : null;
  }
  history(): Operation[] {
    return (
      this.db.prepare('SELECT value FROM operations ORDER BY rowid DESC LIMIT 100').all() as { value: string }[]
    ).map((r) => this.decode(r.value));
  }
  close(): void {
    this.db.close();
  }
}
