import { Reflector } from '@nestjs/core';
import { json } from 'body-parser';
import { sql } from 'kysely';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import type { Kysely } from 'kysely';
import type { QueueExecution } from 'src/queue/types.js';
import type { DB } from 'src/schema/index.js';
import { defaults } from 'src/config.js';
import { AuthController } from 'src/controllers/auth.controller.js';
import { DesktopDeviceController } from 'src/controllers/desktop-device.controller.js';
import { DesktopWorkerController } from 'src/controllers/desktop-worker.controller.js';
import { AssetFileType, JobName, JobStatus, MetadataKey, MlDestinationKind, MlWorkload, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DesktopMlRepository } from 'src/repositories/desktop-ml.repository.js';
import { DesktopWorkerChallengeRepository } from 'src/repositories/desktop-worker-challenge.repository.js';
import { DesktopWorkerRepository, type DesktopWorkerTables } from 'src/repositories/desktop-worker.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AuthService } from 'src/services/auth.service.js';
import { DesktopAssistanceActivationService } from 'src/services/desktop-assistance-activation.service.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DesktopDeviceService } from 'src/services/desktop-device.service.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';
import { DesktopNasProducerService } from 'src/services/desktop-nas-producer.service.js';
import { DesktopQualificationService } from 'src/services/desktop-qualification.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { DesktopWorkerService } from 'src/services/desktop-worker.service.js';
import { OcrService } from 'src/services/ocr.service.js';
import { PersonService } from 'src/services/person.service.js';
import { SmartInfoService } from 'src/services/smart-info.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { verifyDesktopRuntimeAttestation } from 'src/utils/desktop-runtime-attestation.js';
import { newMediumService } from 'test/medium.factory.js';
import { controllerSetup, getKyselyDB } from 'test/utils.js';

// Explicit opt-in authority for the synthetic CoreML fixture only; production resources are unchanged.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (
        process.env.FRAMELEAF_TEST_COREML_NAS === '1' &&
        String(args[0]).endsWith('/resources/desktop/release-trust.json')
      ) {
        return JSON.stringify({
          schemaVersion: 1,
          minimumRuntimeEpoch: 1,
          keys: [
            {
              id: 'coreml-nas-fixture',
              publicKeyHex: 'e28a8970753332bd72fef413e6b0b2ef1b4aadda7aa2c141f233712a6876b351',
            },
          ],
        });
      }
      return fs.readFileSync(...args);
    },
  };
});

const desktop = process.env.FRAMELEAF_NATIVE_DESKTOP_ROOT;
const pack = process.env.FRAMELEAF_FACTORY_TEST_PACK;
const cache = process.env.FRAMELEAF_FACTORY_MODEL_CACHE;
const workload = process.env.FRAMELEAF_FACTORY_TEST_WORKLOAD ?? 'clip';
const ocr = workload === 'ocr';
const face = workload === 'face';
const automatic = !!process.env.FRAMELEAF_FACTORY_AUTOMATIC_SETUP;
if (automatic && !['ocr', 'clip', 'face'].includes(workload))
  throw new Error('automatic fixture requires a supported library workload');
const port = async () => {
  const socket = createTcpServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const value = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
  return value;
};
const stop = async (child: ChildProcess | undefined) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
};

it.skipIf(!desktop || !pack || !cache)(
  'executes native remote-server library jobs and refuses stale-source publication',
  async () => {
    let db: Kysely<DB> | undefined;
    let python: ChildProcess | undefined;
    let native: ChildProcess | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let heartbeatWork: Promise<void> = Promise.resolve();
    let heartbeatFailure: unknown;
    const abort = new AbortController();
    const root = await mkdtemp(join(await realpath(tmpdir()), 'frameleaf-native-nas-http-'));
    let http: Awaited<ReturnType<typeof controllerSetup>> | undefined;
    let tls: ReturnType<typeof createServer> | undefined;
    clearConfigCache();
    try {
      const manifestBytes = await readFile(join(pack!, 'manifest.json'));
      const runtime = JSON.parse(manifestBytes.toString('utf8'));
      if (process.env.FRAMELEAF_TEST_COREML_NAS === '1') {
        expect(workload).toBe('clip');
        expect(runtime).toMatchObject({ provider: 'CoreMLExecutionProvider', deviceObserver: { kind: 'metal-v1' } });
      }
      const moduleNamespace = runtime.moduleNamespace ?? 'immich_ml';
      expect(['immich_ml', 'frameleaf_ml']).toContain(moduleNamespace);
      const catalogue = JSON.parse(readFileSync('resources/desktop/model-catalogue.json', 'utf8'));
      parseDesktopModelCatalogue(catalogue);
      const profile = catalogue.profiles.find(
        (p: { workload: string; runtimeSourceRevision: string; spec: { fixtureKind: string; provider: string } }) =>
          p.runtimeSourceRevision === runtime.sourceRevision &&
          p.spec.provider === runtime.provider &&
          p.spec.fixtureKind === 'image' &&
          p.workload === workload,
      )!;
      expect(profile).toBeDefined();
      verifyDesktopRuntimeAttestation(
        {
          manifestGzipBase64: gzipSync(manifestBytes).toString('base64'),
          signatureBase64: (await readFile(join(pack!, 'manifest.sig'))).toString('base64'),
        },
        profile,
      );
      const image = Buffer.from(profile.fixtureBase64, 'base64');
      const path = join(root, 'synthetic.png');
      await writeFile(path, image, { mode: 0o600 });
      const mlPort = await port();
      const mlToken = randomBytes(32).toString('hex');
      const nasUrl = `http://127.0.0.1:${mlPort}`;
      if (!ocr) {
        const interpreter = join(pack!, 'payload', runtime.python);
        const executable = await readFile(interpreter);
        expect(executable.length).toBe(runtime.files[runtime.python].bytes);
        expect(createHash('sha256').update(executable).digest('hex')).toBe(runtime.files[runtime.python].sha256);
        python = spawn(
          interpreter,
          [
            '-I',
            '-B',
            '-c',
            `from ${moduleNamespace}.native_ort import configure; configure('CPUExecutionProvider'); import uvicorn; uvicorn.run('${moduleNamespace}.${face ? 'nas_app' : 'main'}:app',host='127.0.0.1',port=${mlPort},workers=1,access_log=False)`,
          ],
          {
            cwd: root,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {
              PATH: process.env.PATH,
              FRAMELEAF_ML_AUTH_TOKEN: mlToken,
              HF_HUB_OFFLINE: '1',
              TRANSFORMERS_OFFLINE: '1',
              MACHINE_LEARNING_MODEL_DOWNLOADS: 'false',
              MACHINE_LEARNING_ANN: 'false',
              MACHINE_LEARNING_RKNN: 'false',
              MACHINE_LEARNING_CACHE_FOLDER: cache!,
              MACHINE_LEARNING_MODEL_INTRA_OP_THREADS: '4',
              MACHINE_LEARNING_MODEL_INTER_OP_THREADS: '1',
              MACHINE_LEARNING_REQUEST_THREADS: '1',
              OMP_NUM_THREADS: '1',
              OPENBLAS_NUM_THREADS: '1',
              HF_HOME: join(root, 'hf'),
              TORCH_HOME: join(root, 'torch'),
              TMPDIR: root,
            },
          },
        );
        let pythonErrors = '';
        python.on('error', (error) => {
          pythonErrors = (pythonErrors + error.message).slice(-4096);
        });
        python.stderr?.on('data', (bytes) => {
          pythonErrors = (pythonErrors + String(bytes)).slice(-4096);
        });
        await vi.waitFor(
          async () => {
            expect(python!.exitCode, pythonErrors).toBeNull();
            expect((await fetch(`${nasUrl}/ping`)).ok).toBe(true);
          },
          { timeout: 30_000, interval: 200 },
        );
      }

      db = await getKyselyDB();
      for (const table of [
        'smart_search',
        'smart_search_description',
        'asset_video_duplicate_frame',
        'video_moment_frame_embedding',
      ])
        await sql`ALTER TABLE ${sql.table(table)} ALTER COLUMN embedding TYPE vector(768)`.execute(db);
      const { sut, ctx } = newMediumService(SmartInfoService, {
        database: db,
        real: [AssetRepository, AssetJobRepository, SearchRepository, SystemMetadataRepository, ConfigRepository],
        mock: [LoggingRepository, DatabaseRepository],
      });
      ctx.getMock(DatabaseRepository).isBusy.mockReturnValue(false);
      const metadata = ctx.get(SystemMetadataRepository);
      const configRepo = ctx.get(ConfigRepository);
      const config = {
        ...structuredClone(defaults),
        machineLearning: { ...structuredClone(defaults.machineLearning), urls: [nasUrl] },
      };
      if (automatic) {
        config.machineLearning.clip.enabled = workload === 'clip';
        config.machineLearning.ocr.enabled = ocr;
        config.machineLearning.facialRecognition.enabled = face;
      }
      await metadata.withConfigTransaction((metadataRepo) =>
        sut.updateConfig(config, { configRepo, metadataRepo, logger: LoggingRepository.create() }),
      );
      const password = randomBytes(32).toString('hex');
      const { user } = await ctx.newUser({
        isAdmin: !ocr,
        password: await ctx.get(CryptoRepository).hashBcrypt(password, 4),
      });
      const index = new DesktopClipIndexRepository(db);
      const routes = new MlDestinationRepository(db);
      Object.assign(sut, { mlDestinationRepository: routes });
      const destination = await routes.create({
        kind: MlDestinationKind.Lan,
        name: 'owned native fixture ML',
        url: nasUrl,
        authToken: mlToken,
        enabled: true,
        workloads: ocr ? [MlWorkload.Ocr, MlWorkload.Face] : [face ? MlWorkload.Face : MlWorkload.Clip],
        budgetLimitUsd: null,
        maxRuntimeMinutes: null,
        maxUploadBytes: null,
      });
      await routes.setDefaultRoute(face ? MlWorkload.Face : ocr ? MlWorkload.Ocr : MlWorkload.Clip, destination.id);
      if (ocr && !automatic) await routes.setDefaultRoute(MlWorkload.Face, destination.id);
      const ml = new MachineLearningRepository(LoggingRepository.create(), routes, configRepo, metadata, index);
      ml.setup(config.machineLearning);
      const broker = new DesktopMlRepository(db);
      const policies = new DesktopAssistancePolicyService(metadata);
      if (ocr) {
        const { user: administrator } = await ctx.newUser({ isAdmin: true });
        const { session } = await ctx.newSession({ userId: administrator.id });
        await policies.setMemberApproval({ user: administrator, session } as never, user.id, true);
      } else await policies.enable(user.id);
      const pool = new DesktopMlService(broker, index, policies, routes, ml);
      pool.onBootstrap();
      const workers = new DesktopWorkerRepository(db);
      const producer = new DesktopNasProducerService(ml, routes, index, configRepo, metadata);
      const auth = new DesktopWorkerAuthService(workers, metadata);
      const activation = new DesktopAssistanceActivationService(
        workers,
        index,
        producer,
        policies,
        metadata,
        routes,
        ml,
      );
      const qualification = new DesktopQualificationService(
        auth,
        new DesktopWorkerChallengeRepository(db),
        configRepo,
        metadata,
        producer,
        activation,
        workers,
        routes,
        policies,
      );
      const { sut: authentication } = newMediumService(AuthService, {
        database: db,
        real: [
          ConfigRepository,
          CryptoRepository,
          SessionRepository,
          SharedLinkRepository,
          SystemMetadataRepository,
          UserRepository,
        ],
        mock: [LoggingRepository],
      });
      http = await controllerSetup(
        [AuthController, DesktopDeviceController, DesktopWorkerController],
        [
          { provide: AuthService, useValue: authentication },
          {
            provide: DesktopDeviceService,
            useValue: new DesktopDeviceService(new DesktopDeviceRepository(db), metadata, policies),
          },
          { provide: DesktopWorkerAuthService, useValue: auth },
          { provide: DesktopAssistancePolicyService, useValue: policies },
          { provide: ConfigRepository, useValue: configRepo },
          { provide: DesktopWorkerService, useValue: new DesktopWorkerService(auth, broker, workers, pool) },
          { provide: DesktopQualificationService, useValue: qualification },
        ],
      );
      const parseJson = json({ limit: '10mb' }); // Match configureExpress's production report limit.
      tls = createServer(
        {
          key: readFileSync('test/fixtures/frameleaf-relay/tun.key.pem'),
          cert: readFileSync('test/fixtures/frameleaf-relay/tun.cert.pem'),
        },
        (request, response) => {
          if (!request.url?.startsWith('/api/')) {
            response.writeHead(404).end();
            return;
          }
          request.url = request.url.slice(4);
          parseJson(request, response, (error) => {
            if (error) {
              response.writeHead(error.status ?? 400).end();
              return;
            }
            http!.getHttpServer().emit('request', request, response);
          });
        },
      );
      await new Promise<void>((resolve) => tls!.listen(0, '127.0.0.1', resolve));
      const address = tls.address() as { port: number };

      const built = await promisify(execFile)(
        'cargo',
        ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--no-run', '--message-format=json'],
        { cwd: desktop!, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const artifact = built.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find(
          (item) =>
            item.reason === 'compiler-artifact' &&
            item.target.name === 'frameleaf_desktop' &&
            item.profile.test &&
            item.executable,
        );
      expect(artifact?.executable).toBeTruthy();
      native = spawn(
        artifact.executable,
        ['ml_transport::native_nas_tests::actual_native_nas_library_jobs', '--ignored', '--exact', '--nocapture'],
        {
          cwd: desktop!,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, FRAMELEAF_FACTORY_TEST_PACK: pack!, FRAMELEAF_FACTORY_MODEL_CACHE: cache! },
        },
      );
      const nativeExit = new Promise<number | null>((resolve) => {
        native!.once('exit', resolve);
        native!.once('error', () => resolve(-1));
      });
      let errors = '';
      native.stderr?.on('data', (bytes) => {
        errors = (errors + String(bytes)).slice(-8192);
      });
      const lines = createInterface({ input: native.stdout! })[Symbol.asyncIterator]();
      const message = async (prefix: string) => {
        const deadline = Date.now() + 900_000;
        while (true) {
          let timer: NodeJS.Timeout | undefined;
          const next = await Promise.race([
            lines.next(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('native fixture stage timed out')),
                Math.max(1, deadline - Date.now()),
              );
            }),
          ]).finally(() => clearTimeout(timer));
          if (next.done) throw new Error(`native fixture exited: ${errors}`);
          if (next.value.startsWith(prefix + ' ')) return JSON.parse(next.value.slice(prefix.length + 1));
        }
      };
      const identity = await message('NATIVE_IDENTITY');
      expect(await new DesktopDeviceRepository(db).list(user.id)).toHaveLength(0);
      native.stdin!.write(
        JSON.stringify({
          server: `https://tun.eu1.relays.frameleaf.test:${address.port}`,
          email: user.email,
          password,
          caPem: readFileSync('test/fixtures/frameleaf-relay/ca.cert.pem', 'utf8'),
          workRoot: join(root, 'desktop'),
        }) + '\n',
      );
      const signedIn = await message('NATIVE_SIGNED_IN');
      expect(signedIn.accountId).toBe(user.id);
      const devices = await new DesktopDeviceRepository(db).list(user.id);
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({
        id: signedIn.deviceId,
        installationId: identity.installationId,
        publicKey: identity.publicKey,
      });
      const session = await (db as Kysely<DB & DesktopWorkerTables>)
        .selectFrom('desktop_worker_session')
        .selectAll()
        .where('id', '=', signedIn.sessionId)
        .executeTakeFirstOrThrow();
      expect(session.deviceId).toBe(signedIn.deviceId);
      expect(await message('NATIVE_QUALIFIED')).toEqual({ roles: workload === 'clip' ? 3 : 1 });
      expect((await workers.session(session.id, session.tokenHash))!.modelKeys).toHaveLength(
        workload === 'clip' ? 3 : 1,
      );

      const jobs = new JobRepository({} as never, configRepo, {} as never, LoggingRepository.create(), db);
      const ocrFixture = ocr
        ? newMediumService(OcrService, {
            database: db,
            real: [AssetRepository, AssetJobRepository, ConfigRepository, OcrRepository, SystemMetadataRepository],
            mock: [LoggingRepository],
          })
        : undefined;
      const faceFixture = face
        ? newMediumService(PersonService, {
            database: db,
            real: [
              AssetRepository,
              AssetJobRepository,
              ConfigRepository,
              CryptoRepository,
              PersonRepository,
              SystemMetadataRepository,
            ],
            mock: [LoggingRepository],
          })
        : undefined;
      let existingFace: { faceId: string; embedding: string } | undefined;
      if (faceFixture) {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        const { assetFace } = await faceFixture.ctx.newAssetFace({ assetId: asset.id! });
        existingFace = { faceId: assetFace.id, embedding: JSON.stringify(Array.from({ length: 512 }, () => 0.125)) };
        await db.insertInto('face_search').values(existingFace).execute();
      }
      const handler = faceFixture?.sut ?? ocrFixture?.sut ?? sut;
      if (faceFixture)
        Object.assign(faceFixture.sut, {
          mlDestinationRepository: routes,
          machineLearningRepository: ml,
          jobRepository: jobs,
        });
      if (ocrFixture)
        Object.assign(ocrFixture.sut, {
          mlDestinationRepository: routes,
          machineLearningRepository: ml,
          jobRepository: jobs,
        });
      Object.assign(sut, { machineLearningRepository: ml, jobRepository: jobs });
      // Register this fixture's real follow-up without starting unrelated background executors.
      const followup = new Reflector().get(MetadataKey.JobConfig, SmartInfoService.prototype.handlePostprocessClip);
      jobs['handlers'][JobName.SmartSearchPostprocess] = {
        label: 'native-fixture-followup',
        jobName: JobName.SmartSearchPostprocess,
        queueName: followup.queue,
        handler: sut.handlePostprocessClip.bind(sut),
      };
      if (faceFixture) {
        const followup = new Reflector().get(MetadataKey.JobConfig, PersonService.prototype.handleRecognizeFaces);
        jobs['handlers'][JobName.FacialRecognition] = {
          label: 'native-face-fixture-followup',
          jobName: JobName.FacialRecognition,
          queueName: followup.queue,
          handler: faceFixture.sut.handleRecognizeFaces.bind(faceFixture.sut),
        };
      }
      const queue = face ? QueueName.FaceDetection : ocr ? QueueName.Ocr : QueueName.SmartSearch;
      const jobName = face ? JobName.AssetDetectFaces : ocr ? JobName.Ocr : JobName.SmartSearch;
      const store = new SqlQueueStore(db);
      const workerId = randomUUID();
      await store.initialize([queue], workerId);
      const search = ctx.get(SearchRepository);
      {
        const { asset } = await ctx.newAsset({
          ownerId: user.id,
          originalPath: path,
          checksum: createHash('sha1').update(image).digest(),
          fileModifiedAt: new Date('2020-01-01T00:00:00Z'),
        });
        await ctx.newAssetFile({ assetId: asset.id!, path, type: AssetFileType.Preview });
        if (face)
          await ctx.newExif({
            assetId: asset.id!,
            exifImageWidth: profile.spec.expectedOutput.imageWidth,
            exifImageHeight: profile.spec.expectedOutput.imageHeight,
          });
        await store.enqueue([
          {
            queue,
            name: jobName,
            data: { id: asset.id },
            safeToRetry: true,
            sensitive: false,
            deadlineMs: 120_000,
          },
        ]);
        const [claim] = await store.claim(queue, workerId, 1);
        expect(claim.name).toBe(jobName);
        const context: QueueExecution = {
          claim,
          signal: abort.signal,
          progress: () => {},
          followups: [],
          adoptions: [],
          buffering: false,
          progressUnits: 0,
        };
        heartbeat = setInterval(() => {
          heartbeatWork = heartbeatWork
            .then(() => store.heartbeat(workerId, [claim]))
            .catch((error: unknown) => {
              heartbeatFailure = error;
              abort.abort();
            });
        }, 10_000);
        const claiming = vi.spyOn(broker, 'claim');
        native.stdin!.write('{"command":"execute"}\n');
        await vi.waitFor(() => expect(claiming).toHaveBeenCalled(), { timeout: 30_000 });
        const prepared = queueExecution.run(context, () =>
          face
            ? (handler as PersonService).handleDetectFaces({ id: asset.id! })
            : ocr
              ? (handler as OcrService).handleOcr({ id: asset.id! })
              : sut.handleEncodeClip({ id: asset.id! }),
        );
        const executed = message('NATIVE_EXECUTED');
        expect(
          await Promise.race([
            executed,
            prepared.then((status) => {
              expect(status).toBe(JobStatus.Success);
              if (automatic) native!.stdin!.write('{"command":"complete"}\n');
              return executed;
            }),
          ]),
        ).toEqual({ iteration: 1 });
        expect(await prepared).toBe(JobStatus.Success);
        expect(await search.getEmbedding(asset.id!)).toBeUndefined();
        const publish = () =>
          store.complete(claim, context.followups, (tx) =>
            queueExecution.run(context, () =>
              publicationTransaction.run(tx, () =>
                jobs.collectFollowups(async () => {
                  for (const adopt of context.adoptions) await adopt(tx);
                }),
              ),
            ),
          );
        await db!
          .updateTable('asset')
          .set({ fileModifiedAt: new Date('2020-01-02T00:00:00Z') })
          .where('id', '=', asset.id!)
          .execute();
        await expect(publish()).rejects.toThrow('Asset inputs changed');
        if (face)
          expect(await db.selectFrom('asset_face').select('id').where('assetId', '=', asset.id!).execute()).toEqual([]);
        expect(await search.getEmbedding(asset.id!)).toBeUndefined();
        await db!
          .updateTable('asset')
          .set({ fileModifiedAt: asset.fileModifiedAt! })
          .where('id', '=', asset.id!)
          .execute();
        expect(await publish()).toBe(true);
        for (const after of context.afterCommit ?? []) await after();
        if (face) {
          const rows = await db
            .selectFrom('asset_face')
            .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
            .select(['asset_face.id', 'face_search.embedding'])
            .where('asset_face.assetId', '=', asset.id!)
            .execute();
          expect(rows).toHaveLength(profile.spec.expectedOutput['facial-recognition'].length);
          for (const [index, row] of rows.entries()) {
            const expected = JSON.parse(profile.spec.expectedOutput['facial-recognition'][index].embedding);
            const actual = JSON.parse(row.embedding);
            expect(actual).toHaveLength(512);
            for (const [i, value] of (actual as number[]).entries()) expect(value).toBeCloseTo(expected[i], 3);
          }
        } else if (ocr) {
          const rows = await db.selectFrom('asset_ocr').select('text').where('assetId', '=', asset.id!).execute();
          expect(rows.map((row) => row.text)).toEqual(profile.spec.expectedOutput.ocr.text);
          expect(python).toBeUndefined();
        } else {
          const row = await search.getEmbedding(asset.id!);
          expect(row?.producerModelKey).toBe(profile.modelKey);
          const actual: number[] = JSON.parse(row!.embedding);
          const expected: number[] = JSON.parse(profile.spec.expectedOutput.clip);
          expect(actual).toHaveLength(768);
          expect(actual).toHaveLength(expected.length);
          for (const [index, value] of actual.entries()) {
            expect(Number.isFinite(value)).toBe(true);
            expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(
              Math.max(1e-4, 1e-3 * Math.max(Math.abs(value), Math.abs(expected[index]))),
            );
          }
        }
        if (existingFace)
          expect(
            await db.selectFrom('face_search').selectAll().where('faceId', '=', existingFace.faceId).executeTakeFirst(),
          ).toEqual(existingFace);
        expect(
          (await db.selectFrom('job').select('state').where('id', '=', claim.id).executeTakeFirstOrThrow()).state,
        ).toBe('completed');
        clearInterval(heartbeat);
        heartbeat = undefined;
        await heartbeatWork;
        if (heartbeatFailure) throw heartbeatFailure;
      }
      expect(await nativeExit).toBe(0);
    } finally {
      abort.abort();
      clearInterval(heartbeat);
      await heartbeatWork;
      await stop(native);
      if (tls) {
        tls.closeAllConnections();
        await new Promise<void>((resolve) => tls!.close(() => resolve()));
      }
      await http?.close();
      await stop(python);
      await db?.destroy();
      clearConfigCache();
      await rm(root, { recursive: true, force: true });
    }
  },
  1_200_000,
);
