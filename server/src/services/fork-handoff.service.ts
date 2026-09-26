import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DatabaseLock } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { OfficialHandoffCheckpoint, ReconciliationReport } from 'src/repositories/fork-handoff.repository.js';
import { DB } from 'src/schema/index.js';
import { ForkSchemaMigrationService } from 'src/services/fork-schema-migration.service.js';

export type ForkHandoffHooks = {
  beforeActivate?: (transaction: Kysely<DB>) => Promise<void> | void;
};

@Injectable()
export class ForkHandoffService {
  constructor(
    private readonly databaseRepository: DatabaseRepository,
    private readonly migrationService: ForkSchemaMigrationService,
  ) {}

  async prepareOfficial(): Promise<OfficialHandoffCheckpoint> {
    return this.databaseRepository.prepareOfficialHandoffCheckpoint();
  }

  async prepareFork(options: { batchSize: number }, hooks: ForkHandoffHooks = {}): Promise<ReconciliationReport> {
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize <= 0) {
      throw new Error('Batch size must be a positive integer');
    }

    await this.databaseRepository.getReturnEvidence();
    // The certified official provider excludes the post-certified upstream
    // residue, so re-apply it before any fork-side reconciliation writes.
    await this.databaseRepository.reapplyPostCertifiedResidue();
    // FL-180: Frameleaf public migrations released after this library's cutover never ran on it (the
    // official ledger no longer lists Frameleaf names). They are applied here, after the residue they
    // may build on and before the workflow snapshot and every reconciliation read or write, and are
    // recorded in `immich_fork.migration_audit`, never in the official ledger.
    await this.databaseRepository.withLock(DatabaseLock.Migrations, () =>
      this.databaseRepository.applyIsolatedFrameleafMigrations('return'),
    );
    const workflowSnapshot = await this.databaseRepository.getReturnWorkflowSnapshot();
    const orphanArchive = await this.databaseRepository.archiveAndDeleteOrphans();
    await this.migrationService.reconcileAfterOfficialReturn(options.batchSize);
    return this.databaseRepository.withLock(DatabaseLock.Migrations, () =>
      this.databaseRepository.activateAfterReturnReconciliation(workflowSnapshot, orphanArchive, hooks.beforeActivate),
    );
  }
}
