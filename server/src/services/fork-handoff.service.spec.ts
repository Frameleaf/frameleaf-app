import { DatabaseLock } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { sharedLinkPasswordProblem } from 'src/repositories/fork-handoff.repository.js';
import { ForkHandoffService } from 'src/services/fork-handoff.service.js';
import { ForkSchemaMigrationService } from 'src/services/fork-schema-migration.service.js';

const checkpoint = {
  completedAt: '2026-07-16T12:00:00.000Z',
  databaseBackupId: 'backup-1',
  id: 'checkpoint-1',
  mediaSnapshotId: 'snapshot-1',
  officialImage: 'ghcr.io/immich-app/immich-server:v3.1.0' as const,
  reportDigest: 'a'.repeat(64),
  storageVerificationAssetCount: 0,
  storageVerificationDigest: 'b'.repeat(64),
  storageVerificationRunId: 'run-1',
};

const returnEvidence = {
  active: false,
  appliedCheckpointId: 'checkpoint-1',
  maintenanceMode: true,
  officialLedgerDigest: 'c'.repeat(64),
  phase: 'inactive' as const,
  reconciliationStatus: 'not-started' as const,
  schemaVersion: '2',
  supportedTag: 'v3.1.0' as const,
};

const activeReport = {
  ...returnEvidence,
  active: true,
  orphanArchive: { archived: 0, deleted: 0 },
  phase: 'active' as const,
  reconciliationStatus: 'complete' as const,
  verified: true as const,
  progress: [],
};

const setup = () => {
  const databaseMocks = {
    activateAfterReturnReconciliation: vi.fn().mockResolvedValue(activeReport),
    applyIsolatedFrameleafMigrations: vi.fn().mockResolvedValue({ applied: [], pending: [], skipped: null }),
    archiveAndDeleteOrphans: vi.fn().mockResolvedValue({ archived: 0, deleted: 0 }),
    countPasswordProtectedSharedLinks: vi.fn().mockResolvedValue({ hashed: 0, plaintext: 0 }),
    getPreparedOfficialHandoffCheckpoint: vi.fn().mockResolvedValue(checkpoint),
    prepareOfficialHandoffCheckpoint: vi.fn().mockResolvedValue(checkpoint),
    getReturnEvidence: vi.fn().mockResolvedValue(returnEvidence),
    getReturnWorkflowSnapshot: vi.fn().mockResolvedValue({ rowDigests: [], schemaDigest: 'd'.repeat(64) }),
    reapplyPostCertifiedResidue: vi.fn().mockResolvedValue([]),
    sealEmptyReturnBackfillDigests: vi.fn(),
    withLock: vi.fn().mockImplementation((_lock, callback) => callback()),
  };
  const migrationMocks = {
    reconcileAfterOfficialReturn: vi.fn().mockResolvedValue({ ...returnEvidence, progress: [], verified: true }),
  };
  const database = databaseMocks as unknown as DatabaseRepository;
  const migration = migrationMocks as unknown as ForkSchemaMigrationService;
  return { database, databaseMocks, migration, migrationMocks, sut: new ForkHandoffService(database, migration) };
};

describe(ForkHandoffService.name, () => {
  it('prepares the exact official image from read-only certified evidence', async () => {
    const { databaseMocks, migrationMocks, sut } = setup();

    await expect(sut.prepareOfficial()).resolves.toEqual(checkpoint);

    expect(databaseMocks.prepareOfficialHandoffCheckpoint).toHaveBeenCalledOnce();
    expect(databaseMocks.getReturnEvidence).not.toHaveBeenCalled();
    expect(databaseMocks.getPreparedOfficialHandoffCheckpoint).not.toHaveBeenCalled();
    expect(databaseMocks.archiveAndDeleteOrphans).not.toHaveBeenCalled();
    expect(migrationMocks.reconcileAfterOfficialReturn).not.toHaveBeenCalled();
  });

  it('refuses the preflight while hashed shared-link passwords are not acknowledged (FL-161)', async () => {
    const { databaseMocks, sut } = setup();
    databaseMocks.countPasswordProtectedSharedLinks.mockResolvedValue({ hashed: 3, plaintext: 1 });

    const preflight = sut.sharedLinkPasswordPreflight();
    await expect(preflight).rejects.toThrow(
      '3 password-protected shared link(s) will stay locked on the official server',
    );
    await expect(preflight).rejects.toThrow('1 other link(s) still hold a password the official server can check');

    await expect(sut.sharedLinkPasswordPreflight({ acknowledgeSharedLinkPasswords: true })).resolves.toEqual({
      hashed: 3,
      plaintext: 1,
    });
  });

  it('needs no acknowledgement for links whose passwords the official server can still check (FL-161)', async () => {
    const { databaseMocks, sut } = setup();
    databaseMocks.countPasswordProtectedSharedLinks.mockResolvedValue({ hashed: 0, plaintext: 2 });

    await expect(sut.sharedLinkPasswordPreflight()).resolves.toEqual({ hashed: 0, plaintext: 2 });
  });

  it('passes the acknowledgement to the checkpoint transaction, which counts again (FL-161)', async () => {
    const { databaseMocks, sut } = setup();

    await expect(sut.prepareOfficial()).resolves.toEqual(checkpoint);
    expect(databaseMocks.prepareOfficialHandoffCheckpoint).toHaveBeenCalledWith({
      acknowledgeSharedLinkPasswords: false,
    });
    await sut.prepareOfficial({ acknowledgeSharedLinkPasswords: true });
    expect(databaseMocks.prepareOfficialHandoffCheckpoint).toHaveBeenLastCalledWith({
      acknowledgeSharedLinkPasswords: true,
    });
  });

  it('words the refusal by what stays locked (FL-161)', () => {
    expect(sharedLinkPasswordProblem({ hashed: 0, plaintext: 4 }, false)).toBeNull();
    expect(sharedLinkPasswordProblem({ hashed: 2, plaintext: 0 }, true)).toBeNull();
    const problem = sharedLinkPasswordProblem({ hashed: 2, plaintext: 0 }, false);
    expect(problem).toContain('2 password-protected shared link(s) will stay locked');
    expect(problem).not.toContain('other link(s)');
  });

  it('validates return evidence before archiving, reconciliation, and final activation', async () => {
    const { databaseMocks, migrationMocks, sut } = setup();

    await expect(sut.prepareFork({ batchSize: 7 })).resolves.toEqual(activeReport);

    expect(databaseMocks.withLock).toHaveBeenCalledWith(DatabaseLock.Migrations, expect.any(Function));
    expect(migrationMocks.reconcileAfterOfficialReturn).toHaveBeenCalledWith(7);
    expect(databaseMocks.sealEmptyReturnBackfillDigests).not.toHaveBeenCalled();
    expect(databaseMocks.activateAfterReturnReconciliation).toHaveBeenCalledWith(
      { rowDigests: [], schemaDigest: 'd'.repeat(64) },
      { archived: 0, deleted: 0 },
      undefined,
    );
    expect(databaseMocks.getReturnEvidence.mock.invocationCallOrder[0]).toBeLessThan(
      databaseMocks.archiveAndDeleteOrphans.mock.invocationCallOrder[0],
    );
    expect(databaseMocks.reapplyPostCertifiedResidue).toHaveBeenCalledOnce();
    expect(databaseMocks.reapplyPostCertifiedResidue.mock.invocationCallOrder[0]).toBeLessThan(
      databaseMocks.archiveAndDeleteOrphans.mock.invocationCallOrder[0],
    );
  });

  it('applies newer Frameleaf migrations under the migrations lock after the residue and before any reconciliation (FL-180)', async () => {
    const { databaseMocks, migrationMocks, sut } = setup();
    let locked = false;
    databaseMocks.withLock.mockImplementation(async (_lock, callback: () => Promise<unknown>) => {
      locked = true;
      try {
        return await callback();
      } finally {
        locked = false;
      }
    });
    databaseMocks.applyIsolatedFrameleafMigrations.mockImplementation(() => {
      expect(locked).toBe(true);
      return Promise.resolve({ applied: ['2100000000610-AddClassificationRule'], pending: [], skipped: null });
    });

    await expect(sut.prepareFork({ batchSize: 1 })).resolves.toEqual(activeReport);

    expect(databaseMocks.applyIsolatedFrameleafMigrations).toHaveBeenCalledExactlyOnceWith('return');
    expect(databaseMocks.withLock).toHaveBeenNthCalledWith(1, DatabaseLock.Migrations, expect.any(Function));
    const applied = databaseMocks.applyIsolatedFrameleafMigrations.mock.invocationCallOrder[0];
    expect(databaseMocks.reapplyPostCertifiedResidue.mock.invocationCallOrder[0]).toBeLessThan(applied);
    expect(applied).toBeLessThan(databaseMocks.getReturnWorkflowSnapshot.mock.invocationCallOrder[0]);
    expect(applied).toBeLessThan(databaseMocks.archiveAndDeleteOrphans.mock.invocationCallOrder[0]);
    expect(applied).toBeLessThan(migrationMocks.reconcileAfterOfficialReturn.mock.invocationCallOrder[0]);
  });

  it('stops the return before any reconciliation when a Frameleaf migration fails (FL-180)', async () => {
    const { databaseMocks, migrationMocks, sut } = setup();
    databaseMocks.applyIsolatedFrameleafMigrations.mockRejectedValue(
      new Error('synthetic Frameleaf migration failure'),
    );

    await expect(sut.prepareFork({ batchSize: 1 })).rejects.toThrow('synthetic Frameleaf migration failure');

    expect(databaseMocks.getReturnWorkflowSnapshot).not.toHaveBeenCalled();
    expect(databaseMocks.archiveAndDeleteOrphans).not.toHaveBeenCalled();
    expect(migrationMocks.reconcileAfterOfficialReturn).not.toHaveBeenCalled();
    expect(databaseMocks.activateAfterReturnReconciliation).not.toHaveBeenCalled();
  });

  it('fails an unsupported ledger before any reconciliation provider runs', async () => {
    const { databaseMocks, migrationMocks, sut } = setup();
    databaseMocks.getReturnEvidence.mockRejectedValue(new Error('exact certified v3.1.0 ledger'));

    await expect(sut.prepareFork({ batchSize: 1 })).rejects.toThrow('exact certified v3.1.0 ledger');

    expect(databaseMocks.archiveAndDeleteOrphans).not.toHaveBeenCalled();
    expect(migrationMocks.reconcileAfterOfficialReturn).not.toHaveBeenCalled();
    expect(databaseMocks.withLock).not.toHaveBeenCalled();
    expect(databaseMocks.applyIsolatedFrameleafMigrations).not.toHaveBeenCalled();
  });
});
