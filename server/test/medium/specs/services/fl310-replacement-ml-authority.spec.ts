import { sql } from 'kysely';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetRestorationMode } from 'src/dtos/asset-restoration.dto.js';
import { RESTORATION_PROTOCOL, RESTORATION_RESULT_HEADER } from 'src/dtos/restoration-inference.dto.js';
import { MlDestinationKind, MlWorkload, SystemMetadataKey } from 'src/enum.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { BuddyBackupRecoveryService } from 'src/services/buddy-backup-recovery.service.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { MlDestinationService } from 'src/services/ml-destination.service.js';
import { clearConfigCache, readConfig, withEffectiveConfigWrite } from 'src/utils/config.js';
import { recoveryAuthorityDigest, recoveryMlEndpointIdentity } from 'src/utils/recovery-ml-authority.js';
import { selectRestorationDestination } from 'src/utils/restoration.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

const execute = promisify(execFile);
const restoreArchive = (container: string, database: string, archive: Buffer) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      'docker',
      ['exec', '-i', container, 'pg_restore', '--clean', '--if-exists', '--no-owner', '-U', 'postgres', '-d', database],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Synthetic pg_restore failed: ${errors}`)),
    );
    child.stdin.end(archive);
  });

// Canonical PG19, actual full prepare/dump/restore, real HTTP and a separate fresh consumer process.
describe('FL310 replacement ML authority regression', () => {
  for (const { mode, collision } of [
    { mode: 'database', collision: false },
    { mode: 'file', collision: false },
    { mode: 'database', collision: true },
  ] as const) {
    it(`${mode}${collision ? '/UUID-collision' : ''}: recovered history cannot replace deployment-local ML authority`, async () => {
      const db = await getKyselyDB();
      const source = await getKyselyDB();
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'fl310-ml-authority-')));
      const marker = Buffer.from('FL310 synthetic media boundary; no private asset');
      const workers = await Promise.all(
        [0, 1].map(async () => {
          const bodies: Buffer[] = [];
          const requests: Array<{ path: string; replacementBearer: boolean; historicalBearer: boolean }> = [];
          let pending: { observed: () => void; release: Promise<void> } | undefined;
          const pauseNext = () => {
            const observed = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            pending = { observed: observed.resolve, release: release.promise };
            return { observed: observed.promise, release: release.resolve };
          };
          const server = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => {
              chunks.push(chunk);
            });
            request.on('error', () => {
              response.statusCode = 400;
              response.end();
            });
            request.on('end', () => {
              bodies.push(Buffer.concat(chunks));
              requests.push({
                path: request.url ?? '',
                replacementBearer: request.headers.authorization === 'Bearer synthetic-replacement-bearer',
                historicalBearer: request.headers.authorization === 'Bearer synthetic-foreign-bearer',
              });
              if (['/ping', '/capabilities', '/hardware'].includes(request.url ?? '')) {
                response.setHeader('content-type', 'application/json');
                if (request.url === '/hardware') response.statusCode = 404;
                response.end(JSON.stringify({ workloads: [MlWorkload.Enrichment] }));
                return;
              }
              const send = () => {
                response.setHeader('content-type', 'application/json');
                response.end(
                  JSON.stringify({
                    'semantic-mask': {
                      png: Buffer.from('synthetic-mask').toString('base64'),
                      coordinates: 'sensor-active',
                      width: 1,
                      height: 1,
                    },
                  }),
                );
              };
              if (pending) {
                const paused = pending;
                pending = undefined;
                paused.observed();
                void paused.release.then(send);
              } else send();
            });
          });
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
          });
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Expected loopback port');
          return { server, bodies, requests, pauseNext, url: `http://127.0.0.1:${address.port}` };
        }),
      );
      const replacement = workers[0].url;
      const historical = workers[1].url;
      const filename = join(directory, 'settings.json');
      const env = {
        ...mockEnvData({}),
        frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir: join(directory, 'identity') },
        ...(mode === 'file' && { configFile: filename }),
      };
      const configRepo = { getEnv: () => env } as ConfigRepository;
      const logger = LoggingRepository.create();
      const metadataRepo = new SystemMetadataRepository(db);
      const repos = { configRepo, logger, metadataRepo };
      try {
        clearConfigCache();
        const version = await sql<{ version: string }>`SHOW server_version_num`.execute(db);
        const versionNumber = Number(Object.values(version.rows[0])[0]);
        expect(versionNumber).toBeGreaterThanOrEqual(190_000);
        expect(versionNumber).toBeLessThan(200_000);
        console.info(JSON.stringify({ mode, serverVersionNumber: versionNumber }));
        StorageCore.setMediaLocation(directory);
        await db
          .deleteFrom('system_metadata')
          .where('key', 'in', [SystemMetadataKey.SystemConfig, SystemMetadataKey.EffectiveConfigEpoch])
          .execute();
        const replacementSettings = { machineLearning: { enabled: true, urls: [replacement] } };
        if (mode === 'file') await writeFile(filename, JSON.stringify(replacementSettings), { mode: 0o600 });
        else
          await withEffectiveConfigWrite(repos, ({ metadataRepo }) =>
            metadataRepo.set(SystemMetadataKey.SystemConfig, replacementSettings),
          );
        const initial = await readConfig(repos);
        const destinations = new MlDestinationRepository(db);
        const replacementRow = await destinations.create({
          kind: MlDestinationKind.Local,
          name: 'Replacement',
          url: replacement,
          authToken: null,
          enabled: true,
          workloads: [MlWorkload.Enrichment],
          budgetLimitUsd: 12,
          maxRuntimeMinutes: 3,
          maxUploadBytes: 1024,
          sharesLibraryHardware: true,
        });
        const replacementLanRow = await destinations.create({
          kind: MlDestinationKind.Lan,
          name: 'Replacement LAN',
          url: replacement,
          authToken: 'synthetic-replacement-bearer',
          enabled: true,
          workloads: [MlWorkload.Enrichment],
          budgetLimitUsd: null,
          maxRuntimeMinutes: null,
          maxUploadBytes: null,
        });
        await destinations.setRoute(MlWorkload.Enrichment, replacementRow.id);
        await destinations.setCloudModelChoice('upscale', 'replacement-synthetic-model');
        const replacementIdentity = await new InstanceIdentityRepository().loadOrCreate(
          env.frameleafCloud.identityDir,
          null,
        );
        await metadataRepo.set(SystemMetadataKey.FrameleafInstance, replacementIdentity);
        const replacementPrivateKey = await readFile(replacementIdentity.keyFile);
        const initialWorker = new MachineLearningRepository(logger, destinations, configRepo, metadataRepo);
        initialWorker.setup(initial.machineLearning);
        expect(initialWorker.getLocalUrls()).toEqual([replacement]);
        expect(await initialWorker.semanticMaskLocal(marker, 'subject')).toEqual(Buffer.from('synthetic-mask'));
        expect(workers[0].bodies[0].includes(marker)).toBe(true);

        const repository = new BuddyBackupRepository(db, configRepo);
        await repository.update((state) => ({
          ...state,
          settings: {
            directory: join(directory, 'vault'),
            quotaBytes: 1024 ** 3,
            uploadMbps: 20,
            downloadMbps: 20,
            schedule: '0 2 * * *',
            timezone: 'UTC',
            windowStart: '00:00',
            windowEnd: '00:00',
            pausedSending: true,
            pausedReceiving: false,
            includeDerived: false,
            configurationFiles: mode === 'file' ? [filename] : [],
          },
        }));
        const id = randomUUID();
        const recovery = join(repository.root(), 'recovery', id);
        await mkdir(join(recovery, 'objects'), { recursive: true });
        const historicalBytes = Buffer.from(
          JSON.stringify({
            machineLearning: { enabled: true, urls: [historical] },
            trash: { enabled: true },
            frameleafCloud: {
              cloudMl: {
                enabled: true,
                startWith: 'cloud',
                routing: {
                  descriptions: 'cloud',
                  upscale: 'cloud',
                  restoration: 'cloud',
                  studio: 'cloud',
                  interpolation: 'cloud',
                },
                autoDescribe: { enabled: true, dailyBudgetUsd: 5 },
              },
            },
          }),
        );
        const sha256 = createHash('sha256').update(historicalBytes).digest('hex');
        if (mode === 'file') await writeFile(join(recovery, 'objects', sha256), historicalBytes);
        const sourceMetadata = new SystemMetadataRepository(source);
        await sourceMetadata.withConfigTransaction((metadata) =>
          metadata.set(SystemMetadataKey.SystemConfig, JSON.parse(historicalBytes.toString())),
        );
        const sourceDestinations = new MlDestinationRepository(source);
        if (!collision) {
          await source
            .insertInto('ml_destination')
            .values({
              ...replacementRow,
              workloads: sql`${JSON.stringify([MlWorkload.Face])}::text::jsonb`,
              budgetLimitUsd: null,
              maxRuntimeMinutes: null,
              maxUploadBytes: null,
              sharesLibraryHardware: false,
            } as never)
            .execute();
        }
        const foreignRows = await Promise.all(
          [MlDestinationKind.Local, MlDestinationKind.Lan, MlDestinationKind.FrameleafCloud].map((kind) =>
            sourceDestinations.create({
              kind,
              name: `Historical ${kind}`,
              url: kind === MlDestinationKind.FrameleafCloud ? null : historical,
              authToken: kind === MlDestinationKind.Lan ? 'synthetic-foreign-bearer' : null,
              enabled: true,
              workloads: [MlWorkload.Enrichment],
              budgetLimitUsd: null,
              maxRuntimeMinutes: null,
              maxUploadBytes: null,
            }),
          ),
        );
        if (collision) {
          await sql`update ml_destination set id=${replacementRow.id}::uuid where id=${foreignRows[0].id}::uuid`.execute(
            source,
          );
          foreignRows[0].id = replacementRow.id;
        }
        const sourceGroup = await source
          .insertInto('cluster_group')
          .defaultValues()
          .returning('id')
          .executeTakeFirstOrThrow();
        const sourceUser = await source
          .insertInto('user')
          .values({
            email: `source-${randomUUID()}@example.test`,
            name: 'Historical synthetic consent owner',
            clusterGroupId: sourceGroup.id,
            isAdmin: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await sourceDestinations.update(foreignRows[2].id, {
          consentAcknowledgedAt: new Date(),
          consentAcknowledgedBy: sourceUser.id,
          consentVersion: '2026-09-25',
        });
        await sourceDestinations.setCloudModelChoice('upscale', 'historical-synthetic-model');
        const historicalAccounting = await source
          .insertInto('ml_workload_accounting')
          .values({
            destinationId: foreignRows[1].id,
            destinationKind: MlDestinationKind.Lan,
            workload: MlWorkload.Enrichment,
            jobId: 'synthetic-historical-job',
            jobName: 'synthetic-enrichment',
            outcome: 'success',
            costUsd: 0.25,
            startedAt: new Date(),
            finishedAt: new Date(),
            bytesSent: 128,
            bytesReceived: 16,
            durationMs: 25,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        for (const row of foreignRows)
          await sourceDestinations.recordProbe(row.id, {
            health: 'healthy' as never,
            summary: 'synthetic historical positive',
            workloads: [MlWorkload.Enrichment],
            probedAt: new Date(),
            latencyMs: 1,
            hardware: mlDestinationStub.frameleafCloudConsented.lastProbeHardware,
            cloud: mlDestinationStub.frameleafCloudConsented.lastProbeCloud,
          });
        await sourceDestinations.setRoute(MlWorkload.Enrichment, foreignRows[1].id);
        const connection = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
        const { stdout: containerOutput } = await execute('docker', [
          'ps',
          '--filter',
          `publish=${connection.port}`,
          '--format',
          '{{.ID}}',
        ]);
        const container = containerOutput.trim();
        expect(container).toMatch(/^[a-f0-9]+$/);
        const sourceName = (await sql<{ name: string }>`select current_database() as name`.execute(source)).rows[0]
          .name;
        const replacementName = (await sql<{ name: string }>`select current_database() as name`.execute(db)).rows[0]
          .name;
        const { stdout: plain } = await execute(
          'docker',
          ['exec', container, 'pg_dump', '-U', 'postgres', '-d', sourceName],
          { maxBuffer: 32 * 1024 * 1024 },
        );
        const { stdout: archive } = await execute(
          'docker',
          ['exec', container, 'pg_dump', '-Fc', '-U', 'postgres', '-d', sourceName],
          { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
        );
        const dump = gzipSync(Buffer.from(plain));
        await writeFile(join(recovery, 'database.sql.gz'), dump);
        const plan = {
          version: 1,
          scope: 'server',
          mode: 'replace',
          files: mode === 'file' ? [{ path: filename, sha256, size: historicalBytes.length }] : [],
          manifest: {
            version: 1,
            frameleafVersion: '2.6.0',
            storageRoot: directory,
            storageRoots: [directory],
            library: {
              database: {
                key: 'snapshot.sql.gz',
                sha256: createHash('sha256').update(dump).digest('hex'),
                size: dump.length,
              },
            },
            settings: { system: {}, users: [], fork: [] },
          },
        };
        await writeFile(join(recovery, 'prepared.json'), JSON.stringify(plan));
        const verification = { storageRepository: new StorageRepository(logger) } as unknown as DatabaseBackupService;
        const service = new BuddyBackupRecoveryService(
          repository,
          configRepo,
          {
            verifyDatabaseBackup: (path: string) =>
              DatabaseBackupService.prototype.verifyDatabaseBackup.call(verification, path),
          } as DatabaseBackupService,
          new CloudBackupKeyRepository(logger),
        );
        await service.prepare(id, async () => {});
        const captured = await readFile(join(recovery, 'replacement-ml.json'));
        await service.prepare(id, async () => {});
        expect(await readFile(join(recovery, 'replacement-ml.json'))).toEqual(captured);
        const databaseRestore = vi.fn(() => restoreArchive(container, replacementName, archive));
        const maintenance = {
          isMaintenanceMode: true,
          action: { restoreBackupFilename: `buddy-restore-${id}-snapshot.sql.gz` },
        } as never;
        const capturePath = join(recovery, 'replacement-ml.json');
        await rm(capturePath);
        await expect(service.restore(id, databaseRestore, maintenance, async () => {})).rejects.toThrow(
          'replacement_ml_authority',
        );
        await writeFile(capturePath, '{"malformed":"synthetic-private-value"}', { mode: 0o600 });
        await expect(service.restore(id, databaseRestore, maintenance, async () => {})).rejects.toThrow(
          'replacement_ml_authority',
        );
        await writeFile(capturePath, captured, { mode: 0o600 });
        await expect(
          service.restore(id, databaseRestore, maintenance, () => Promise.reject(new Error('synthetic revoked lease'))),
        ).rejects.toThrow('synthetic revoked lease');
        expect(databaseRestore).not.toHaveBeenCalled();
        if (collision) {
          await expect(service.restore(id, databaseRestore, maintenance, async () => {})).rejects.toThrow(
            'replacement_ml_authority',
          );
          expect(databaseRestore).toHaveBeenCalledTimes(1);
          expect(await readFile(join(recovery, 'database-pending'), 'utf8')).toBe('1');
          expect(await metadataRepo.get(SystemMetadataKey.FrameleafRecoveryMlAuthority)).toBeNull();
          expect((await destinations.getById(replacementRow.id))!.url).toBe(historical);
          expect(
            JSON.parse(await readFile(join(recovery, 'historical-ml.json'), 'utf8')).destinations.some(
              (row: { id: string; url: string }) => row.id === replacementRow.id && row.url === historical,
            ),
          ).toBe(true);
          expect(workers[1].bodies).toHaveLength(0);
          if (process.env.FL310_PROOF_DIR) {
            await mkdir(process.env.FL310_PROOF_DIR, { recursive: true });
            await writeFile(
              join(process.env.FL310_PROOF_DIR, 'collision.json'),
              JSON.stringify(
                {
                  sourceManifestSha: process.env.FL310_SOURCE_MANIFEST_SHA,
                  mode,
                  serverVersionNumber: versionNumber,
                  actualPgRestoreCalls: databaseRestore.mock.calls.length,
                  unresolvedUuidCollisionRefused: true,
                  historicalRequests: workers[1].bodies.length,
                  databasePending: await readFile(join(recovery, 'database-pending'), 'utf8'),
                },
                null,
                2,
              ),
            );
          }
          return;
        }
        await service.restore(
          id,
          databaseRestore,
          {
            isMaintenanceMode: true,
            action: { restoreBackupFilename: `buddy-restore-${id}-snapshot.sql.gz` },
          } as never,
          async () => {},
        );
        expect(databaseRestore).toHaveBeenCalledTimes(1);
        if (mode === 'file') expect(await readFile(filename)).toEqual(historicalBytes);
        else
          expect(await metadataRepo.get(SystemMetadataKey.SystemConfig)).toMatchObject({
            machineLearning: { urls: [historical] },
          });
        clearConfigCache();
        const freshConfigRepo = { getEnv: () => env } as ConfigRepository;
        const freshConfig = await readConfig({ ...repos, configRepo: freshConfigRepo });
        expect(freshConfig.frameleafCloud.cloudMl).toEqual(initial.frameleafCloud.cloudMl);
        const worker = new MachineLearningRepository(logger, destinations, freshConfigRepo, metadataRepo);
        worker.setup(freshConfig.machineLearning);
        expect(await worker.semanticMaskLocal(marker, 'subject')).toEqual(Buffer.from('synthetic-mask'));
        console.info(
          JSON.stringify({
            mode,
            recoveredLocalUrls: worker.getLocalUrls(),
            replacementRequests: workers[0].bodies.length,
            replacementRequestDetails: workers[0].requests,
            historicalRequests: workers[1].bodies.length,
            historicalReceivedSyntheticMedia: workers[1].bodies.some((body) => body.includes(marker)),
          }),
        );
        expect(workers[1].bodies).toHaveLength(0);
        expect(workers[0].bodies).toHaveLength(2);
        expect(worker.getLocalUrls()).toEqual([replacement]);
        const restartUrl = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
        restartUrl.pathname = `/${replacementName}`;
        const { stdout: restarted } = await execute(
          process.execPath,
          ['--import', 'tsx', fileURLToPath(new URL('../../fixtures/fl310-ml-consumer.ts', import.meta.url))],
          {
            env: {
              ...process.env,
              IMMICH_TEST_POSTGRES_URL: restartUrl.href,
              FRAMELEAF_CONFIG_FILE: mode === 'file' ? filename : undefined,
              IMMICH_CONFIG_FILE: undefined,
              FRAMELEAF_LOG_LEVEL: 'fatal',
            },
          },
        );
        expect(restarted).toContain('"freshProcess":true');
        expect(restarted).toContain(replacement);
        const { stdout: applicationRestart } = await execute(
          process.execPath,
          [fileURLToPath(new URL('../../fixtures/fl310-ml-app-restart.mjs', import.meta.url))],
          {
            timeout: 45_000,
            maxBuffer: 1024 * 1024,
            env: {
              ...process.env,
              DB_URL: restartUrl.href,
              FRAMELEAF_CONFIG_FILE: mode === 'file' ? filename : undefined,
              IMMICH_CONFIG_FILE: undefined,
              FRAMELEAF_MEDIA_LOCATION: directory,
              FRAMELEAF_IDENTITY_DIR: env.frameleafCloud.identityDir,
              FRAMELEAF_LOG_LEVEL: 'fatal',
              FRAMELEAF_BUDDY_BACKUP_BOOT_BINDING: undefined,
            },
          },
        );
        const applicationProof = JSON.parse(
          applicationRestart.split('\n').find((line) => line.includes('"fullNestApiBootstrap":true'))!,
        );
        expect(applicationProof.fullNestApiBootstrap).toBe(true);
        expect(applicationProof.foreignFetchAttempts).toBe(0);
        expect((await readFile(replacementIdentity.keyFile)).equals(replacementPrivateKey)).toBe(true);

        expect(workers[0].bodies).toHaveLength(4);
        expect(workers[1].bodies).toHaveLength(0);
        const registry = await metadataRepo.get(SystemMetadataKey.FrameleafRecoveryMlAuthority);
        expect(Object.keys(registry!.quarantine).sort()).toEqual(foreignRows.map((row) => row.id).sort());
        expect((await destinations.getRoute(MlWorkload.Enrichment))!.destinationId).toBe(replacementRow.id);
        expect(await destinations.getById(replacementRow.id)).toMatchObject({
          id: replacementRow.id,
          url: replacementRow.url,
          authToken: replacementRow.authToken,
          workloads: [MlWorkload.Enrichment],
          budgetLimitUsd: 12,
          maxRuntimeMinutes: 3,
          maxUploadBytes: 1024,
          sharesLibraryHardware: true,
        });
        expect(await destinations.getCloudModelChoice('upscale')).toBe('replacement-synthetic-model');
        expect(
          await db
            .selectFrom('ml_workload_accounting')
            .selectAll()
            .where('id', '=', historicalAccounting.id)
            .executeTakeFirst(),
        ).toEqual(historicalAccounting);
        expect((await destinations.getById(foreignRows[2].id))!.consentAcknowledgedBy).toBe(sourceUser.id);
        expect((await destinations.getById(foreignRows[2].id))!.consentVersion).toBe('2026-09-25');

        const destinationService = Object.create(MlDestinationService.prototype) as MlDestinationService;
        Object.assign(destinationService, { mlDestinationRepository: destinations, machineLearningRepository: worker });
        expect((await destinationService.probe(replacementLanRow.id)).status).toBe('healthy');
        expect(
          workers[0].requests.filter((request) => request.replacementBearer).map((request) => request.path),
        ).toEqual(['/ping', '/capabilities', '/hardware']);
        expect(workers[0].requests.some((request) => request.historicalBearer)).toBe(false);

        const cachedEndpoint = { url: replacement, authToken: 'synthetic-replacement-bearer' };
        const cachedRequests = workers[0].requests.length;
        await worker.probe(cachedEndpoint, { maxAgeMs: 10_000 });
        expect(workers[0].requests).toHaveLength(cachedRequests);
        for (const patch of [{ budgetLimitUsd: 9 }, { consentVersion: 'synthetic-current-consent' }]) {
          await destinations.update(replacementLanRow.id, patch);
          const before = workers[0].requests.length;
          await worker.probe(cachedEndpoint, { maxAgeMs: 10_000 });
          expect(workers[0].requests).toHaveLength(before + 3);
          await worker.probe(cachedEndpoint, { maxAgeMs: 10_000 });
          expect(workers[0].requests).toHaveLength(before + 3);
        }

        // Actual PG authority transitions while a valid real HTTP restoration body is paused.
        // The model-readiness probe is a qualified fixture; no model/GPU/provider is contacted.
        const restoredBytes = Buffer.from('synthetic restored video');
        let delayed: { observed: () => void; release: Promise<void>; requestId: string } | undefined;
        let restorationRequests = 0;
        const restorationServer = createServer((request, response) => {
          request.resume();
          request.on('end', () => {
            if (!delayed) {
              response.statusCode = 400;
              response.end();
              return;
            }
            const current = delayed;
            delayed = undefined;
            restorationRequests++;
            response.writeHead(200, {
              'content-type': 'video/mp4',
              [RESTORATION_RESULT_HEADER]: Buffer.from(
                JSON.stringify({
                  protocol: RESTORATION_PROTOCOL,
                  requestId: current.requestId,
                  mode: 'faithful',
                  model: {
                    id: 'realbasicvsr-x4',
                    family: 'realbasicvsr',
                    mode: 'faithful',
                    revision: '0123456789abcdef0123456789abcdef01234567',
                    fingerprint: 'a'.repeat(64),
                    weights: [{ role: 'generator', sha256: 'b'.repeat(64) }],
                    qualificationId: 'synthetic-qualified-model',
                  },
                  output: {
                    width: 1280,
                    height: 720,
                    frameRate: '30/1',
                    frameCount: 150,
                    durationMs: 5000,
                    container: 'mp4',
                    codec: 'h264',
                    dynamicRange: 'sdr',
                    bitDepth: 8,
                    audio: 'copied',
                    bytes: restoredBytes.length,
                    sha256: createHash('sha256').update(restoredBytes).digest('hex'),
                  },
                  timing: { decodeMs: 10, runtimeMs: 1000, encodeMs: 20, totalMs: 1100, framesPerSecond: 150 },
                  peakVramBytes: null,
                  seed: 0,
                  warnings: [],
                }),
              ).toString('base64url'),
            });
            response.write(restoredBytes.subarray(0, 1));
            current.observed();
            void current.release.then(() => response.end(restoredBytes.subarray(1)));
          });
        });
        restorationServer.listen(0, '127.0.0.1');
        await once(restorationServer, 'listening');
        const restorationAddress = restorationServer.address();
        if (!restorationAddress || typeof restorationAddress === 'string')
          throw new Error('Expected owned restoration server');
        const restorationUrl = `http://127.0.0.1:${restorationAddress.port}`;
        const restorationRow = await destinations.create({
          kind: MlDestinationKind.Lan,
          name: 'Synthetic restoration',
          url: restorationUrl,
          authToken: null,
          enabled: true,
          workloads: [MlWorkload.RestorationFaithful],
          budgetLimitUsd: null,
          maxRuntimeMinutes: null,
          maxUploadBytes: null,
        });
        const sourcePath = join(directory, 'synthetic-original.mp4');
        await writeFile(sourcePath, marker);
        try {
          for (const transition of ['disable', 'quarantine', 'rebind']) {
            const outputPath = join(directory, `${transition}.mp4`);
            const observed = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            delayed = {
              observed: observed.resolve,
              release: release.promise,
              requestId: `synthetic-${transition}:${transition}.mp4`,
            };
            const selected = await selectRestorationDestination(
              {
                mlDestinationRepository: destinations,
                machineLearningRepository: {
                  probe: vi.fn().mockResolvedValue(mlProbeStub.restoration),
                } as unknown as MachineLearningRepository,
              },
              {
                mode: AssetRestorationMode.Faithful,
                destinationId: restorationRow.id,
                jobId: `synthetic-${transition}`,
                acknowledgeCloudUpload: false,
              },
            );
            const record = vi.spyOn(selected, 'record');
            const pendingRestore = worker.restore(
              selected,
              { kind: 'video', path: sourcePath, width: 640, height: 360, durationSeconds: 5 },
              {
                mode: AssetRestorationMode.Faithful,
                upscale: 2,
                keepGrain: false,
                maxWidth: 1280,
                maxHeight: 720,
                outputPath,
                jobId: `synthetic-${transition}`,
                signal: new AbortController().signal,
              },
            );
            const assertion = expect(pendingRestore).rejects.toThrow('authority');
            await observed.promise;
            const beforeRegistry = (await destinations.recoveryRegistry())!;
            if (transition === 'quarantine')
              await metadataRepo.withConfigTransaction((metadata) =>
                metadata.set(SystemMetadataKey.FrameleafRecoveryMlAuthority, {
                  ...beforeRegistry,
                  quarantine: {
                    ...beforeRegistry.quarantine,
                    [restorationRow.id]: recoveryMlEndpointIdentity(restorationRow),
                  },
                }),
              );
            else
              await destinations.update(
                restorationRow.id,
                transition === 'disable' ? { enabled: false } : { authToken: 'synthetic-rebound' },
              );
            release.resolve();
            await assertion;
            expect(existsSync(outputPath)).toBe(false);
            expect(await readFile(sourcePath)).toEqual(marker);
            expect(record).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
            expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
            record.mockRestore();
            await destinations.update(restorationRow.id, { enabled: true, authToken: null });
            await metadataRepo.withConfigTransaction((metadata) =>
              metadata.set(SystemMetadataKey.FrameleafRecoveryMlAuthority, beforeRegistry),
            );
          }
          expect(restorationRequests).toBe(3);
        } finally {
          restorationServer.closeAllConnections();
          await new Promise<void>((resolve) => restorationServer.close(() => resolve()));
          await destinations.delete(restorationRow.id);
        }

        for (const row of foreignRows) {
          await expect(destinationService.probe(row.id)).rejects.toThrow('replacement_ml_authority');
          await expect(destinationService.getRestorationModels(row.id)).rejects.toThrow('replacement_ml_authority');
          expect(await destinations.getById(row.id)).toMatchObject({
            id: row.id,
            url: row.url,
            authToken: row.authToken,
            enabled: false,
          });
          await expect(destinations.assertRecoveryAuthority((await destinations.getById(row.id))!)).rejects.toThrow(
            'replacement_ml_authority',
          );
          await expect(
            worker.probe({
              url: row.url ?? 'frameleaf-cloud:gateway',
              authToken: row.authToken ?? undefined,
              ...(row.kind === MlDestinationKind.FrameleafCloud && { cloud: true }),
            }),
          ).rejects.toThrow('replacement_ml_authority');
        }
        expect(workers[1].bodies).toHaveLength(0);
        const paused = workers[0].pauseNext();
        const lateMask = worker.semanticMaskLocal(marker, 'subject');
        await paused.observed;
        await destinations.update(replacementRow.id, { enabled: false });
        paused.release();
        await expect(lateMask).rejects.toThrow('replacement_ml_authority');
        await destinations.update(replacementRow.id, { enabled: true });
        const beforeEpoch = await metadataRepo.getEffectiveConfigEpoch();
        const malformedEpoch = {
          ...beforeEpoch!,
          recoveryMlBinding: { ...beforeEpoch!.recoveryMlBinding!, format: 2 },
        };
        await sql`update system_metadata set value=${JSON.stringify(malformedEpoch)}::text::jsonb
          where key=${SystemMetadataKey.EffectiveConfigEpoch}`.execute(db);
        clearConfigCache();
        await expect(readConfig(repos)).rejects.toThrow('replacement_ml_authority');
        await expect(
          destinations.assertRecoveryAuthority((await destinations.getById(replacementRow.id))!),
        ).rejects.toThrow('replacement_ml_authority');
        await metadataRepo.withConfigTransaction((metadata) =>
          metadata.set(SystemMetadataKey.EffectiveConfigEpoch, beforeEpoch!),
        );

        await service.restore(
          id,
          databaseRestore,
          {
            isMaintenanceMode: true,
            action: { restoreBackupFilename: `buddy-restore-${id}-snapshot.sql.gz` },
          } as never,
          async () => {},
        );
        expect(await metadataRepo.getEffectiveConfigEpoch()).toEqual(beforeEpoch);
        await sql`delete from system_metadata where key=${SystemMetadataKey.FrameleafRecoveryMlAuthority}`.execute(db);
        await expect(service.restore(id, databaseRestore, maintenance, async () => {})).rejects.toThrow(
          'replacement_ml_authority',
        );
        expect(databaseRestore).toHaveBeenCalledTimes(1);
        await metadataRepo.withConfigTransaction((metadata) =>
          metadata.set(SystemMetadataKey.FrameleafRecoveryMlAuthority, registry!),
        );

        expect(await readFile(join(recovery, 'replacement-ml.json'))).toEqual(captured);
        expect(
          recoveryAuthorityDigest(JSON.parse(await readFile(join(recovery, 'historical-ml.json'), 'utf8'))),
        ).toMatch(/^[a-f0-9]{64}$/);
        const column = await sql<{ type: string }>`select format_type(a.atttypid,a.atttypmod) as type
          from pg_attribute a where a.attrelid='public.system_metadata'::regclass and a.attname='key'`.execute(db);
        expect(column.rows[0].type).toBe('character varying');
        console.info(
          JSON.stringify({
            mode,
            metadataKeyType: column.rows[0].type,
            fullPrepare: true,
            pgRestore: true,
            freshProcess: true,
            fullNestApiBootstrap: true,
            foreignFetchAttempts: 0,
            replacementPrivateKeyUnchanged: true,
            replacementRequests: workers[0].bodies.length,
            foreignRequests: workers[1].bodies.length,
          }),
        );
        // The established publication journal makes rollback terminal: a new staged recovery is required.
        const failureId = randomUUID();
        const failureDirectory = join(repository.root(), 'recovery', failureId);
        await mkdir(join(failureDirectory, 'objects'), { recursive: true });
        await writeFile(join(failureDirectory, 'prepared.json'), JSON.stringify(plan));
        await writeFile(join(failureDirectory, 'database.sql.gz'), dump);
        if (mode === 'file') await writeFile(join(failureDirectory, 'objects', sha256), historicalBytes);
        await service.prepare(failureId, async () => {});
        const secondCapture = JSON.parse(await readFile(join(failureDirectory, 'replacement-ml.json'), 'utf8'));
        expect(secondCapture.destinations.map((row: { id: string }) => row.id).sort()).toEqual(
          [replacementRow.id, replacementLanRow.id].sort(),
        );
        const priorFailureEpoch = await metadataRepo.getEffectiveConfigEpoch();
        const priorFailureRegistry = await metadataRepo.get(SystemMetadataKey.FrameleafRecoveryMlAuthority);
        const failedDatabase = vi.fn(() => Promise.reject(new Error('synthetic database interruption')));
        const failedMaintenance = {
          isMaintenanceMode: true,
          action: { restoreBackupFilename: `buddy-restore-${failureId}-snapshot.sql.gz` },
        } as never;
        await expect(service.restore(failureId, failedDatabase, failedMaintenance, async () => {})).rejects.toThrow(
          'synthetic database interruption',
        );
        expect(await metadataRepo.getEffectiveConfigEpoch()).toEqual(priorFailureEpoch);
        expect(await metadataRepo.get(SystemMetadataKey.FrameleafRecoveryMlAuthority)).toEqual(priorFailureRegistry);
        if (mode === 'file') expect(await readFile(filename)).toEqual(historicalBytes);
        await expect(service.restore(failureId, failedDatabase, failedMaintenance, async () => {})).rejects.toThrow(
          'Stage a new recovery after rollback',
        );
        const group = await db.insertInto('cluster_group').defaultValues().returning('id').executeTakeFirstOrThrow();
        const user = await db
          .insertInto('user')
          .values({
            email: `synthetic-${randomUUID()}@example.test`,
            name: 'Synthetic admin',
            clusterGroupId: group.id,
            isAdmin: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const session = await db
          .insertInto('session')
          .values({
            token: Buffer.from('synthetic-session'),
            userId: user.id,
            expiresAt: new Date(Date.now() + 60_000),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const auth = { user, session } as unknown as AuthDto;
        const foreign = (await destinations.getById(foreignRows[1].id))!;
        await expect(
          destinations.updateRecoveryBinding(auth, foreign, { name: 'Rename cannot grant authority' }),
        ).rejects.toThrow('replacement_ml_authority');
        await expect(
          destinations.updateRecoveryBinding(auth, foreign, { enabled: true, url: replacement }),
        ).rejects.toThrow('replacement_ml_authority');
        const beforeCachedClear = workers[0].requests.length;
        await worker.probe({ url: replacement }, { maxAgeMs: 10_000 });
        expect(workers[0].requests).toHaveLength(beforeCachedClear + 3);
        await worker.probe({ url: replacement }, { maxAgeMs: 10_000 });
        expect(workers[0].requests).toHaveLength(beforeCachedClear + 3);
        const admitted = await destinations.updateRecoveryBinding(auth, foreign, {
          enabled: true,
          url: replacement,
          authToken: null,
        });
        expect((await destinations.recoveryRegistry())!.quarantine[foreign.id]).toBeUndefined();
        await destinations.assertRecoveryAuthority(admitted);
        const beforeClearProbe = workers[0].requests.length;
        await worker.probe({ url: replacement }, { maxAgeMs: 10_000 });
        expect(workers[0].requests).toHaveLength(beforeClearProbe + 3);
        const stale = await destinations.getById(admitted.id);
        await destinations.update(admitted.id, { url: historical });
        await expect(
          destinations.recordProbe(
            admitted.id,
            {
              health: 'healthy' as never,
              summary: 'late synthetic reply',
              workloads: [MlWorkload.Enrichment],
              probedAt: new Date(),
            },
            stale!,
          ),
        ).rejects.toThrow('replacement_ml_authority');
        expect((await destinations.getById(admitted.id))!.lastProbeSummary).not.toBe('late synthetic reply');
        const { promise: acquired, resolve: lockedC1 } = Promise.withResolvers<void>();
        const { promise: release, resolve: releaseC1 } = Promise.withResolvers<void>();
        const blocker = metadataRepo.withConfigTransaction(async () => {
          lockedC1();
          await release;
        });
        await acquired;
        const waiting = destinations.updateRecoveryBinding(auth, (await destinations.getById(foreignRows[0].id))!, {
          enabled: true,
          url: replacement,
        });
        await db.deleteFrom('session').where('id', '=', session.id).execute();
        releaseC1();
        await blocker;
        await expect(waiting).rejects.toThrow('replacement_ml_authority');
        const untouched = (await destinations.getById(foreignRows[0].id))!;
        await expect(
          destinations.updateRecoveryBinding(auth, untouched, { enabled: true, url: replacement }),
        ).rejects.toThrow('replacement_ml_authority');
        expect((await destinations.recoveryRegistry())!.quarantine[untouched.id]).toBeDefined();
        expect(workers[0].bodies).toHaveLength(20);
        expect(workers[1].bodies).toHaveLength(0);
        if (process.env.FL310_PROOF_DIR) {
          await mkdir(process.env.FL310_PROOF_DIR, { recursive: true });
          await writeFile(
            join(process.env.FL310_PROOF_DIR, `${mode}.json`),
            JSON.stringify(
              {
                sourceManifestSha: process.env.FL310_SOURCE_MANIFEST_SHA,
                mode,
                serverVersionNumber: versionNumber,
                metadataKeyType: column.rows[0].type,
                fullPrepare: true,
                actualPgRestoreCalls: databaseRestore.mock.calls.length,
                freshProcess: JSON.parse(restarted.split('\n').find((line) => line.includes('"freshProcess":true'))!),
                applicationRestart: applicationProof,
                replacementRequests: workers[0].bodies.length,
                replacementRequestDetails: workers[0].requests,
                historicalRequests: workers[1].bodies.length,
                historicalReceivedSyntheticMedia: workers[1].bodies.some((body) => body.includes(marker)),
                replacementPrivateKeyUnchanged: (await readFile(replacementIdentity.keyFile)).equals(
                  replacementPrivateKey,
                ),
                historyAccountingIdPreserved:
                  (
                    await db
                      .selectFrom('ml_workload_accounting')
                      .select('destinationId')
                      .where('id', '=', historicalAccounting.id)
                      .executeTakeFirst()
                  )?.destinationId === foreignRows[1].id,
                currentQuarantineCount: Object.keys((await destinations.recoveryRegistry())!.quarantine).length,
                delayedRestorationRequests: restorationRequests,
                delayedRestorationTransitionsRefused: ['disable', 'quarantine', 'rebind'],
              },
              null,
              2,
            ),
          );
        }
      } finally {
        clearConfigCache();
        await Promise.all(
          workers.map(
            ({ server }) =>
              new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeAllConnections();
              }),
          ),
        );
        await db.destroy();
        await source.destroy();
        await rm(directory, { recursive: true, force: true });
      }
    }, 90_000);
  }
});
