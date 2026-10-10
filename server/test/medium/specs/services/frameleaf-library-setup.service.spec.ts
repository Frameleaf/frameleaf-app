import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { FrameleafLibrarySetupController } from 'src/controllers/frameleaf-library-setup.controller.js';
import { JobName, QueueName, SyncEntityType } from 'src/enum.js';
import { IMPORT_DERIVED_RUN_KIND, IMPORT_DERIVED_STAGES, importDerivedRunId } from 'src/immich-import/derived-work.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SyncCheckpointRepository } from 'src/repositories/sync-checkpoint.repository.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { SyncService } from 'src/services/sync.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

it('starts the retained import regeneration during first setup once ready, resumes the same run and reports background errors', async () => {
  const db = await getKyselyDB('fl333_manager_regeneration');
  const previous = {
    installation: process.env.FRAMELEAF_MANAGER_INSTALLATION,
    origin: process.env.FRAMELEAF_MANAGER_ORIGIN,
    ml: process.env.FRAMELEAF_MANAGER_ML_ENABLED,
  };
  const installation = '333333334444';
  const key = `frameleaf-manager-library-setup:${installation}`;
  const source = 'verified-source',
    configFingerprint = 'verified-config';
  const id = importDerivedRunId(source, configFingerprint);
  const stages = [...IMPORT_DERIVED_STAGES.map(([, name]) => name), JobName.PersonGenerateThumbnail];
  const users = {
    hasAdmin: vi.fn().mockResolvedValue(false),
    getAdmin: vi.fn().mockResolvedValue({ id: randomUUID() }),
  };
  const config = {
    getAdminConfigWithRevision: vi
      .fn()
      .mockResolvedValue({ config: { machineLearning: { enabled: true, urls: [] } }, revision: 'first' }),
    updateAdminConfigWithRevision: vi.fn().mockResolvedValue({}),
  };
  const make = () =>
    new FrameleafLibrarySetupService(
      db,
      { getAll: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
      { getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, paused: 0, failed: 0 }) } as never,
      users as never,
      {} as never,
      {} as never,
      config as never,
    );
  const run = async () =>
    (
      await sql<{ selection: { managerSetup: { startedAt: string | null } } }>`
    SELECT selection FROM job_run WHERE id=${id}::uuid`.execute(db)
    ).rows[0];
  const selections = async () =>
    (
      await sql<{ stage: string; state: string }>`
    SELECT stage,state FROM job_selection WHERE "runId"=${id}::uuid ORDER BY stage`.execute(db)
    ).rows;
  try {
    process.env.FRAMELEAF_MANAGER_INSTALLATION = installation;
    process.env.FRAMELEAF_MANAGER_ORIGIN = 'new_import';
    delete process.env.FRAMELEAF_MANAGER_ML_ENABLED;
    await sql`INSERT INTO frameleaf_immich_import(source_fingerprint,config_fingerprint,source_version,status)
      VALUES (${source},${configFingerprint},'frozen-fixture','verifying')`.execute(db);
    await sql`INSERT INTO job_queue(name) VALUES ('manager-regeneration')`.execute(db);
    await sql`INSERT INTO job_run(id,kind,selection,"enumerationDone") VALUES (${id}::uuid,${IMPORT_DERIVED_RUN_KIND},
      ${JSON.stringify({ source, config: configFingerprint, managerSetup: { installation, operationId: randomUUID(), preparedAt: null, startedAt: null } })}::text::jsonb,false)`.execute(
      db,
    );
    for (const name of stages) {
      await sql`INSERT INTO job_selection(id,"runId",stage,queue,"safeToRetry",sensitive,"deadlineMs",state,"capturedAt")
        VALUES (${randomUUID()}::uuid,${id}::uuid,${name},'manager-regeneration',true,false,1000,
        ${name === JobName.AssetGenerateThumbnails ? 'cancelled' : 'enumerating'},
        ${name === JobName.PersonGenerateThumbnail ? null : new Date()})`.execute(db);
    }
    const service = make();
    await service.begin();
    expect((await service.status()).regeneration).toMatchObject({
      runId: id,
      state: 'pending_first_setup',
      startedAt: null,
      reasons: ['settings_not_ready'],
    });
    expect(config.updateAdminConfigWithRevision).not.toHaveBeenCalled();
    process.env.FRAMELEAF_MANAGER_ML_ENABLED = 'invalid';
    await expect(service.begin()).rejects.toThrow('Invalid Manager processing choice');
    expect((await run()).selection.managerSetup.startedAt).toBeNull();
    process.env.FRAMELEAF_MANAGER_ML_ENABLED = 'false';
    await service.begin(); // Choice persisted; account and activated/prepared import still required.
    expect(config.updateAdminConfigWithRevision).toHaveBeenCalledTimes(1);
    expect((await run()).selection.managerSetup.startedAt).toBeNull();
    users.hasAdmin.mockResolvedValue(true);
    await service.begin();
    expect((await run()).selection.managerSetup.startedAt).toBeNull();
    await sql`UPDATE frameleaf_immich_import SET status='activated'`.execute(db);
    await sql`UPDATE job_run SET "enumerationDone"=true,selection=jsonb_set(selection,'{managerSetup,preparedAt}',to_jsonb(now()::text)) WHERE id=${id}::uuid`.execute(
      db,
    );
    await service.begin(); // The fifth, person-thumbnail capture is incomplete.
    expect((await run()).selection.managerSetup.startedAt).toBeNull();
    expect((await selections()).filter((row) => row.state === 'ready')).toEqual([]);
    await sql`UPDATE job_selection SET "capturedAt"=now() WHERE "runId"=${id}::uuid AND stage=${JobName.PersonGenerateThumbnail}`.execute(
      db,
    );
    await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,installation}','"555555556666"'::jsonb) WHERE id=${id}::uuid`.execute(
      db,
    );
    await service.begin();
    expect((await run()).selection.managerSetup.startedAt).toBeNull();
    expect((await service.status()).regeneration).toMatchObject({
      state: 'needs_attention',
      reasons: ['import_not_prepared'],
    });
    await sql`UPDATE job_run SET selection=jsonb_set(selection,'{managerSetup,installation}',${JSON.stringify(installation)}::text::jsonb) WHERE id=${id}::uuid`.execute(
      db,
    );
    await Promise.all([service.begin(), make().begin()]);
    const startedAt = (await run()).selection.managerSetup.startedAt;
    expect(startedAt).toEqual(expect.any(String));
    expect(await selections()).toEqual(
      stages
        .toSorted()
        .map((stage) => ({ stage, state: stage === JobName.AssetGenerateThumbnails ? 'cancelled' : 'ready' })),
    );
    await make().begin(true); // Restart/retry must not mint a run or revive cancellation.
    expect((await run()).selection.managerSetup.startedAt).toBe(startedAt);
    expect((await sql<{ count: number }>`SELECT count(*)::int AS count FROM job_run`.execute(db)).rows[0].count).toBe(
      1,
    );
    expect((await sql<{ count: number }>`SELECT count(*)::int AS count FROM job`.execute(db)).rows[0].count).toBe(0);
    // Existing phone/setup completion is independent of this durable run's work.
    const revision = randomUUID(),
      sessionId = randomUUID();
    await sql`UPDATE system_metadata SET value=value || ${JSON.stringify({ phase: 'complete', revision })}::text::jsonb WHERE key=${key}`.execute(
      db,
    );
    await sql`INSERT INTO system_metadata(key,value) VALUES (${key + ':phone:' + sessionId},${JSON.stringify({ revision, tokenHash: 'fixture', finished: true })}::text::jsonb)`.execute(
      db,
    );
    const selectionId = (
      await sql<{
        id: string;
      }>`SELECT id FROM job_selection WHERE "runId"=${id}::uuid AND stage=${JobName.PersonGenerateThumbnail}`.execute(
        db,
      )
    ).rows[0].id;
    await sql`INSERT INTO job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,"selectionId",state)
      VALUES (${id}::uuid,'private-person','private-asset',${JobName.PersonGenerateThumbnail},'manager-regeneration','{}',${selectionId}::uuid,'pending')`.execute(
      db,
    );
    const jobId = randomUUID();
    await sql`INSERT INTO job(id,queue,name,data,"safeToRetry",sensitive,"deadlineMs","runId","itemKey","dependencyReason")
      VALUES (${jobId}::uuid,'manager-regeneration',${JobName.PersonGenerateThumbnail},'{}',true,false,1000,${id}::uuid,'private-person','destination-unavailable')`.execute(
      db,
    );
    await sql`UPDATE job_run_item SET "jobId"=${jobId}::uuid WHERE "runId"=${id}::uuid AND "itemKey"='private-person'`.execute(
      db,
    );
    const pending = await make().status();
    expect(pending.canFinish).toBe(true);
    expect(pending.regeneration).toMatchObject({ runId: id, state: 'blocked', startedAt, blocked: 1 });
    await sql`UPDATE job SET state='failed',"finishedAt"=now() WHERE id=${jobId}::uuid`.execute(db);
    expect((await make().status()).regeneration).toMatchObject({
      runId: id,
      state: 'completed_with_errors',
      failed: 1,
    });
    const privateStatus = await make().status({ user: { isAdmin: false }, session: { id: sessionId } } as AuthDto);
    expect(privateStatus.regeneration).toBeNull();
    expect(privateStatus.canFinish).toBe(true);
    expect(JSON.stringify(pending.regeneration)).not.toMatch(
      /private-person|private-asset|verified-source|verified-config/,
    );
  } finally {
    for (const [name, value] of [
      ['FRAMELEAF_MANAGER_INSTALLATION', previous.installation],
      ['FRAMELEAF_MANAGER_ORIGIN', previous.origin],
      ['FRAMELEAF_MANAGER_ML_ENABLED', previous.ml],
    ]) {
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    }
    await db.destroy();
  }
});

it('applies the initial machine learning choice once through normal settings and preserves restored settings', async () => {
  const db = await getKyselyDB('fl334_manager_settings');
  const previous = {
    installation: process.env.FRAMELEAF_MANAGER_INSTALLATION,
    origin: process.env.FRAMELEAF_MANAGER_ORIGIN,
    ml: process.env.FRAMELEAF_MANAGER_ML_ENABLED,
  };
  const saved = { machineLearning: { enabled: true, urls: ['http://previous:3003'] }, trash: { days: 17 } };
  const config = {
    getAdminConfigWithRevision: vi.fn().mockResolvedValue({ config: saved, revision: 'current' }),
    updateAdminConfigWithRevision: vi.fn().mockResolvedValue({}),
  };
  const service = new FrameleafLibrarySetupService(
    db,
    {} as never,
    {} as never,
    // starting setup records each queue's failed count as its baseline
    { getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, paused: 0, failed: 0 }) } as never,
    { hasAdmin: vi.fn().mockResolvedValue(false) } as never,
    {} as never,
    {} as never,
    config as never,
  );
  try {
    process.env.FRAMELEAF_MANAGER_INSTALLATION = 'aaaaaaaabbbb';
    process.env.FRAMELEAF_MANAGER_ORIGIN = 'new_library';
    process.env.FRAMELEAF_MANAGER_ML_ENABLED = 'false';
    await service.begin();
    await service.begin(); // Still waiting for an account; do not overwrite later administrator choices.
    expect((await service.status()).regeneration).toBeNull(); // A fresh installation has no import run to start.
    expect(config.updateAdminConfigWithRevision).toHaveBeenCalledExactlyOnceWith({
      config: {
        machineLearning: { enabled: false, urls: ['http://immich-machine-learning:3003'] },
        trash: { days: 17 },
      },
      expectedRevision: 'current',
    });
    process.env.FRAMELEAF_MANAGER_INSTALLATION = 'ccccccccdddd';
    process.env.FRAMELEAF_MANAGER_ORIGIN = 'restored_library';
    await service.begin();
    expect(config.getAdminConfigWithRevision).toHaveBeenCalledTimes(1);
  } finally {
    for (const [key, value] of [
      ['FRAMELEAF_MANAGER_INSTALLATION', previous.installation],
      ['FRAMELEAF_MANAGER_ORIGIN', previous.origin],
      ['FRAMELEAF_MANAGER_ML_ENABLED', previous.ml],
    ]) {
      if (value === undefined) {
        delete process.env[key!];
      } else {
        process.env[key!] = value;
      }
    }
    await db.destroy();
  }
});

it('waits for a fresh full integrity scan when the existing operation is incremental or predates discovery', async () => {
  const db = await getKyselyDB('fl334_manager_full_scan');
  const { ctx } = newMediumService(SyncService, { database: db, real: [], mock: [LoggingRepository] });
  const previous = {
    installation: process.env.FRAMELEAF_MANAGER_INSTALLATION,
    origin: process.env.FRAMELEAF_MANAGER_ORIGIN,
    ml: process.env.FRAMELEAF_MANAGER_ML_ENABLED,
  };
  try {
    const { user } = await ctx.newUser();
    await ctx.newAsset({ ownerId: user.id });
    process.env.FRAMELEAF_MANAGER_INSTALLATION = 'eeeeeeeeffff';
    process.env.FRAMELEAF_MANAGER_ORIGIN = 'new_library';
    delete process.env.FRAMELEAF_MANAGER_ML_ENABLED;
    const key = 'frameleaf-manager-library-setup:eeeeeeeeffff';
    const incremental = randomUUID(),
      oldFull = randomUUID(),
      freshFull = randomUUID();
    const mediaHealth = { startMissingScan: vi.fn().mockResolvedValue({ operationId: incremental }) };
    const service = new FrameleafLibrarySetupService(
      db,
      { getAll: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
      { getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, paused: 0, failed: 0 }) } as never,
      { hasAdmin: vi.fn().mockResolvedValue(true), getAdmin: vi.fn().mockResolvedValue(user) } as never,
      {} as never,
      mediaHealth as never,
      {} as never,
    );
    await service.status(); // Persist the full-scan admission boundary after discovery.
    for (const [id, snapshot, createdAt] of [
      [incremental, { mode: 'scan', changedSince: new Date().toISOString() }, new Date()],
      [oldFull, { mode: 'scan' }, new Date(Date.now() - 60_000)],
    ] as const) {
      await sql`INSERT INTO media_operation (id, "ownerId", kind, destination, label, snapshot, settings, "createdAt")
        VALUES (${id}::uuid, ${user.id}::uuid, 'media_health', 'local', 'Fixture integrity scan',
        ${JSON.stringify(snapshot)}::text::jsonb, '{}'::jsonb, ${createdAt})`.execute(db);
    }
    await service.status();
    let state = await sql<{
      value: { health: Record<string, string> };
    }>`SELECT value FROM system_metadata WHERE key=${key}`.execute(db);
    expect(state.rows[0].value.health).toEqual({});
    mediaHealth.startMissingScan.mockResolvedValue({ operationId: oldFull });
    await service.status();
    state = await sql<{
      value: { health: Record<string, string> };
    }>`SELECT value FROM system_metadata WHERE key=${key}`.execute(db);
    expect(state.rows[0].value.health).toEqual({});
    await sql`INSERT INTO media_operation (id, "ownerId", kind, destination, label, snapshot, settings)
      VALUES (${freshFull}::uuid, ${user.id}::uuid, 'media_health', 'local', 'Fixture full scan', '{"mode":"scan"}'::jsonb, '{}'::jsonb)`.execute(
      db,
    );
    // A fresh full operation can be recovered after a lost queue acknowledgement.
    expect((await service.status()).phase).not.toBe('complete');
    state = await sql<{
      value: { health: Record<string, string> };
    }>`SELECT value FROM system_metadata WHERE key=${key}`.execute(db);
    expect(state.rows[0].value.health).toEqual({ [user.id]: freshFull });
    expect(mediaHealth.startMissingScan).toHaveBeenCalledTimes(2);
  } finally {
    for (const [key, value] of [
      ['FRAMELEAF_MANAGER_INSTALLATION', previous.installation],
      ['FRAMELEAF_MANAGER_ORIGIN', previous.origin],
      ['FRAMELEAF_MANAGER_ML_ENABLED', previous.ml],
    ]) {
      if (value === undefined) {
        delete process.env[key!];
      } else {
        process.env[key!] = value;
      }
    }
    await db.destroy();
  }
});

it('serializes setup, resumes from persisted intent and keeps device completion scoped to its session', async () => {
  const db = await getKyselyDB('fl334_manager_setup');
  const installation = 'abcdabcdabcd';
  const revision = '019b0000-0000-7000-8000-000000000001';
  const oldInstallation = process.env.FRAMELEAF_MANAGER_INSTALLATION;
  const oldOrigin = process.env.FRAMELEAF_MANAGER_ORIGIN;
  process.env.FRAMELEAF_MANAGER_INSTALLATION = installation;
  process.env.FRAMELEAF_MANAGER_ORIGIN = 'new_library';
  const session = randomUUID(),
    otherSession = randomUUID();
  const auth = { user: { id: randomUUID() }, session: { id: session } } as AuthDto;
  const other = { user: { id: randomUUID() }, session: { id: otherSession } } as AuthDto;
  const counts = { active: 0, waiting: 0, delayed: 0, paused: 0, failed: 3 };
  let acknowledged = false;
  let sidecarWaiting = 0;
  const make = () =>
    new FrameleafLibrarySetupService(
      db,
      { getAll: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
      {
        getJobCounts: (queue: QueueName) =>
          Promise.resolve({
            ...counts,
            waiting: queue === QueueName.Sidecar ? sidecarWaiting : 0,
          }),
      } as never,
      { hasAdmin: vi.fn().mockResolvedValue(true), getAdmin: vi.fn().mockResolvedValue({ id: auth.user.id }) } as never,
      {
        getNow: vi.fn().mockResolvedValue({ nowId: revision }),
        getAll: (id: string) =>
          Promise.resolve(
            id === session && acknowledged
              ? [{ type: SyncEntityType.SyncCompleteV1, ack: `${SyncEntityType.SyncCompleteV1}|${revision}` }]
              : [],
          ),
      } as never,
      {} as never,
      {} as never,
    );
  try {
    const first = make(),
      second = make();
    await Promise.all([first.begin(), second.begin()]);
    const key = `frameleaf-manager-library-setup:${installation}`;
    const persisted = await sql<{ type: string; origin: string }>`SELECT jsonb_typeof(value) AS type,
      value->>'origin' AS origin FROM system_metadata WHERE key=${key}`.execute(db);
    expect(persisted.rows).toEqual([{ type: 'object', origin: 'new_library' }]);
    expect((await first.status(auth)).canFinish).toBe(false);
    counts.failed = 4;
    expect((await first.status(auth)).phase).toBe('needs-attention');
    await first.begin(true);
    // a retry starts over with today's failures as its baseline: the first poll commits the
    // integrity-scan admission again, the next one verifies
    expect((await first.status(auth)).phase).toBe('rescanning');
    expect((await first.status(auth)).phase).toBe('verifying');
    await sql`UPDATE system_metadata SET value=jsonb_set(value, '{quietSince}', to_jsonb(${Date.now() - 20_000}::bigint)) WHERE key=${key}`.execute(
      db,
    );
    sidecarWaiting = 1;
    expect((await first.status(auth)).phase).not.toBe('complete');
    sidecarWaiting = 0;
    await first.status(auth);
    await sql`UPDATE system_metadata SET value=jsonb_set(value, '{quietSince}', to_jsonb(${Date.now() - 20_000}::bigint)) WHERE key=${key}`.execute(
      db,
    );
    const statuses = await Promise.all([first.status(auth), second.status(other)]);
    expect(statuses.every((status) => status.phase === 'complete' && status.revision === revision)).toBe(true);
    expect(statuses.every((status) => !status.canFinish)).toBe(true);
    const receipt = await second.syncReceipt(auth, revision);
    await expect(first.finish(auth, revision, receipt, true)).rejects.toThrow('Finish syncing');
    acknowledged = true;
    await expect(first.finish(other, revision, receipt, true)).rejects.toThrow('Finish syncing');
    await expect(first.finish(auth, revision, 'f'.repeat(64), true)).rejects.toThrow('Finish syncing');
    await expect(first.finish(auth, revision, receipt, false)).rejects.toThrow('Finish syncing');
    expect((await first.finish(auth, revision, receipt, true)).canFinish).toBe(true);
    // A replacement service sees durable completion, while another account still has work to do.
    expect((await make().status(auth)).canFinish).toBe(true);
    expect((await make().status(other)).canFinish).toBe(false);
    expect((await make().status()).canFinish).toBe(true);
    const serialized = JSON.stringify(await make().status(other));
    expect(serialized).not.toContain(session);
    expect(serialized).not.toContain(receipt);
    // Replaying a catalog sync must not revoke an already completed phone.
    await first.syncReceipt(auth, revision);
    expect((await second.status(auth)).canFinish).toBe(true);
    // A restored installation cannot inherit another installation's setup or device receipts.
    process.env.FRAMELEAF_MANAGER_INSTALLATION = 'dcbaabcdabcd';
    expect((await make().status(auth)).canFinish).toBe(false);
    // Managed uploads require their durable integrity receipt even when every queue is idle.
    const pendingKey = 'frameleaf-manager-library-setup:dcbaabcdabcd';
    await sql`UPDATE system_metadata SET value=value || ${JSON.stringify({ owners: [auth.user.id], health: { [auth.user.id]: randomUUID() }, quietSince: Date.now() - 20_000 })}::text::jsonb WHERE key=${pendingKey}`.execute(
      db,
    );
    expect((await make().status(auth)).phase).not.toBe('complete');
  } finally {
    if (oldInstallation === undefined) {
      delete process.env.FRAMELEAF_MANAGER_INSTALLATION;
    } else {
      process.env.FRAMELEAF_MANAGER_INSTALLATION = oldInstallation;
    }
    if (oldOrigin === undefined) {
      delete process.env.FRAMELEAF_MANAGER_ORIGIN;
    } else {
      process.env.FRAMELEAF_MANAGER_ORIGIN = oldOrigin;
    }
    await db.destroy();
  }
});

it('streams the supported setup protocol through the actual SyncService and only includes permitted assets', async () => {
  const db = await getKyselyDB('fl334_manager_sync');
  const { sut: sync, ctx } = newMediumService(SyncService, {
    database: db,
    real: [SessionRepository, SyncCheckpointRepository, SyncRepository],
    mock: [LoggingRepository],
  });
  Object.assign(sync, { pins: { get: vi.fn().mockResolvedValue({ pins: [], revision: null }) } });
  try {
    const { auth, user } = await ctx.newSyncAuthUser();
    const { user: anotherUser } = await ctx.newUser();
    const { asset: own } = await ctx.newAsset({ ownerId: user.id });
    const { asset: privateAsset } = await ctx.newAsset({ ownerId: anotherUser.id });
    const revision = (await ctx.get(SyncCheckpointRepository).getNow()).nowId;
    const setup = {
      status: vi.fn().mockResolvedValue({ phase: 'complete', revision }),
      syncReceipt: vi.fn().mockResolvedValue('receipt'),
    };
    let result = '';
    const response = Object.assign(
      new Writable({
        write(chunk, _encoding, done) {
          result += String(chunk);
          done();
        },
      }),
      { setHeader: vi.fn() },
    );
    await new FrameleafLibrarySetupController(setup as never, sync).warm(auth, {}, response as never);
    expect(result).toContain(own.id);
    expect(result).not.toContain(privateAsset.id);
    expect(result).toContain(SyncEntityType.SyncCompleteV1);
    expect(result).toContain('FrameleafSetupRevisionV1');
    expect(setup.syncReceipt).toHaveBeenCalledWith(auth, revision);
  } finally {
    await db.destroy();
  }
});
