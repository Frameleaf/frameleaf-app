import { z } from 'zod';
import { Refusal } from './contracts.js';
import type { Store } from './store.js';
import {
  importHash as hash,
  importTransferSchema as transferSchema,
  importPlanSha256,
  parseImportPlan,
  importVerificationSchema,
  type ImportPlan,
  type ImportTransfer,
  type ImportVerification,
} from './import-plan.js';
export type { ImportTransfer } from './import-plan.js';

const decimal = z.string().regex(/^(0|[1-9]\d*)$/);
const bindingSchema = z.strictObject({
  manifestSha256: hash,
  planSha256: hash,
});
type State =
  'intent' | 'verified' | 'rollback-intent' | 'rolled-back' | 'cancelled';
type TransferRow = { file_id: string; value: string; state: State };

/** Durable receipts only: the transfer worker must verify mounted roots, fencing and actual filesystem effects. */
export class ImportTransferJournal {
  private planned?: { operationId: string; files: Map<string, string> };
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS library_import_runs (
      operation_id TEXT PRIMARY KEY REFERENCES operations(id), binding TEXT NOT NULL,
      writers_starting INTEGER NOT NULL DEFAULT 0, abandoned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS library_import_transfers (
      operation_id TEXT NOT NULL REFERENCES library_import_runs(operation_id), file_id TEXT NOT NULL,
      value TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('intent','verified','rollback-intent','rolled-back','cancelled')),
      destination_root TEXT NOT NULL, destination_path TEXT NOT NULL,
      PRIMARY KEY(operation_id,file_id), UNIQUE(operation_id,destination_root,destination_path));
      CREATE TABLE IF NOT EXISTS library_import_review (
      operation_id TEXT PRIMARY KEY REFERENCES library_import_runs(operation_id),
      plan TEXT NOT NULL, verification TEXT);`);
  }
  private atomic<T>(operationId: string, body: () => T): T {
    let began = false;
    try {
      this.store.db.exec('BEGIN IMMEDIATE');
      began = true;
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
      if (began) {
        try {
          this.store.db.exec('ROLLBACK');
        } catch {
          // SQLite may already have rolled back; retain the original safe failure.
        }
      }
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
  sealPlan(operationId: string, input: unknown): void {
    const plan = parseImportPlan(input);
    const value = JSON.stringify(plan);
    this.atomic(operationId, () => {
      this.run(operationId, true);
      const row = this.store.db
        .prepare('SELECT binding FROM library_import_runs WHERE operation_id=?')
        .get(operationId)!;
      if (JSON.parse(String(row.binding)).planSha256 !== importPlanSha256(plan))
        throw new Refusal('import_plan_changed');
      const planned = new Map(
        plan.files.map((file) => [file.id, JSON.stringify(file)]),
      );
      for (const { file } of this.files(operationId))
        this.assertPlannedFile(planned, file);
      this.store.db
        .prepare(
          'INSERT OR IGNORE INTO library_import_review(operation_id,plan) VALUES(?,?)',
        )
        .run(operationId, value);
      const reviewed = this.store.db
        .prepare('SELECT plan FROM library_import_review WHERE operation_id=?')
        .get(operationId)!;
      if (reviewed.plan !== value) throw new Refusal('import_plan_changed');
    });
  }
  private assertPlannedFile(
    planned: Map<string, string>,
    file: ImportTransfer,
  ): void {
    if (planned.get(file.id) !== JSON.stringify(file))
      throw new Refusal('import_transfer_not_planned');
  }
  private plannedFiles(operationId: string): Map<string, string> | null {
    if (this.planned?.operationId === operationId) return this.planned.files;
    const { plan } = this.review(operationId);
    if (!plan) return null;
    // Sealed plans are immutable; retain only the active operation's lookup, never a negative result.
    this.planned = {
      operationId,
      files: new Map(plan.files.map((file) => [file.id, JSON.stringify(file)])),
    };
    return this.planned.files;
  }
  private assertCompleteTransfers(operationId: string, plan: ImportPlan): void {
    const files = this.files(operationId);
    if (
      files.length !== plan.files.length ||
      files.some((entry) => entry.state !== 'verified')
    )
      throw new Refusal('import_transfers_unverified');
    const planned = new Map(
      plan.files.map((file) => [file.id, JSON.stringify(file)]),
    );
    for (const { file } of files) this.assertPlannedFile(planned, file);
  }
  recordVerification(operationId: string, input: unknown): void {
    const parsed = importVerificationSchema.safeParse(input);
    if (!parsed.success) throw new Refusal('import_reconciliation_failed');
    const verification = parsed.data;
    if (
      ['records', 'relationships', 'permissions'].some((key) => {
        const receipt = verification[key as 'records'];
        return receipt.expectedSha256 !== receipt.actualSha256;
      })
    )
      throw new Refusal('import_reconciliation_failed');
    this.atomic(operationId, () => {
      this.run(operationId, true);
      const { plan, verification: previous } = this.review(operationId);
      if (!plan) throw new Refusal('import_plan_not_sealed');
      this.assertCompleteTransfers(operationId, plan);
      const row = this.store.db
        .prepare('SELECT binding FROM library_import_runs WHERE operation_id=?')
        .get(operationId)!;
      const binding = bindingSchema.parse(JSON.parse(String(row.binding)));
      if (
        binding.manifestSha256 !== verification.manifestSha256 ||
        binding.planSha256 !== verification.planSha256
      )
        throw new Refusal('import_reconciliation_failed');
      const value = JSON.stringify(verification);
      if (previous && JSON.stringify(previous) !== value)
        throw new Refusal('import_reconciliation_changed');
      this.store.db
        .prepare(
          'UPDATE library_import_review SET verification=? WHERE operation_id=?',
        )
        .run(value, operationId);
    });
  }
  review(operationId: string): {
    plan: ImportPlan | null;
    verification: ImportVerification | null;
  } {
    try {
      const row = this.store.db
        .prepare(
          'SELECT plan,verification FROM library_import_review WHERE operation_id=?',
        )
        .get(operationId);
      return {
        plan: row ? parseImportPlan(JSON.parse(String(row.plan))) : null,
        verification: row?.verification
          ? importVerificationSchema.parse(JSON.parse(String(row.verification)))
          : null,
      };
    } catch {
      throw new Refusal('import_journal_unavailable');
    }
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
      const planned = this.plannedFiles(operationId);
      if (planned) this.assertPlannedFile(planned, file);
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
      const { plan, verification } = this.review(operationId);
      if (!plan) throw new Refusal('import_plan_not_sealed');
      this.assertCompleteTransfers(operationId, plan);
      if (!verification) throw new Refusal('import_reconciliation_missing');
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
