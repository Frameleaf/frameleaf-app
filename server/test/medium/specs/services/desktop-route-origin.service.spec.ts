import { type Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import type { QueueExecution } from 'src/queue/types.js';
import type { DB } from 'src/schema/index.js';
import { defaults } from 'src/config.js';
import { JobName, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DesktopMlRepository } from 'src/repositories/desktop-ml.repository.js';
import { DesktopWorkerRepository } from 'src/repositories/desktop-worker.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';
import { desktopFaceProfile } from 'src/utils/desktop-face.js';
import { MlDestinationRefusedError, selectMlDestination } from 'src/utils/ml-destination.js';
import { seedDesktopQualification } from 'test/desktop-qualification.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * A desktop takes home work whichever route sent it home: the default one, one an administrator pinned, or
 * one left by an earlier version (docs/desktop-worker-setup-protocol.md in frameleaf-desktop, "Leasing").
 * From the stored route, through the processing order and admission, to a selection the desktop serves.
 */
const url = 'https://nas.invalid';
const profile = desktopFaceProfile(defaults.machineLearning.facialRecognition);
let db: Kysely<DB>;
let routes: MlDestinationRepository;
let ml: MachineLearningRepository;
let service: DesktopMlService;
beforeEach(async () => {
  db = await getKyselyDB();
  routes = new MlDestinationRepository(db);
  ml = new MachineLearningRepository(LoggingRepository.create());
  ml.setup({ ...structuredClone(defaults.machineLearning), urls: [url] });
  service = new DesktopMlService(
    new DesktopMlRepository(db),
    new DesktopClipIndexRepository(db),
    new DesktopAssistancePolicyService(new SystemMetadataRepository(db)),
    routes,
    ml,
  );
  service.onBootstrap();
});
afterEach(async () => {
  service.onShutdown();
  await db.destroy();
});

const fixture = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser({ isAdmin: true });
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  await new DesktopAssistancePolicyService(new SystemMetadataRepository(db)).enable(user.id);
  const { session: photo } = await ctx.newSession({ userId: user.id });
  const device = (await new DesktopDeviceRepository(db).enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: Buffer.alloc(32, 3).toString('base64'),
    name: 'desktop',
    platform: 'macos',
    architecture: 'arm64',
    mode: 'client-worker',
    state: 'preparing',
  }))!;
  const worker = (await new DesktopWorkerRepository(db).issue({
    deviceId: device.id,
    authorizationEpoch: device.authorizationEpoch,
    photoSessionId: photo.id!,
    tokenHash: randomBytes(32),
    modelKeys: [profile.modelKey],
  }))!;
  const grant = {
    deviceId: device.id,
    authorizationEpoch: device.authorizationEpoch,
    sessionId: worker.id,
    credentialHash: worker.tokenHash,
  };
  await new DesktopWorkerRepository(db).consume(grant.sessionId, grant.credentialHash, 1);
  await seedDesktopQualification(db, grant, {
    modelKey: profile.modelKey,
    config: profile.spec.entries,
    inputKind: 'image',
  });
  const destination = await routes.create({
    kind: MlDestinationKind.Local,
    name: 'This server',
    url,
    authToken: null,
    enabled: true,
    workloads: [MlWorkload.Face],
    budgetLimitUsd: null,
    maxRuntimeMinutes: null,
    maxUploadBytes: null,
  });
  return { asset, grant, destination };
};

/** Admit the job the way a queued face job is admitted, to the place the processing order named. */
const admit = async (assetId: string, candidate: { destinationId: string; desktopPool: boolean }) => {
  const context: QueueExecution = {
    claim: {
      id: randomUUID(),
      token: randomUUID(),
      name: JobName.AssetDetectFaces,
      data: {},
      queue: 'faceDetection',
      workerId: 'worker',
      attempt: 1,
      runId: null,
      itemKey: null,
      deadlineMs: 60_000,
      startedAt: new Date(),
    },
    signal: new AbortController().signal,
    progress: vi.fn(),
    followups: [],
    adoptions: [],
    buffering: false,
    progressUnits: 0,
  };
  const jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
  return queueExecution.run(context, async () => {
    await jobs.guardAssetSource(assetId);
    return selectMlDestination(
      {
        mlDestinationRepository: routes,
        machineLearningRepository: ml,
        selectBackgroundPool: (selection, options) =>
          ml.selectBackgroundPool(selection, assetId, options?.requireReady),
      },
      {
        workload: MlWorkload.Face,
        destinationId: candidate.destinationId,
        jobId: assetId,
        desktopPool: candidate.desktopPool ? 'only' : 'skip',
      },
    );
  });
};

it.each(['pinned', 'legacy'] as const)('sends work of a %s route to a ready desktop', async (origin) => {
  const { asset, grant, destination } = await fixture();
  if (origin === 'pinned') await routes.setRoute(MlWorkload.Face, destination.id);
  else
    // a route row from before routes recorded who made them
    await sql`INSERT INTO ml_workload_route (workload, "destinationId") VALUES (${MlWorkload.Face}, ${destination.id}::uuid)`.execute(
      db,
    );
  expect((await routes.getRouteStates()).find((route) => route.workload === MlWorkload.Face)).toMatchObject({
    destinationId: destination.id,
    origin,
  });

  // the processing order offers the desktops for this route, as available
  const candidates = await routes.resolveRoute(MlWorkload.Face);
  const pool = candidates.find((candidate) => candidate.desktopPool);
  expect(pool).toEqual({ source: 'desktops', destinationId: destination.id, desktopPool: true, available: true });

  // admission hands the job to the desktop, which then finds it ready
  const selection = await admit(asset.id, pool!);
  expect(selection.desktopFace).toBeTypeOf('function');
  expect(selection.destinationId).toBe(destination.id);
  expect(await new DesktopMlRepository(db).hasReadyWorker(asset.ownerId, profile.modelKey)).toBe(true);

  // the desktop goes away: the pool is no longer offered as available, and admission to it is refused, so the
  // job goes on to the next place in its order instead of waiting on a switched-off computer
  await sql`UPDATE desktop_worker_session SET "lastSeenAt" = now() - interval '10 minutes' WHERE id = ${grant.sessionId}::uuid`.execute(
    db,
  );
  expect((await routes.resolveRoute(MlWorkload.Face)).find((candidate) => candidate.desktopPool)?.available).toBe(
    false,
  );
  await expect(admit(asset.id, pool!)).rejects.toBeInstanceOf(MlDestinationRefusedError);
});
