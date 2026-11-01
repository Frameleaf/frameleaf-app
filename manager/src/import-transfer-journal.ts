import { z } from 'zod';
import { Refusal } from './contracts.js';
import type { Store } from './store.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/);
const id = z.string().min(1).max(1024);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/^[a-z]:/i.test(value) &&
      [...value].every((c) => c >= ' ') &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
  );
const bindingSchema = z.strictObject({
  manifestSha256: hash,
  planSha256: hash,
});
const transferSchema = z.strictObject({
  id,
  mode: z.enum(['copy', 'adopt', 'relocate']),
  sourceRoot: id,
  sourcePath: path,
  destinationRoot: id,
  destinationPath: path,
  sha256: hash,
  bytes: decimal,
  sourceIdentity: z.strictObject({
    device: decimal,
    inode: decimal,
    bytes: decimal,
    mtimeNs: decimal,
    ctimeNs: decimal,
    links: decimal,
  }),
  destinationDevice: decimal,
});
export type ImportTransfer = z.infer<typeof transferSchema>;
type State =
  'intent' | 'verified' | 'rollback-intent' | 'rolled-back' | 'cancelled';
type TransferRow = { file_id: string; value: string; state: State };

/** Durable receipts only: the transfer worker must verify mounted roots, fencing and actual filesystem effects. */
export class ImportTransferJournal {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS library_import_runs (
      operation_id TEXT PRIMARY KEY REFERENCES operations(id), binding TEXT NOT NULL,
      writers_starting INTEGER NOT NULL DEFAULT 0, abandoned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS library_import_transfers (
      operation_id TEXT NOT NULL REFERENCES library_import_runs(operation_id), file_id TEXT NOT NULL,
      value TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('intent','verified','rollback-intent','rolled-back','cancelled')),
      destination_root TEXT NOT NULL, destination_path TEXT NOT NULL,
      PRIMARY KEY(operation_id,file_id), UNIQUE(operation_id,destination_root,destination_path));`);
  }
  private atomic<T>(operationId: string, body: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.store.db
        .prepare('SELECT value FROM operations WHERE id=? AND active=1')
        .get(operationId);
      const operation = row ? JSON.parse(String(row.value)) : null;
      if (
        !operation ||
        operation.kind !== 'import' ||
        operation.state === 'complete'
      )
        throw new Refusal('import_operation_not_owned');
      const result = body();
      this.store.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error instanceof Refusal
        ? error
        : new Refusal('import_journal_unavailable');
    }
  }
  private run(operationId: string, rollback = false): void {
    const row = this.store.db
      .prepare(
        'SELECT abandoned,writers_starting FROM library_import_runs WHERE operation_id=?',
      )
      .get(operationId);
    if (!row) throw new Refusal('import_journal_missing');
    if (row.abandoned) throw new Refusal('import_abandoned');
    if (rollback && row.writers_starting)
      throw new Refusal('import_post_activation_recovery_required');
  }
  begin(operationId: string, binding: z.infer<typeof bindingSchema>): void {
    const parsed = bindingSchema.safeParse(binding);
    if (!parsed.success) throw new Refusal('import_plan_invalid');
    const value = JSON.stringify(parsed.data);
    this.atomic(operationId, () => {
      this.store.db
        .prepare(
          'INSERT OR IGNORE INTO library_import_runs(operation_id,binding) VALUES(?,?)',
        )
        .run(operationId, value);
      const row = this.store.db
        .prepare('SELECT binding FROM library_import_runs WHERE operation_id=?')
        .get(operationId)!;
      if (row.binding !== value) throw new Refusal('import_plan_changed');
      this.run(operationId);
    });
  }
  intent(operationId: string, input: ImportTransfer): void {
    const parsed = transferSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.bytes !== parsed.data.sourceIdentity.bytes ||
      parsed.data.sourceIdentity.links === '0'
    )
      throw new Refusal('import_transfer_invalid');
    const file = parsed.data;
    if (
      file.mode === 'relocate' &&
      file.sourceIdentity.device !== file.destinationDevice
    )
      throw new Refusal('import_relocation_cross_filesystem');
    this.atomic(operationId, () => {
      this.run(operationId, true);
      const value = JSON.stringify(file);
      const prior = this.store.db
        .prepare(
          'SELECT value,state FROM library_import_transfers WHERE operation_id=? AND file_id=?',
        )
        .get(operationId, file.id);
      if (prior) {
        if (prior.value !== value) throw new Refusal('import_transfer_changed');
        if (!['intent', 'verified'].includes(String(prior.state)))
          throw new Refusal('import_transfer_state_changed');
        return;
      }
      try {
        this.store.db
          .prepare(
            `INSERT INTO library_import_transfers VALUES(?,?,?,'intent',?,?)`,
          )
          .run(
            operationId,
            file.id,
            value,
            file.destinationRoot,
            file.destinationPath,
          );
      } catch {
        throw new Refusal('import_transfer_collision');
      }
    });
  }
  private transition(
    operationId: string,
    fileId: string,
    from: State,
    to: State,
    receipt?: { sha256: string; bytes: string },
  ): void {
    if (
      (to === 'verified' || to === 'rolled-back') &&
      !z.strictObject({ sha256: hash, bytes: decimal }).safeParse(receipt)
        .success
    )
      throw new Refusal('import_transfer_verification_failed');
    this.atomic(operationId, () => {
      this.run(operationId, true);
      const row = this.store.db
        .prepare(
          'SELECT file_id,value,state FROM library_import_transfers WHERE operation_id=? AND file_id=?',
        )
        .get(operationId, fileId) as TransferRow | undefined;
      if (!row) throw new Refusal('import_transfer_missing');
      const file = transferSchema.parse(JSON.parse(row.value));
      if (
        receipt &&
        (receipt.sha256 !== file.sha256 || receipt.bytes !== file.bytes)
      )
        throw new Refusal('import_transfer_verification_failed');
      if (row.state === to) return;
      if (row.state !== from)
        throw new Refusal('import_transfer_state_changed');
      this.store.db
        .prepare(
          'UPDATE library_import_transfers SET state=? WHERE operation_id=? AND file_id=?',
        )
        .run(to, operationId, fileId);
    });
  }
  verified(
    operationId: string,
    fileId: string,
    receipt: { sha256: string; bytes: string },
  ): void {
    this.transition(operationId, fileId, 'intent', 'verified', receipt);
  }
  rollbackIntent(operationId: string, fileId: string): void {
    this.transition(operationId, fileId, 'verified', 'rollback-intent');
  }
  cancelIntent(
    operationId: string,
    fileId: string,
    receipt: {
      sha256: string;
      bytes: string;
      sourceIdentity: ImportTransfer['sourceIdentity'];
      destinationAbsent: true;
    },
  ): void {
    const parsed = z
      .strictObject({
        sha256: hash,
        bytes: decimal,
        sourceIdentity: transferSchema.shape.sourceIdentity,
        destinationAbsent: z.literal(true),
      })
      .safeParse(receipt);
    if (!parsed.success)
      throw new Refusal('import_transfer_verification_failed');
    this.atomic(operationId, () => {
      this.run(operationId, true);
      const row = this.store.db
        .prepare(
          'SELECT value,state FROM library_import_transfers WHERE operation_id=? AND file_id=?',
        )
        .get(operationId, fileId);
      if (!row) throw new Refusal('import_transfer_missing');
      const file = transferSchema.parse(JSON.parse(String(row.value)));
      if (
        parsed.data.sha256 !== file.sha256 ||
        parsed.data.bytes !== file.bytes ||
        JSON.stringify(parsed.data.sourceIdentity) !==
          JSON.stringify(file.sourceIdentity)
      )
        throw new Refusal('import_transfer_verification_failed');
      if (row.state === 'cancelled') return;
      if (row.state !== 'intent')
        throw new Refusal('import_transfer_state_changed');
      this.store.db
        .prepare(
          "UPDATE library_import_transfers SET state='cancelled' WHERE operation_id=? AND file_id=?",
        )
        .run(operationId, fileId);
    });
  }
  rolledBack(
    operationId: string,
    fileId: string,
    receipt: { sha256: string; bytes: string },
  ): void {
    this.transition(
      operationId,
      fileId,
      'rollback-intent',
      'rolled-back',
      receipt,
    );
  }
  writersStarting(operationId: string): void {
    this.atomic(operationId, () => {
      this.run(operationId);
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM library_import_transfers WHERE operation_id=? AND state<>'verified' LIMIT 1",
          )
          .get(operationId)
      )
        throw new Refusal('import_transfers_unverified');
      this.store.db
        .prepare(
          'UPDATE library_import_runs SET writers_starting=1 WHERE operation_id=?',
        )
        .run(operationId);
    });
  }
  abandon(operationId: string): void {
    this.atomic(operationId, () => {
      const result = this.store.db
        .prepare(
          'UPDATE library_import_runs SET abandoned=1 WHERE operation_id=?',
        )
        .run(operationId);
      if (result.changes !== 1) throw new Refusal('import_journal_missing');
    });
  }
  files(operationId: string): { file: ImportTransfer; state: State }[] {
    return (
      this.store.db
        .prepare(
          'SELECT file_id,value,state FROM library_import_transfers WHERE operation_id=? ORDER BY rowid',
        )
        .all(operationId) as TransferRow[]
    ).map((row) => ({
      file: transferSchema.parse(JSON.parse(row.value)),
      state: row.state,
    }));
  }
}
