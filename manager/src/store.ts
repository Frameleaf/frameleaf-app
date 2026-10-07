import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Refusal, type Operation, type OperationKind } from './contracts.js';

/** SQLite owns the cross-process operation lock. Every destructive call has a durable intent first. */
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly directory: string) {
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
  ): { operation: Operation; created: boolean } {
    const prior = this.request(kind, requestKey, input);
    if (prior) return { operation: prior, created: false };
    const operation: Operation = {
      id: randomUUID(),
      kind,
      state: 'running',
      step: null,
      completed: [],
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      input,
      receipts: {},
    };
    try {
      this.db
        .prepare('INSERT INTO operations VALUES (?,?,1,?)')
        .run(operation.id, requestKey, JSON.stringify(operation));
    } catch {
      throw new Refusal('operation_in_progress');
    }
    return { operation, created: true };
  }
  request(kind: OperationKind | undefined, requestKey: string, input: Record<string, unknown>): Operation | null {
    const prior = this.db.prepare('SELECT value FROM operations WHERE request_key=?').get(requestKey) as
      { value: string } | undefined;
    if (prior) {
      const operation: Operation = JSON.parse(prior.value);
      if ((kind && operation.kind !== kind) || JSON.stringify(operation.input) !== JSON.stringify(input))
        throw new Refusal('request_key_reused');
      return operation;
    }
    return null;
  }
  save(operation: Operation): void {
    operation.updatedAt = Date.now();
    // Failed/interrupted operations retain ownership: a new operation cannot race recovery.
    this.db
      .prepare('UPDATE operations SET active=?, value=? WHERE id=?')
      .run(operation.state === 'complete' ? null : 1, JSON.stringify(operation), operation.id);
  }
  history(): Operation[] {
    return (
      this.db.prepare('SELECT value FROM operations ORDER BY rowid DESC LIMIT 100').all() as { value: string }[]
    ).map((r) => JSON.parse(r.value));
  }
  close(): void {
    this.db.close();
  }
}
