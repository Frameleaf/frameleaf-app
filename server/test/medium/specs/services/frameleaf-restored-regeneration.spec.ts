import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { defaults, mapAdminConfig } from 'src/dtos/config.dto.js';
import { JobName, SystemMetadataKey } from 'src/enum.js';
import {
  IMPORT_DERIVED_RUN_KIND,
  IMPORT_DERIVED_RUN_STAGES,
  importDerivedRunId,
  insertRunJobs,
} from 'src/immich-import/derived-work.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { SystemConfigService } from 'src/services/system-config.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

it('releases a restored prepared import once with a real admin and effective settings, preserving lineage and terminal selections', async () => {
  const db = await getKyselyDB('fl333_restored_regeneration');
  const previous = {
    installation: process.env.FRAMELEAF_MANAGER_INSTALLATION,
    origin: process.env.FRAMELEAF_MANAGER_ORIGIN,
    imported: process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION,
  };
  const original = 'aaaabbbbcccc';
  const source = 'restored-verified-source',
    fingerprint = 'restored-verified-config';
  const id = importDerivedRunId(source, fingerprint);
  const stages = [...IMPORT_DERIVED_RUN_STAGES];
  const setup = newMediumService(SystemConfigService, {
    database: db,
    real: [SystemMetadataRepository],
    mock: [ConfigRepository, LoggingRepository],
  });
  setup.ctx.getMock(ConfigRepository).getEnv.mockReturnValue(mockEnvData({}));
  const metadata = setup.ctx.get(SystemMetadataRepository);
  const users = new UserRepository(db);
  const jobs = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
  for (const jobName of stages)
    jobs['handlers'][jobName] = {
      jobName,
      queueName: 'restore-regeneration' as never,
      handler: vi.fn(),
      label: 'synthetic',
    };
  Object.assign(jobs, {
    getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, paused: 0, failed: 0 }),
  });
  const make = () =>
    new FrameleafLibrarySetupService(
      db,
      { getAll: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
      jobs,
      users,
      {} as never,
      // Setup scans every account, including the asset-less admin made below.
      { startMissingScan: vi.fn().mockResolvedValue({ operationId: randomUUID() }) } as never,
      setup.sut,
      {} as never,
    );
  const run = async () =>
    (
      await sql<{
        selection: {
          managerSetup: {
            installation: string;
            operationId: string;
            preparedAt: string | null;
            startedAt: string | null;
          };
        };
      }>`SELECT selection FROM job_run WHERE id=${id}::uuid`.execute(db)
    ).rows[0];
  /** The run's work: one job per stage, with its state and whether it is held. */
  const work = async () =>
    (
      await sql<{ name: string; state: string; held: boolean }>`
        SELECT name,state,"availableAt"='infinity' AS held FROM job WHERE "runId"=${id}::uuid ORDER BY name`.execute(db)
    ).rows;
  const holds = async () =>
    (await sql<{ holds: unknown }>`SELECT selection->'holds' AS holds FROM job_run WHERE id=${id}::uuid`.execute(db))
      .rows[0].holds;
  try {
    process.env.FRAMELEAF_MANAGER_INSTALLATION = 'ddddeeeeffff';
    process.env.FRAMELEAF_MANAGER_ORIGIN = 'restored_library';
    process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION = original;
    await metadata.withConfigTransaction((bound) =>
      bound.set(SystemMetadataKey.SystemConfig, {
        machineLearning: { enabled: false, urls: ['http://restored-local:3003'] },
        trash: { days: 17 },
      }),
    );
    const settings = await setup.sut.getAdminConfigWithRevision();
    await sql`INSERT INTO frameleaf_immich_import(source_fingerprint,config_fingerprint,source_version,status)
      VALUES (${source},${fingerprint},'frozen-fixture','activated')`.execute(db);
    await sql`INSERT INTO job_queue(name) VALUES ('restore-regeneration')`.execute(db);
    const operationId = randomUUID();
    const prepared = Object.fromEntries(stages.map((stage) => [stage, 'setup']));
    await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone") VALUES (${id}::uuid,${IMPORT_DERIVED_RUN_KIND},
      ${JSON.stringify({ source, config: fingerprint, holds: prepared, managerSetup: { installation: original, operationId, preparedAt: null, startedAt: null } })}::text::jsonb,true)`.execute(
      db,
    );
    for (const stage of stages)
      await insertRunJobs(
        db,
        id,
        { queue: 'restore-regeneration', name: stage, data: {}, safeToRetry: true, sensitive: false, deadlineMs: 1000 },
        db.selectNoFrom(sql<string>`'retained-asset'::text`.as('id')),
      );
    // Terminal work survives the restore as it was.
    await sql`UPDATE job SET state=CASE name WHEN ${JobName.AssetGenerateThumbnails} THEN 'cancelled' ELSE 'needs_attention' END,
      "finishedAt"=now() WHERE name IN (${JobName.AssetGenerateThumbnails},${JobName.AssetDetectFaces})`.execute(db);
    await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,preparedAt}',to_jsonb(now()::text)) WHERE id=${id}::uuid`.execute(
      db,
    );
    await make().begin();
    expect((await make().status()).regeneration).toMatchObject({
      runId: id,
      state: 'pending_first_setup',
      reasons: ['account_not_ready'],
    });
    expect((await run()).selection.managerSetup.startedAt).toBeNull();
    await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,preparedAt}','null'::jsonb) WHERE id=${id}::uuid`.execute(
      db,
    );
    const { user } = await setup.ctx.newUser({ isAdmin: true });
    // Matching identity alone is insufficient: actual restored configuration must validate.
    await metadata.withConfigTransaction((bound) =>
      bound.set(SystemMetadataKey.SystemConfig, { machineLearning: { enabled: 'invalid' } } as never),
    );
    await make().begin();
    expect((await make().status()).regeneration?.reasons).toEqual(['settings_not_ready']);
    await metadata.withConfigTransaction((bound) =>
      bound.set(SystemMetadataKey.SystemConfig, {
        machineLearning: { enabled: false, urls: ['http://restored-local:3003'] },
        trash: { days: 17 },
      }),
    );
    await make().begin(); // Not prepared yet.
    expect((await run()).selection.managerSetup.startedAt).toBeNull();
    await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,preparedAt}',to_jsonb(now()::text)) WHERE id=${id}::uuid`.execute(
      db,
    );
    const captured = await work();
    expect(captured.filter((row) => row.state === 'pending').every((row) => row.held)).toBe(true);
    delete process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION;
    await make().begin();
    expect((await make().status()).regeneration).toMatchObject({
      state: 'needs_attention',
      reasons: ['import_not_prepared'],
    });
    process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION = '111122223333';
    await make().begin();
    expect((await run()).selection.managerSetup.startedAt).toBeNull();
    process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION = original;
    await sql`UPDATE frameleaf_immich_import SET status='verifying'`.execute(db);
    await make().begin();
    expect((await make().status()).regeneration?.reasons).toEqual(['import_not_activated']);
    await sql`UPDATE frameleaf_immich_import SET status='activated'`.execute(db);
    await sql`UPDATE job_run SET "enumerationDone"=false WHERE id=${id}::uuid`.execute(db);
    await make().begin();
    expect((await run()).selection.managerSetup.startedAt).toBeNull();
    await sql`UPDATE job_run SET "enumerationDone"=true WHERE id=${id}::uuid`.execute(db);
    // Reconstruction before workers preserves held memberships and original start authority.
    const safeJob = randomUUID(),
      unsafeJob = randomUUID();
    await sql`INSERT INTO job(id,queue,name,data,"safeToRetry",sensitive,"deadlineMs",state,attempt,"retryBaseAttempt",token,"leaseExpiresAt")
      VALUES (${safeJob}::uuid,'restore-regeneration',${JobName.AssetExtractMetadata},'{}',true,false,1000,'active',1,0,
        ${randomUUID()}::uuid,now() + interval '1 minute'),
      (${unsafeJob}::uuid,'restore-regeneration',${JobName.IntegrityDeleteReports},
        ${JSON.stringify({ operationId: randomUUID() })}::text::jsonb,false,false,1000,'pending',0,0,NULL,NULL)`.execute(
      db,
    );
    const repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
    await repository.resetTransientExecutionState();
    await repository.resetTransientExecutionState(); // Lost offline acknowledgement, no new budget.
    expect(await work()).toEqual(captured);
    expect(
      (
        await sql`SELECT state,attempt,"retryBaseAttempt",token,"leaseExpiresAt" FROM job WHERE id=${safeJob}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ state: 'pending', attempt: 1, retryBaseAttempt: 0, token: null, leaseExpiresAt: null }]);
    expect(
      (await sql`SELECT state,token,"leaseExpiresAt" FROM job WHERE id=${unsafeJob}::uuid`.execute(db)).rows,
    ).toEqual([{ state: 'needs_attention', token: null, leaseExpiresAt: null }]);
    await Promise.all([make().begin(), make().begin()]);
    const marker = (await run()).selection.managerSetup;
    expect(marker).toMatchObject({ installation: original, operationId, startedAt: expect.any(String) });
    // FL-1146: metadata and thumbnails start at once; the rest wait for the original-file check.
    const early = new Set<string>([JobName.AssetExtractMetadata, JobName.AssetGenerateThumbnails]);
    expect(await holds()).toEqual(
      Object.fromEntries(stages.filter((stage) => !early.has(stage)).map((stage) => [stage, 'setup'])),
    );
    expect((await work()).map((row) => row.state)).toEqual(captured.map((row) => row.state));
    expect(await setup.sut.getAdminConfigWithRevision()).toEqual(settings);
    process.env.FRAMELEAF_MANAGER_INSTALLATION = '444455556666'; // Restore the restored library again.
    await make().begin(true);
    expect((await run()).selection.managerSetup).toEqual(marker);
    expect((await make().status()).regeneration?.runId).toBe(id);
    expect((await sql`SELECT count(*)::int AS count FROM job_run`.execute(db)).rows).toEqual([{ count: 1 }]);
    expect((await sql`SELECT count(*)::int AS count FROM job WHERE "runId"=${id}::uuid`.execute(db)).rows).toEqual([
      { count: stages.length },
    ]);
    expect((await make().status({ user: { isAdmin: false } } as AuthDto)).regeneration).toBeNull();
    // An entirely cancelled restored run stays cancelled and never gets a false start receipt.
    await sql`UPDATE job SET state='cancelled',"finishedAt"=now() WHERE "runId"=${id}::uuid`.execute(db);
    await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,startedAt}','null'::jsonb) WHERE id=${id}::uuid`.execute(
      db,
    );
    await make().begin();
    expect((await run()).selection.managerSetup.startedAt).toBeNull();
    expect((await make().status()).regeneration).toMatchObject({ state: 'cancelled' });
    expect(await users.hasAdmin()).toBe(true);
    expect(user.isAdmin).toBe(true);
  } finally {
    for (const [name, value] of [
      ['FRAMELEAF_MANAGER_INSTALLATION', previous.installation],
      ['FRAMELEAF_MANAGER_ORIGIN', previous.origin],
      ['FRAMELEAF_MANAGER_IMPORT_INSTALLATION', previous.imported],
    ]) {
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    }
    await db.destroy();
  }
});

it.each(['bound-missing-run', 'bound-missing-marker', 'unbound-markerless'] as const)(
  'reports a broken trusted restore binding without adopting independent-copy work: %s',
  async (scenario) => {
    const db = await getKyselyDB(`fl333_restore_${scenario.replaceAll('-', '_')}`);
    const previous = {
      installation: process.env.FRAMELEAF_MANAGER_INSTALLATION,
      origin: process.env.FRAMELEAF_MANAGER_ORIGIN,
      imported: process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION,
    };
    const source = 'bound-source',
      config = 'bound-config';
    const id = importDerivedRunId(source, config);
    const service = new FrameleafLibrarySetupService(
      db,
      {} as never,
      {} as never,
      // starting setup records each queue's failed count as its baseline
      { getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, paused: 0, failed: 0 }) } as never,
      { hasAdmin: vi.fn().mockResolvedValue(false) } as never,
      {} as never,
      {} as never,
      { getAdminConfigWithRevision: vi.fn().mockResolvedValue({ config: mapAdminConfig(defaults) }) } as never,
      {} as never,
    );
    try {
      process.env.FRAMELEAF_MANAGER_INSTALLATION = 'aaaabbbbcccc';
      process.env.FRAMELEAF_MANAGER_ORIGIN = 'restored_library';
      if (scenario === 'unbound-markerless') delete process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION;
      else process.env.FRAMELEAF_MANAGER_IMPORT_INSTALLATION = 'ddddeeeeffff';
      await sql`INSERT INTO frameleaf_immich_import(source_fingerprint,config_fingerprint,source_version,status)
        VALUES (${source},${config},'frozen-fixture','activated')`.execute(db);
      if (scenario !== 'bound-missing-run') {
        await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone")
          VALUES (${id}::uuid,${IMPORT_DERIVED_RUN_KIND},${JSON.stringify({ source, config })}::text::jsonb,true)`.execute(
          db,
        );
      }
      const status = await service.status();
      if (scenario === 'unbound-markerless') expect(status.regeneration).toBeNull();
      else
        expect(status.regeneration).toMatchObject({
          runId: scenario === 'bound-missing-run' ? null : id,
          state: 'needs_attention',
          reasons: ['import_not_prepared'],
          startedAt: null,
        });
      const { rows } = await sql`SELECT selection FROM job_run WHERE id=${id}::uuid`.execute(db);
      expect(rows).toEqual(scenario === 'bound-missing-run' ? [] : [{ selection: { source, config } }]);
      expect((await sql`SELECT count(*)::int AS count FROM job`.execute(db)).rows).toEqual([{ count: 0 }]);
    } finally {
      for (const [name, value] of [
        ['FRAMELEAF_MANAGER_INSTALLATION', previous.installation],
        ['FRAMELEAF_MANAGER_ORIGIN', previous.origin],
        ['FRAMELEAF_MANAGER_IMPORT_INSTALLATION', previous.imported],
      ]) {
        if (value === undefined) delete process.env[name!];
        else process.env[name!] = value;
      }
      await db.destroy();
    }
  },
);
