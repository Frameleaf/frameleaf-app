import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DatabaseLock } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import {
  OfficialHandoffCheckpoint,
  ReconciliationReport,
  SharedLinkPasswordCounts,
  sharedLinkPasswordProblem,
} from 'src/repositories/fork-handoff.repository.js';
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

  /**
   * FL-161: the handoff preflight for password-protected shared links. Passwords stored as bcrypt
   * hashes cannot be checked by the official server, so those links stay locked there (they never open
   * without a password) until each password is set again on the official server; links still holding
   * a plaintext password keep working and are only counted. The handoff goes ahead only once the
   * operator acknowledged the locked ones. `prepareOfficial` checks the same again inside the
   * checkpoint's own transaction.
   */
  async sharedLinkPasswordPreflight(
    options: { acknowledgeSharedLinkPasswords?: boolean } = {},
  ): Promise<SharedLinkPasswordCounts> {
    const counts = await this.databaseRepository.countPasswordProtectedSharedLinks();
    const problem = sharedLinkPasswordProblem(counts, options.acknowledgeSharedLinkPasswords === true);
    if (problem) {
      throw new Error(problem);
    }
    return counts;
  }

  async prepareOfficial(
    options: { acknowledgeSharedLinkPasswords?: boolean } = {},
  ): Promise<OfficialHandoffCheckpoint> {
    return this.databaseRepository.prepareOfficialHandoffCheckpoint({
      acknowledgeSharedLinkPasswords: options.acknowledgeSharedLinkPasswords === true,
    });
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
