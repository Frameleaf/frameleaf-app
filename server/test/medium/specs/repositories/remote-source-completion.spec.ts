import { type Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from 'src/schema/index.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus, RenderWorkerStatus } from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { bindSourceReference } from 'test/fixtures/source-reference.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const deferred = () => Promise.withResolvers<void>();
const staged = async (_withSource = true, reference = false) => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  if (reference) await bindSourceReference(db, asset);
  const sourceEpochs = await AssetLocalEffectRepository.sourceEpochs(db, [asset.id]);
  return { ctx, user, asset, operation: { snapshot: { sourceEpochs } } };
};
const remoteCompletion = async (f: Awaited<ReturnType<typeof staged>>, bound = true) => {
  const workers = new RenderWorkerRepository(db);
  const worker = await workers.createWorker({
    name: 'Remote completion fixture',
    destination: MediaOperationDestination.Lan,
    kinds: [MediaOperationKind.RestorationPreview],
    enrolmentSecret: randomBytes(32),
    engineDigest: 'remote-engine',
    conformanceMaxAgeMs: 86_400_000,
    maxConcurrentOperations: 1,
    maxWallClockMs: null,
    maxOutputBytes: null,
    gpuMemoryBytes: null,
    createdBy: null,
  });
  const session = await workers.createSession({
    workerId: worker.id,
    token: randomBytes(32),
    scopes: [MediaOperationKind.RestorationPreview],
    gpuMemoryBytes: null,
    engineDigest: worker.engineDigest,
    conformanceReportedAt: new Date(),
    expiresAt: new Date(Date.now() + 90_000),
  });
  const output = (await f.ctx.newAsset({ ownerId: f.user.id })).asset;
  const operations = new MediaOperationRepository(db);
  const job = await operations.create({
    ownerId: f.user.id,
    assetId: f.asset!.id,
    kind: MediaOperationKind.RestorationPreview,
    destination: MediaOperationDestination.Lan,
    label: 'Remote reference result',
    snapshot: bound ? f.operation.snapshot : {},
    settings: {},
  });
  const token = randomUUID();
  await db
    .updateTable('media_operation')
    .set({
      status: MediaOperationStatus.Validating,
      claimToken: token,
      claimedBy: worker.id,
      claimExpiresAt: new Date(Date.now() + 90_000),
    })
    .where('id', '=', job.id)
    .execute();
  const remote = {
    workerId: worker.id,
    sessionId: session.id,
    sessionTokenHash: session.token,
    resultAssetId: output.id,
  };
  return { operations, workers, worker, session, output, job, token, remote };
};

it('adopts a remote owned result under the exact reference and credential', async () => {
  const f = await staged(true, true),
    r = await remoteCompletion(f);
  expect(await r.operations.publishValidated(r.job.id, r.token, () => Promise.resolve(true), r.remote)).toBe(
    'completed',
  );
  expect((await r.operations.getForOwner(r.job.id, f.user.id))?.resultAssetId).toBe(r.output.id);
});

it('refuses remote legacy reference completion without recording result lineage', async () => {
  const f = await staged(true, true),
    r = await remoteCompletion(f, false);
  const publish = vi.fn().mockResolvedValue(true);
  await expect(r.operations.publishValidated(r.job.id, r.token, publish, r.remote)).rejects.toThrow(
    'studio_source_admission_changed',
  );
  expect(publish).not.toHaveBeenCalled();
  expect((await r.operations.getForOwner(r.job.id, f.user.id))?.resultAssetId).toBeNull();
});

it.each([
  'revoked-session',
  'expired-session',
  'changed-token',
  'changed-engine',
  'revoked-worker',
  'wrong-worker',
  'narrowed-scope',
  'narrowed-worker-kinds',
  'changed-destination',
  'server-only-kind',
  'expired-claim',
  'cancelled-claim',
  'paused-claim',
] as const)('refuses remote completion with %s', async (change) => {
  const f = await staged(true, true),
    r = await remoteCompletion(f);
  switch (change) {
    case 'narrowed-worker-kinds': {
      await db.updateTable('render_worker').set({ kinds: [] }).where('id', '=', r.worker.id).execute();
      break;
    }
    case 'expired-claim': {
      await db
        .updateTable('media_operation')
        .set({ claimExpiresAt: new Date(0) })
        .where('id', '=', r.job.id)
        .execute();
      break;
    }
    case 'paused-claim': {
      await db
        .updateTable('media_operation')
        .set({ pauseRequestedAt: new Date() })
        .where('id', '=', r.job.id)
        .execute();
      break;
    }
    case 'cancelled-claim': {
      await db
        .updateTable('media_operation')
        .set({ cancelRequestedAt: new Date() })
        .where('id', '=', r.job.id)
        .execute();
      break;
    }
    case 'narrowed-scope': {
      await db.updateTable('render_worker_session').set({ scopes: [] }).where('id', '=', r.session.id).execute();
      break;
    }
    case 'changed-destination': {
      await db
        .updateTable('render_worker')
        .set({ destination: MediaOperationDestination.FrameleafCloud })
        .where('id', '=', r.worker.id)
        .execute();
      break;
    }
    case 'server-only-kind': {
      await db
        .updateTable('media_operation')
        .set({ kind: MediaOperationKind.Bulk })
        .where('id', '=', r.job.id)
        .execute();
      await db
        .updateTable('render_worker')
        .set({ kinds: [MediaOperationKind.Bulk] })
        .where('id', '=', r.worker.id)
        .execute();
      await db
        .updateTable('render_worker_session')
        .set({ scopes: [MediaOperationKind.Bulk] })
        .where('id', '=', r.session.id)
        .execute();
      break;
    }
    case 'revoked-session': {
      await r.workers.revokeSessions(r.worker.id);
      break;
    }
    case 'expired-session': {
      await db
        .updateTable('render_worker_session')
        .set({ expiresAt: new Date(0) })
        .where('id', '=', r.session.id)
        .execute();
      break;
    }
    case 'changed-token': {
      r.remote.sessionTokenHash = randomBytes(32);
      break;
    }
    case 'changed-engine': {
      await db
        .updateTable('render_worker')
        .set({ engineDigest: 'another-engine' })
        .where('id', '=', r.worker.id)
        .execute();
      break;
    }
    case 'revoked-worker': {
      await db
        .updateTable('render_worker')
        .set({ status: RenderWorkerStatus.Revoked })
        .where('id', '=', r.worker.id)
        .execute();
      break;
    }
    case 'wrong-worker': {
      await db.updateTable('media_operation').set({ claimedBy: randomUUID() }).where('id', '=', r.job.id).execute();
      break;
    }
  }
  const publish = vi.fn().mockResolvedValue(true);
  expect(await r.operations.publishValidated(r.job.id, r.token, publish, r.remote)).toBe('lost');
  expect(publish).not.toHaveBeenCalled();
  expect((await r.operations.getForOwner(r.job.id, f.user.id))?.resultAssetId).toBeNull();
});

it.each(['revoke-session', 'move-result'] as const)(
  'revalidates %s after waiting for source authority',
  async (change) => {
    const f = await staged(true, true),
      r = await remoteCompletion(f);
    const foreign = (await f.ctx.newUser()).user;
    const held = deferred(),
      release = deferred();
    const locker = db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${f.asset!.id})::int)`.execute(tx);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const publish = vi.fn().mockResolvedValue(true);
    const pending = r.operations.publishValidated(r.job.id, r.token, publish, r.remote);
    try {
      await expect
        .poll(async () => {
          const { rows } = await sql<{
            blocked: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0) AS blocked`.execute(
            db,
          );
          return rows[0].blocked;
        })
        .toBe(true);
      if (change === 'revoke-session') await r.workers.revokeSessions(r.worker.id);
      else await db.updateTable('asset').set({ ownerId: foreign.id }).where('id', '=', r.output.id).execute();
    } finally {
      release.resolve();
      await locker;
    }
    expect(await pending).toBe(change === 'revoke-session' ? 'lost' : 'rejected');
    expect(publish).not.toHaveBeenCalled();
    expect((await r.operations.getForOwner(r.job.id, f.user.id))?.resultAssetId).toBeNull();
  },
);

it('rolls back adoption when a remote session expires inside the callback', async () => {
  const f = await staged(true, true),
    r = await remoteCompletion(f);
  await expect(
    r.operations.publishValidated(
      r.job.id,
      r.token,
      async (tx) => {
        await tx
          .updateTable('render_worker_session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', r.session.id)
          .execute();
        await tx
          .updateTable('media_operation')
          .set({ result: { mustRollback: true } })
          .where('id', '=', r.job.id)
          .execute();
        return true;
      },
      r.remote,
    ),
  ).rejects.toThrow('render_worker_authority_changed');
  const row = await r.operations.getForOwner(r.job.id, f.user.id);
  expect(row?.status).toBe(MediaOperationStatus.Validating);
  expect(row?.resultAssetId).toBeNull();
  expect(row?.result).toBeNull();
  expect(
    new Date(
      (
        await db
          .selectFrom('render_worker_session')
          .select('expiresAt')
          .where('id', '=', r.session.id)
          .executeTakeFirstOrThrow()
      ).expiresAt,
    ).getTime(),
  ).toBeGreaterThan(Date.now());
});

it('keeps legacy managed originals eligible for remote result completion', async () => {
  const f = await staged(true),
    r = await remoteCompletion(f, false);
  expect(await r.operations.publishValidated(r.job.id, r.token, () => Promise.resolve(true), r.remote)).toBe(
    'completed',
  );
  expect((await r.operations.getForOwner(r.job.id, f.user.id))?.resultAssetId).toBe(r.output.id);
});

it('keeps the recorded engine binding when both worker and session engines are replaced', async () => {
  const f = await staged(true, true),
    r = await remoteCompletion(f);
  await db
    .updateTable('media_operation')
    .set({ snapshot: { ...r.job.snapshot, engineDigest: 'remote-engine' } })
    .where('id', '=', r.job.id)
    .execute();
  await db
    .updateTable('render_worker')
    .set({ engineDigest: 'replacement-engine' })
    .where('id', '=', r.worker.id)
    .execute();
  await db
    .updateTable('render_worker_session')
    .set({ engineDigest: 'replacement-engine' })
    .where('id', '=', r.session.id)
    .execute();
  const publish = vi.fn().mockResolvedValue(true);
  expect(await r.operations.publishValidated(r.job.id, r.token, publish, r.remote)).toBe('lost');
  expect(publish).not.toHaveBeenCalled();
});

it('uses canonical result metadata authority for an uppercase result UUID', async () => {
  const f = await staged(true, true),
    r = await remoteCompletion(f);
  r.remote.resultAssetId = r.output.id.toUpperCase();
  const held = deferred(),
    release = deferred();
  const locker = db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${r.output.id})::int)`.execute(tx);
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const pending = r.operations.publishValidated(r.job.id, r.token, () => Promise.resolve(true), r.remote);
  try {
    await expect
      .poll(async () => {
        const { rows } = await sql<{
          blocked: boolean;
        }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0) AS blocked`.execute(
          db,
        );
        return rows[0].blocked;
      })
      .toBe(true);
    await db.transaction().execute(async (tx) => {
      await sql`SELECT id FROM media_operation WHERE id=${r.job.id}::uuid FOR UPDATE NOWAIT`.execute(tx);
    });
  } finally {
    release.resolve();
    await locker;
  }
  expect(await pending).toBe('completed');
  expect((await r.operations.getForOwner(r.job.id, f.user.id))?.resultAssetId).toBe(r.output.id);
});
