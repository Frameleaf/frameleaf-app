import {
  ForkSchemaAdoptCommand,
  ForkSchemaStartCommand,
  ForkSchemaVerifyCommand,
  formatForkSchemaAdoption,
  formatForkSchemaStatus,
} from 'src/commands/fork-schema.command.js';
import { DatabaseLock, JobName, JobStatus } from 'src/enum.js';
import { BACKFILL_KINDS, BackfillKind, BackfillProgress } from 'src/repositories/fork-schema.repository.js';
import { BackfillBatchHandler, ForkSchemaMigrationService } from 'src/services/fork-schema-migration.service.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const state = (phase: 'legacy' | 'dual-write' | 'ready' | 'inactive' = 'legacy') => ({
  active: false,
  phase,
  schemaVersion: '2',
  upstreamVersion: '3.0.3',
});

describe('fork-schema command', () => {
  const completeStatus = {
    ...state('dual-write'),
    verified: true,
    progress: BACKFILL_KINDS.map((kind) => progress(kind, { remaining: 0, digest: 'e'.repeat(64) })),
  };

  it('prints phase and per-kind progress details', () => {
    const output = formatForkSchemaStatus(completeStatus);

    expect(output).toContain('Phase: dual-write');
    expect(output).toContain('privacy: processed=0 remaining=0');
    expect(output).toContain(`digest=${'e'.repeat(64)}`);
    expect(output).toContain('lastError=none');
  });

  it('requires explicit confirmation before start', async () => {
    const migration = { start: vi.fn() } as unknown as ForkSchemaMigrationService;
    const inquirer = { ask: vi.fn().mockResolvedValue({ confirmed: false }) };
    const command = new ForkSchemaStartCommand(migration, inquirer as never);

    await command.run();

    expect(inquirer.ask).toHaveBeenCalledOnce();
    expect(migration.start).not.toHaveBeenCalled();
  });

  it('prints the status when start finds the backfill already started or finished (FL-289)', async () => {
    const migration = { start: vi.fn().mockResolvedValue({ ...completeStatus, phase: 'ready' }) };
    const inquirer = { ask: vi.fn().mockResolvedValue({ confirmed: true }) };
    const command = new ForkSchemaStartCommand(migration as unknown as ForkSchemaMigrationService, inquirer as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(command.run([], {})).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Phase: ready'));
    } finally {
      log.mockRestore();
    }
  });

  it('requires explicit confirmation before adopting a library', async () => {
    const migration = { adopt: vi.fn() } as unknown as ForkSchemaMigrationService;
    const inquirer = { ask: vi.fn().mockResolvedValue({ confirmed: false }) };
    const command = new ForkSchemaAdoptCommand(migration, inquirer as never);

    await command.run();

    expect(inquirer.ask).toHaveBeenCalledWith('confirm-fork-schema-adopt', {});
    expect(migration.adopt).not.toHaveBeenCalled();
  });

  it('reports what adoption applied, or that it had already happened', () => {
    const adopted = formatForkSchemaAdoption({
      ...completeStatus,
      phase: 'legacy',
      adoption: { adopted: true, applied: ['1787148183729-ClusterGroups', '2100000000570-AddWorkflowDefinitions'] },
    });
    const repeated = formatForkSchemaAdoption({
      ...completeStatus,
      phase: 'legacy',
      adoption: { adopted: false, applied: [] },
    });

    expect(adopted).toContain('Adopted: yes (2 migrations applied)');
    expect(adopted).toContain('Phase: legacy');
    expect(repeated).toContain('Adopted: already (nothing changed)');
  });

  it('keeps the verify command read-only', async () => {
    const migration = { verify: vi.fn().mockResolvedValue(completeStatus) } as unknown as ForkSchemaMigrationService;
    const command = new ForkSchemaVerifyCommand(migration);

    await command.run();

    expect(migration.verify).toHaveBeenCalledOnce();
    expect('start' in migration).toBe(false);
    expect('pause' in migration).toBe(false);
    expect('resume' in migration).toBe(false);
  });
});

const progress = (kind: BackfillKind, overrides: Partial<BackfillProgress> = {}): BackfillProgress => ({
  kind,
  cursor: null,
  processed: 0,
  remaining: 10,
  digest: null,
  lastError: null,
  ...overrides,
});

const deferred = <T>() => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, reject, resolve };
};

describe(ForkSchemaMigrationService.name, () => {
  let service: ForkSchemaMigrationService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut: service, mocks } = newTestService(ForkSchemaMigrationService));
    mocks.forkSchema.getState.mockResolvedValue(state());
    mocks.forkSchema.getProgress.mockResolvedValue([]);
  });

  it('delegates inactive-to-active authority to return reconciliation only', async () => {
    mocks.forkSchema.getState.mockResolvedValue({ ...state(), active: true, phase: 'active' });

    const status = await service.activateAfterReturnReconciliation();

    expect(mocks.forkSchema.activateAfterReturnReconciliation).toHaveBeenCalledOnce();
    expect(status).toMatchObject({ active: true, phase: 'active' });
  });

  it('adopts an official-origin library under the migrations lock and reports the new phase', async () => {
    const adoption = { adopted: true, applied: ['1787148183729-ClusterGroups'] };
    mocks.database.adoptOfficialOrigin.mockResolvedValue(adoption);
    mocks.forkSchema.getState.mockResolvedValue({ ...state('legacy'), schemaVersion: '1' });

    const status = await service.adopt();

    expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.Migrations, expect.any(Function));
    expect(mocks.database.adoptOfficialOrigin).toHaveBeenCalledOnce();
    expect(status).toMatchObject({ adoption, phase: 'legacy', schemaVersion: '1' });
  });

  it('surfaces an adoption refusal without changing the backfill', async () => {
    mocks.database.adoptOfficialOrigin.mockRejectedValue(new Error('Library already holds Frameleaf tables'));

    await expect(service.adopt()).rejects.toThrow('Library already holds Frameleaf tables');
    expect(mocks.forkSchema.transitionPhase).not.toHaveBeenCalled();
    expect(mocks.job.queueAll).not.toHaveBeenCalled();
  });

  it('does not start an inactive library', async () => {
    mocks.forkSchema.getState.mockResolvedValue(state('inactive'));

    await expect(service.start()).rejects.toThrow('Backfill can only start from legacy phase');
  });

  it.each(['ready', 'active'] as const)(
    'reports the status of a library whose backfill already finished (%s) instead of failing start (FL-289)',
    async (phase) => {
      mocks.forkSchema.transitionPhase.mockResolvedValue(false);
      mocks.forkSchema.getState.mockResolvedValue({ ...state(), phase });

      await expect(service.start(250)).resolves.toMatchObject({ phase });

      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    },
  );

  it.each(['ready', 'active'] as const)(
    'reports the status of a finished (%s) backfill instead of failing resume (FL-289)',
    async (phase) => {
      mocks.forkSchema.transitionPhase.mockResolvedValue(false);
      mocks.forkSchema.getState.mockResolvedValue({ ...state(), phase });

      await expect(service.resume(250)).resolves.toMatchObject({ phase });

      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    },
  );

  it('still refuses to resume an inactive library', async () => {
    mocks.forkSchema.transitionPhase.mockResolvedValue(false);
    mocks.forkSchema.getState.mockResolvedValue(state('inactive'));

    await expect(service.resume(250)).rejects.toThrow('Backfill can only resume from legacy phase');
  });

  describe('automatic start at API bootstrap (FL-289)', () => {
    const seeds = (batchSize: number) =>
      BACKFILL_KINDS.map((kind) => ({ name: JobName.ForkSchemaBackfill, data: { kind, batchSize } }));

    it('starts a backfill that never started and seeds one batch per kind', async () => {
      mocks.forkSchema.beginInitialBackfill.mockResolvedValue({ outcome: 'started', phase: 'dual-write' });

      await expect(service.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.forkSchema.beginInitialBackfill).toHaveBeenCalledOnce();
      expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith(seeds(100));
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining('started automatically'));
    });

    it('respects an operator pause and does not restart it', async () => {
      mocks.forkSchema.beginInitialBackfill.mockResolvedValue({ outcome: 'paused', phase: 'legacy' });

      await expect(service.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.forkSchema.transitionPhase).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining('fork-schema resume'));
    });

    it('resumes a backfill that stopped in legacy without an operator pause', async () => {
      mocks.forkSchema.beginInitialBackfill.mockResolvedValue({ outcome: 'resumed', phase: 'dual-write' });

      await expect(service.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith(seeds(100));
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining('resumed automatically'));
    });

    it('re-seeds a dual-write backfill at boot, so a restart never strands it', async () => {
      mocks.forkSchema.beginInitialBackfill.mockResolvedValue({ outcome: 'not-legacy', phase: 'dual-write' });
      mocks.forkSchema.getProgress.mockResolvedValue([progress('privacy', { remaining: 5 })]);

      await expect(service.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.forkSchema.transitionPhase).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith(seeds(100));
    });

    it('leaves a failed kind for the operator and names it, its error and the retry command', async () => {
      mocks.forkSchema.beginInitialBackfill.mockResolvedValue({ outcome: 'not-legacy', phase: 'dual-write' });
      mocks.forkSchema.getProgress.mockResolvedValue([
        progress('privacy', { remaining: 5 }),
        progress('storage', { remaining: 3, lastError: 'disk full' }),
      ]);

      await expect(service.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith(
        seeds(100).filter(({ data }) => data.kind !== 'storage'),
      );
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('storage'));
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('frameleaf-admin fork-schema resume'));
    });

    it.each(['ready', 'active', 'inactive', 'failed'] as const)('leaves a %s library untouched', async (phase) => {
      mocks.forkSchema.beginInitialBackfill.mockResolvedValue({ outcome: 'not-legacy', phase });

      await expect(service.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.forkSchema.transitionPhase).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('moves the phase once when two booting API workers race', async () => {
      mocks.forkSchema.beginInitialBackfill
        .mockResolvedValueOnce({ outcome: 'started', phase: 'dual-write' })
        .mockResolvedValueOnce({ outcome: 'not-legacy', phase: 'dual-write' });
      const other = newTestService(ForkSchemaMigrationService, {
        forkSchema: mocks.forkSchema as never,
        job: mocks.job as never,
      });

      await Promise.all([service.onBootstrap(), other.sut.onBootstrap()]);

      // One worker moves the phase; the other re-seeds the same per-kind jobs, which BullMQ
      // deduplicates by kind (getForkSchemaBackfillJobOptions), so no batch runs twice.
      expect(mocks.forkSchema.beginInitialBackfill).toHaveBeenCalledTimes(2);
      expect(mocks.job.queueAll).toHaveBeenCalledTimes(2);
      expect(mocks.job.queueAll.mock.calls[0]).toEqual(mocks.job.queueAll.mock.calls[1]);
    });

    it('returns a library to never-started when seeding fails, so the next start retries', async () => {
      mocks.forkSchema.beginInitialBackfill.mockResolvedValue({ outcome: 'started', phase: 'dual-write' });
      mocks.job.queueAll.mockRejectedValue(new Error('redis unavailable'));
      mocks.forkSchema.transitionPhase.mockResolvedValue(true);

      await expect(service.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.forkSchema.transitionPhase).toHaveBeenCalledExactlyOnceWith('dual-write', 'legacy');
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('redis unavailable'));
    });

    it('never fails startup when the automatic start cannot run', async () => {
      mocks.forkSchema.beginInitialBackfill.mockRejectedValue(new Error('Fork schema state is not initialized'));

      await expect(service.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Fork schema state is not initialized'));
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });
  });

  it('starts dual-write and queues exactly one batch per kind', async () => {
    mocks.forkSchema.getState.mockResolvedValue(state());
    mocks.forkSchema.transitionPhase.mockResolvedValue(true);

    await service.start(250);

    expect(mocks.forkSchema.transitionPhase).toHaveBeenCalledWith('legacy', 'dual-write');
    expect(mocks.job.queueAll).toHaveBeenCalledOnce();
    expect(mocks.job.queueAll).toHaveBeenCalledWith(
      BACKFILL_KINDS.map((kind) => ({ name: JobName.ForkSchemaBackfill, data: { kind, batchSize: 250 } })),
    );
  });

  it('allows only one concurrent start call to seed jobs', async () => {
    mocks.forkSchema.transitionPhase.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));

    await Promise.all([service.start(250), service.start(250)]);

    expect(mocks.job.queueAll).toHaveBeenCalledOnce();
    expect(mocks.job.queueAll).toHaveBeenCalledWith(
      BACKFILL_KINDS.map((kind) => ({ name: JobName.ForkSchemaBackfill, data: { kind, batchSize: 250 } })),
    );
  });

  it('reseeds after pause overtakes start before its seed is created', async () => {
    const startStatus = deferred<ReturnType<typeof state>>();
    mocks.forkSchema.transitionPhase.mockResolvedValue(true);
    mocks.forkSchema.getState
      .mockImplementationOnce(() => startStatus.promise)
      .mockResolvedValueOnce(state('legacy'))
      .mockResolvedValue(state('dual-write'));

    const starting = service.start(250);
    await vi.waitFor(() => expect(mocks.forkSchema.getState).toHaveBeenCalledOnce());
    await service.pause();

    startStatus.resolve(state('legacy'));
    await starting;
    await service.resume(250);

    expect(mocks.job.queueAll).toHaveBeenCalledTimes(2);
  });

  it('repairs missing initial seeds after a partial queue failure', async () => {
    mocks.forkSchema.transitionPhase.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
    mocks.job.queueAll.mockRejectedValueOnce(new Error('partial queue failure')).mockResolvedValueOnce();

    await expect(service.start(250)).rejects.toThrow('partial queue failure');
    await expect(service.start(250)).resolves.toMatchObject({ phase: 'dual-write' });

    expect(mocks.job.queueAll).toHaveBeenCalledTimes(2);
    expect(mocks.job.queueAll).toHaveBeenLastCalledWith(
      BACKFILL_KINDS.map((kind) => ({ name: JobName.ForkSchemaBackfill, data: { kind, batchSize: 250 } })),
    );
  });

  it('repairs missing resume seeds after a partial queue failure', async () => {
    mocks.forkSchema.transitionPhase.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
    mocks.job.queueAll.mockRejectedValueOnce(new Error('partial queue failure')).mockResolvedValueOnce();

    await expect(service.resume(250)).rejects.toThrow('partial queue failure');
    await expect(service.resume(250)).resolves.toMatchObject({ phase: 'dual-write' });

    expect(mocks.job.queueAll).toHaveBeenCalledTimes(2);
    expect(mocks.job.queueAll).toHaveBeenLastCalledWith(
      BACKFILL_KINDS.map((kind) => ({ name: JobName.ForkSchemaBackfill, data: { kind, batchSize: 250 } })),
    );
  });

  it('records an operator pause so startup does not restart the backfill (FL-289)', async () => {
    mocks.forkSchema.transitionPhase.mockResolvedValue(false);
    mocks.forkSchema.getState.mockResolvedValue(state('legacy'));

    await service.pause();

    expect(mocks.forkSchema.recordBackfillPause).toHaveBeenCalledOnce();
  });

  it('records an operator resume so a later fallback to legacy does not read as paused (FL-289)', async () => {
    mocks.forkSchema.transitionPhase.mockResolvedValue(true);
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));

    await service.resume(250);

    expect(mocks.forkSchema.recordBackfillResume).toHaveBeenCalledOnce();
  });

  it('records an operator start from legacy as a resume (FL-289)', async () => {
    mocks.forkSchema.transitionPhase.mockResolvedValue(true);
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));

    await service.start(250);

    expect(mocks.forkSchema.recordBackfillResume).toHaveBeenCalledOnce();
  });

  it('records no pause when pause is refused (FL-289)', async () => {
    mocks.forkSchema.transitionPhase.mockResolvedValue(false);
    mocks.forkSchema.getState.mockResolvedValue(state('ready'));

    await expect(service.pause()).rejects.toThrow('Backfill can only pause from dual-write phase');

    expect(mocks.forkSchema.recordBackfillPause).not.toHaveBeenCalled();
  });

  it('pauses idempotently', async () => {
    mocks.forkSchema.transitionPhase.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.forkSchema.getState.mockResolvedValue(state('legacy'));

    await service.pause();
    await service.pause();

    expect(mocks.forkSchema.transitionPhase).toHaveBeenCalledTimes(2);
    expect(mocks.forkSchema.transitionPhase).toHaveBeenCalledWith('dual-write', 'legacy');
  });

  it('re-enters per-kind deduplication for repeated resume repair', async () => {
    mocks.forkSchema.transitionPhase.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));

    await service.resume(50);
    await service.resume(50);

    expect(mocks.forkSchema.transitionPhase).toHaveBeenCalledTimes(2);
    expect(mocks.forkSchema.transitionPhase).toHaveBeenCalledWith('legacy', 'dual-write');
    expect(mocks.job.queueAll).toHaveBeenCalledTimes(2);
  });

  it('allows only one concurrent resume call to seed jobs', async () => {
    mocks.forkSchema.transitionPhase.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));

    await Promise.all([service.resume(50), service.resume(50)]);

    expect(mocks.job.queueAll).toHaveBeenCalledOnce();
  });

  it('keeps a replacement resume seed when the pre-pause seed finishes later', async () => {
    const staleSeed = deferred<void>();
    const replacementSeed = deferred<void>();
    mocks.forkSchema.transitionPhase
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    mocks.forkSchema.getState
      .mockResolvedValueOnce(state('dual-write'))
      .mockResolvedValueOnce(state('legacy'))
      .mockResolvedValue(state('dual-write'));
    mocks.job.queueAll.mockReturnValueOnce(staleSeed.promise).mockReturnValueOnce(replacementSeed.promise);

    const staleResume = service.resume(50);
    await vi.waitFor(() => expect(mocks.job.queueAll).toHaveBeenCalledOnce());
    await service.pause();

    const replacementResume = service.resume(50);
    await vi.waitFor(() => expect(mocks.job.queueAll).toHaveBeenCalledTimes(2));
    staleSeed.resolve();
    await staleResume;

    const coalescedResume = service.resume(50);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.job.queueAll).toHaveBeenCalledTimes(2);

    replacementSeed.resolve();
    await Promise.all([replacementResume, coalescedResume]);
    expect(mocks.job.queueAll).toHaveBeenCalledTimes(2);
  });

  it('projects structured status for every backfill kind', async () => {
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
    mocks.forkSchema.getProgress.mockResolvedValue([
      progress('privacy', { processed: 4, remaining: 6, digest: 'a'.repeat(64), lastError: 'stopped' }),
    ]);

    const result = await service.status();

    expect(result.phase).toBe('dual-write');
    expect(result.verified).toBe(false);
    expect(result.progress).toHaveLength(BACKFILL_KINDS.length);
    expect(result.progress[0]).toEqual({
      kind: 'privacy',
      cursor: null,
      processed: 4,
      remaining: 6,
      digest: 'a'.repeat(64),
      lastError: 'stopped',
    });
    expect(result.progress[1]).toEqual(progress('albums', { remaining: 0 }));
  });

  it('verify is read-only', async () => {
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
    mocks.forkSchema.getProgress.mockResolvedValue(BACKFILL_KINDS.map((kind) => progress(kind, { remaining: 0 })));

    const result = await service.verify();

    expect(result.verified).toBe(true);
    expect(mocks.forkSchema.setPhase).not.toHaveBeenCalled();
    expect(mocks.forkSchema.claimBatch).not.toHaveBeenCalled();
    expect(mocks.job.queueAll).not.toHaveBeenCalled();
  });

  it('fails closed when no handler is registered', async () => {
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
    mocks.forkSchema.claimBatch.mockResolvedValue({ ids: ['asset-1'], cursor: 'claim-token' });

    await expect(service.runBatch('privacy', 100)).resolves.toBe(JobStatus.Failed);

    expect(mocks.forkSchema.failBatch).toHaveBeenCalledWith(
      'privacy',
      'claim-token',
      'No backfill handler registered for privacy',
    );
    expect(mocks.forkSchema.completeBatch).not.toHaveBeenCalled();
  });

  it('does not enqueue another batch when a claim is already held', async () => {
    mocks.forkSchema.claimBatch.mockResolvedValue(null);
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
    mocks.forkSchema.getProgress.mockResolvedValue([progress('privacy', { remaining: 10 })]);

    await expect(service.runBatch('privacy', 100)).resolves.toBe(JobStatus.Skipped);

    expect(mocks.job.queue).not.toHaveBeenCalled();
    expect(mocks.forkSchema.setPhase).not.toHaveBeenCalled();
  });

  describe('orphaned claims (FL-289)', () => {
    it('re-queues the kind for when an orphaned live claim expires', async () => {
      mocks.forkSchema.claimBatch.mockResolvedValue(null);
      mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
      mocks.forkSchema.getProgress.mockResolvedValue([progress('storage', { remaining: 156 })]);
      mocks.forkSchema.getLiveClaimDelay.mockResolvedValue(600_000);

      await expect(service.runBatch('storage', 32)).resolves.toBe(JobStatus.Skipped);

      expect(mocks.forkSchema.getLiveClaimDelay).toHaveBeenCalledWith('storage');
      expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({
        name: JobName.ForkSchemaBackfill,
        data: { kind: 'storage', batchSize: 32, delay: 605_000 },
      });
    });

    it('keeps the chain alive: the delayed job reclaims the expired claim and continues', async () => {
      const handler = vi.fn().mockResolvedValue({ count: 32, digest: 'a'.repeat(64) });
      service.registerHandler('storage', handler);
      mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
      mocks.forkSchema.getProgress.mockResolvedValue([progress('storage', { remaining: 156 })]);
      // The old process died holding the claim: the first run finds it live, the delayed run after
      // the lease expired gets it back (claimBatchForMode's claimExpired branch keeps its ids).
      mocks.forkSchema.claimBatch
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ids: ['a1', 'a2'], cursor: 'reclaimed-token' });
      mocks.forkSchema.getLiveClaimDelay.mockResolvedValueOnce(1000);

      await expect(service.runBatch('storage', 32)).resolves.toBe(JobStatus.Skipped);
      const [{ data }] = mocks.job.queue.mock.calls[0] as [{ data: { delay?: number } }];
      expect(data.delay).toBe(6000);

      await expect(service.runBatch('storage', 32)).resolves.toBe(JobStatus.Success);

      expect(handler).toHaveBeenCalledWith(['a1', 'a2']);
      expect(mocks.forkSchema.completeBatch).toHaveBeenCalledWith('storage', 'reclaimed-token', 32, 'a'.repeat(64));
      expect(mocks.job.queue).toHaveBeenLastCalledWith({
        name: JobName.ForkSchemaBackfill,
        data: { kind: 'storage', batchSize: 32 },
      });
    });

    it('does not re-queue when the claim was released or the library left dual-write', async () => {
      mocks.forkSchema.claimBatch.mockResolvedValue(null);
      mocks.forkSchema.getProgress.mockResolvedValue([progress('storage', { remaining: 156 })]);
      mocks.forkSchema.getLiveClaimDelay.mockResolvedValue(600_000);
      mocks.forkSchema.getState
        .mockResolvedValueOnce(state('dual-write'))
        .mockResolvedValue({ ...state(), phase: 'ready' });

      await expect(service.runBatch('storage', 32)).resolves.toBe(JobStatus.Skipped);

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  it('skips a queued batch after pause without claiming or recording an error', async () => {
    mocks.forkSchema.getState.mockResolvedValue(state('legacy'));

    await expect(service.runBatch('privacy', 100)).resolves.toBe(JobStatus.Skipped);

    expect(mocks.forkSchema.claimBatch).not.toHaveBeenCalled();
    expect(mocks.forkSchema.failBatch).not.toHaveBeenCalled();
    expect(mocks.forkSchema.completeBatch).not.toHaveBeenCalled();
    expect(mocks.job.queue).not.toHaveBeenCalled();
  });

  it('records a failed batch without advancing its cursor', async () => {
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
    const handler: BackfillBatchHandler = vi.fn().mockRejectedValue(new Error('sidecar write failed'));
    service.registerHandler('privacy', handler);
    mocks.forkSchema.claimBatch.mockResolvedValue({ ids: ['asset-1'], cursor: 'claim-token' });

    await expect(service.runBatch('privacy', 100)).resolves.toBe(JobStatus.Failed);

    expect(mocks.forkSchema.failBatch).toHaveBeenCalledWith('privacy', 'claim-token', 'sidecar write failed');
    expect(mocks.forkSchema.completeBatch).not.toHaveBeenCalled();
  });

  it('completes under the claim token and queues only the next batch for that kind', async () => {
    const handler: BackfillBatchHandler = vi.fn().mockResolvedValue({ count: 2, digest: 'b'.repeat(64) });
    service.registerHandler('privacy', handler);
    mocks.forkSchema.claimBatch.mockResolvedValue({ ids: ['asset-1', 'asset-2'], cursor: 'claim-token' });
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
    mocks.forkSchema.getProgress.mockResolvedValue([progress('privacy', { processed: 2, remaining: 8 })]);

    await expect(service.runBatch('privacy', 100)).resolves.toBe(JobStatus.Success);

    expect(handler).toHaveBeenCalledWith(['asset-1', 'asset-2']);
    expect(mocks.forkSchema.completeBatch).toHaveBeenCalledWith('privacy', 'claim-token', 2, 'b'.repeat(64));
    expect(mocks.forkSchema.failBatch).not.toHaveBeenCalled();
    expect(mocks.job.queue).toHaveBeenCalledOnce();
    expect(mocks.job.queue).toHaveBeenCalledWith({
      name: JobName.ForkSchemaBackfill,
      data: { kind: 'privacy', batchSize: 100 },
    });
  });

  it('does not advance when completion fails', async () => {
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
    service.registerHandler('privacy', vi.fn().mockResolvedValue({ count: 1, digest: 'c'.repeat(64) }));
    mocks.forkSchema.claimBatch.mockResolvedValue({ ids: ['asset-1'], cursor: 'claim-token' });
    mocks.forkSchema.completeBatch.mockRejectedValue(new Error('completion rejected'));

    await expect(service.runBatch('privacy', 100)).resolves.toBe(JobStatus.Failed);

    expect(mocks.forkSchema.failBatch).toHaveBeenCalledWith('privacy', 'claim-token', 'completion rejected');
    expect(mocks.job.queue).not.toHaveBeenCalled();
  });

  it('moves to ready when every kind is complete', async () => {
    service.registerHandler('privacy', vi.fn().mockResolvedValue({ count: 1, digest: 'd'.repeat(64) }));
    mocks.forkSchema.claimBatch.mockResolvedValue({ ids: ['asset-1'], cursor: 'claim-token' });
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
    mocks.forkSchema.getProgress.mockResolvedValue(BACKFILL_KINDS.map((kind) => progress(kind, { remaining: 0 })));

    await expect(service.runBatch('privacy', 100)).resolves.toBe(JobStatus.Success);

    expect(mocks.forkSchema.transitionPhase).toHaveBeenCalledWith('dual-write', 'ready');
    expect(mocks.job.queue).not.toHaveBeenCalled();
  });

  it('does not overwrite a concurrent pause when transitioning to ready', async () => {
    service.registerHandler('privacy', vi.fn().mockResolvedValue({ count: 1, digest: 'd'.repeat(64) }));
    mocks.forkSchema.getState.mockResolvedValue(state('dual-write'));
    mocks.forkSchema.claimBatch.mockResolvedValue({ ids: ['asset-1'], cursor: 'claim-token' });
    mocks.forkSchema.getProgress.mockResolvedValue(BACKFILL_KINDS.map((kind) => progress(kind, { remaining: 0 })));
    mocks.forkSchema.transitionPhase.mockResolvedValue(false);

    await expect(service.runBatch('privacy', 100)).resolves.toBe(JobStatus.Success);

    expect(mocks.forkSchema.transitionPhase).toHaveBeenCalledWith('dual-write', 'ready');
    expect(mocks.job.queue).not.toHaveBeenCalled();
  });

  describe('official return reconciliation', () => {
    beforeEach(() => {
      Object.assign(mocks.forkSchema, {
        beginOrResumeReturnReconciliation: vi.fn(),
        claimReturnBatch: vi.fn(),
      });
      mocks.forkSchema.getState.mockResolvedValue(state('inactive'));
      mocks.forkSchema.getReturnConfigReconciliation.mockResolvedValue({
        count: 2,
        digest: 'c'.repeat(64),
        source: 'database',
      });
      mocks.forkSchema.getProgress.mockResolvedValue(
        BACKFILL_KINDS.map((kind) => progress(kind, { remaining: 0, digest: 'e'.repeat(64) })),
      );
    });

    it('reuses every registered handler through inactive return claims without changing phase', async () => {
      const handlers = new Map<BackfillKind, BackfillBatchHandler>();
      for (const kind of BACKFILL_KINDS) {
        const handler = vi.fn().mockResolvedValue({ count: 1, digest: 'a'.repeat(64) });
        handlers.set(kind, handler);
        service.registerHandler(kind, handler);
      }
      mocks.forkSchema.claimReturnBatch.mockImplementation((kind) =>
        Promise.resolve(
          handlers.has(kind) && (handlers.get(kind) as ReturnType<typeof vi.fn>).mock.calls.length === 0
            ? { ids: [`${kind}-id`], cursor: `${kind}-claim` }
            : null,
        ),
      );

      const result = await service.reconcileAfterOfficialReturn(10);

      expect(mocks.forkSchema.beginOrResumeReturnReconciliation).toHaveBeenCalledOnce();
      for (const kind of BACKFILL_KINDS) {
        expect(handlers.get(kind)).toHaveBeenCalledWith(
          [`${kind}-id`],
          ...(kind === 'storage' || kind === 'checksum'
            ? [{ kind, claimToken: `${kind}-claim`, claimedIds: [`${kind}-id`] }]
            : []),
        );
        expect(mocks.forkSchema.completeBatch).toHaveBeenCalledWith(
          kind,
          `${kind}-claim`,
          1,
          expect.stringMatching(/^[0-9a-f]{64}$/),
        );
      }
      expect(result).toMatchObject({ active: false, phase: 'inactive', verified: true });
      expect(mocks.forkSchema.transitionPhase).not.toHaveBeenCalled();
      expect(mocks.forkSchema.activateAfterReturnReconciliation).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('preserves completed progress when an interruption is resumed', async () => {
      const handler = vi.fn().mockResolvedValue({ count: 1, digest: 'a'.repeat(64) });
      const afterBatch = vi
        .fn()
        .mockRejectedValueOnce(new Error('injected'))
        .mockImplementation(() => Promise.resolve());
      service.registerHandler('privacy', handler);
      mocks.forkSchema.claimReturnBatch
        .mockResolvedValueOnce({ ids: ['asset-1'], cursor: 'claim-1' })
        .mockResolvedValueOnce({ ids: ['asset-2'], cursor: 'claim-2' })
        .mockResolvedValue(null);

      await expect(service.reconcileAfterOfficialReturn(1, { afterBatch })).rejects.toThrow('injected');
      await expect(service.reconcileAfterOfficialReturn(1, { afterBatch })).resolves.toMatchObject({
        active: false,
        phase: 'inactive',
      });

      expect(mocks.forkSchema.beginOrResumeReturnReconciliation).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, ['asset-1']);
      expect(handler).toHaveBeenNthCalledWith(2, ['asset-2']);
      expect(mocks.forkSchema.completeBatch).toHaveBeenNthCalledWith(1, 'privacy', 'claim-1', 1, 'a'.repeat(64));
      expect(mocks.forkSchema.completeBatch).toHaveBeenNthCalledWith(2, 'privacy', 'claim-2', 1, 'a'.repeat(64));
      expect(mocks.forkSchema.transitionPhase).not.toHaveBeenCalled();
    });

    it('records a failed inactive batch and leaves reconciliation resumable', async () => {
      service.registerHandler('privacy', vi.fn().mockRejectedValue(new Error('sidecar write failed')));
      mocks.forkSchema.claimReturnBatch.mockResolvedValueOnce({ ids: ['asset-1'], cursor: 'claim-1' });

      await expect(service.reconcileAfterOfficialReturn(1)).rejects.toThrow('sidecar write failed');

      expect(mocks.forkSchema.failBatch).toHaveBeenCalledWith('privacy', 'claim-1', 'sidecar write failed');
      expect(mocks.forkSchema.completeBatch).not.toHaveBeenCalled();
      expect(mocks.forkSchema.transitionPhase).not.toHaveBeenCalled();
    });
  });
});
