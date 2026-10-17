import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { SystemMetadataKey } from 'src/enum.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { BuddyBackupRecoveryService } from 'src/services/buddy-backup-recovery.service.js';
import { SystemConfigService } from 'src/services/system-config.service.js';
import { buddyFileHash } from 'src/utils/buddy-backup-recovery.js';
import {
  activateFileConfig,
  clearConfigCache,
  prepareFileActivation,
  publishFileConfig,
  readConfig,
  updateConfig,
  withEffectiveConfigWrite,
} from 'src/utils/config.js';
import { recoveryAuthorityDigest } from 'src/utils/recovery-ml-authority.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

describe('FL310 C1 recovery authority and settings policy on canonical PG', () => {
  for (const mode of ['database', 'file'] as const)
    for (const choice of ['keep', 'replace'] as const) {
      it(`${mode}/${choice}: retains dependency authority, raw history, quarantine and activation CAS`, async () => {
        const db = await getKyselyDB();
        const directory = await realpath(await mkdtemp(join(tmpdir(), 'fl310-config-authority-')));
        try {
          clearConfigCache();
          StorageCore.setMediaLocation(directory);
          const filename = join(directory, 'settings.json');
          const env = {
            ...mockEnvData({}),
            ...(mode === 'file' && { configFile: filename }),
            frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir: join(directory, 'identity') },
          };
          const configRepo = { getEnv: () => env } as ConfigRepository;
          const logger = LoggingRepository.create();
          const metadataRepo = new SystemMetadataRepository(db);
          const repos = { metadataRepo, configRepo, logger };
          const local = {
            machineLearning: { enabled: true, urls: ['http://127.0.0.1:12345'] },
            trash: { enabled: false },
          };
          const old = {
            machineLearning: { enabled: true, urls: ['http://127.0.0.1:12346'] },
            trash: { enabled: true },
          };
          if (mode === 'file') await writeFile(filename, JSON.stringify(local), { mode: 0o600 });
          else
            await withEffectiveConfigWrite(repos, ({ metadataRepo }) =>
              metadataRepo.set(SystemMetadataKey.SystemConfig, local),
            );
          await readConfig(repos);
          await metadataRepo.set(SystemMetadataKey.FrameleafInstance, {
            instanceId: randomUUID(),
            kid: 'replacement-test',
            publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'synthetic-public' },
            keyFile: 'synthetic-private-path',
            createdAt: new Date().toISOString(),
          });
          const foreignId = randomUUID();
          await withEffectiveConfigWrite(repos, ({ metadataRepo }) =>
            metadataRepo.set(SystemMetadataKey.FrameleafRecoveryMlAuthority, {
              format: 1,
              recoveryId: randomUUID(),
              preparedPlanDigest: 'a'.repeat(64),
              replacementIdentity: 'b'.repeat(64),
              quarantine: { [foreignId]: 'c'.repeat(64) },
            }),
          );
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
          const historicalBytes = Buffer.from(JSON.stringify(old));
          const object = join(recovery, 'historical.json');
          await writeFile(object, historicalBytes);
          const evidence = await buddyFileHash(object);
          if (mode === 'file') await writeFile(join(recovery, 'objects', evidence.sha256), historicalBytes);
          await writeFile(
            join(recovery, 'prepared.json'),
            JSON.stringify({
              version: 1,
              scope: 'settings',
              mode: choice,
              files: mode === 'file' && choice === 'replace' ? [{ path: filename, ...evidence }] : [],
              manifest: {
                version: 1,
                frameleafVersion: '2.6.0',
                storageRoot: directory,
                storageRoots: [directory],
                library: {},
                settings: { system: old, users: [], fork: [] },
              },
            }),
          );
          const service = new BuddyBackupRecoveryService(
            repository,
            configRepo,
            {} as never,
            new CloudBackupKeyRepository(logger),
          );
          await service.settings(id, async () => {});
          const captured = await readFile(join(recovery, 'replacement-ml.json'));
          const epoch = await metadataRepo.getEffectiveConfigEpoch();
          const result = await readConfig(repos);
          expect(result.machineLearning.urls).toEqual(local.machineLearning.urls);
          expect(result.trash.enabled).toBe(choice === 'replace');
          expect((await metadataRepo.get(SystemMetadataKey.FrameleafRecoveryMlAuthority))!.quarantine).toEqual({
            [foreignId]: 'c'.repeat(64),
          });
          await service.settings(id, async () => {});
          expect(await readFile(join(recovery, 'replacement-ml.json'))).toEqual(captured);
          expect(await metadataRepo.getEffectiveConfigEpoch()).toEqual(epoch);
          if (mode === 'file') {
            expect(await readFile(filename)).toEqual(
              choice === 'replace' ? historicalBytes : Buffer.from(JSON.stringify(local)),
            );
            const bytes = JSON.parse(await readFile(filename, 'utf8'));
            bytes.trash.enabled = !bytes.trash.enabled;
            await writeFile(filename, JSON.stringify(bytes));
            const prepared = await prepareFileActivation(repos);
            expect(prepared.candidate.machineLearning.urls).toEqual(local.machineLearning.urls);
            const next = await withEffectiveConfigWrite(repos, (bound) =>
              activateFileConfig(bound, prepared.candidate, epoch!.epoch, prepared),
            );
            publishFileConfig(repos, prepared.candidate, next);
            expect(next.recoveryMl).toBeDefined();
            const stale = await prepareFileActivation(repos);
            bytes.trash.enabled = !bytes.trash.enabled;
            await writeFile(filename, JSON.stringify(bytes));
            await expect(
              withEffectiveConfigWrite(repos, (bound) => activateFileConfig(bound, stale.candidate, next.epoch, stale)),
            ).rejects.toThrow('effective_config_epoch_changed');
            expect(await metadataRepo.getEffectiveConfigEpoch()).toEqual(next);
            const group = await db
              .insertInto('cluster_group')
              .defaultValues()
              .returning('id')
              .executeTakeFirstOrThrow();
            const user = await db
              .insertInto('user')
              .values({
                email: `synthetic-${randomUUID()}@example.test`,
                name: 'Synthetic config administrator',
                clusterGroupId: group.id,
                isAdmin: true,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            const session = await db
              .insertInto('session')
              .values({
                token: Buffer.from('synthetic-config-session'),
                userId: user.id,
                expiresAt: new Date(Date.now() + 60_000),
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            const auth = { user, session } as unknown as AuthDto;
            const validation: string[][] = [];
            const activation = Object.create(SystemConfigService.prototype) as SystemConfigService;
            Object.assign(activation, {
              configRepository: configRepo,
              systemMetadataRepository: metadataRepo,
              logger,
              databaseRepository: new DatabaseRepository(db, logger, configRepo),
              eventRepository: {
                emit: (event: string, value: any) => {
                  if (event === 'ConfigValidate') validation.push([...value.newConfig.machineLearning.urls]);
                  return Promise.resolve();
                },
              },
            });
            const unchanged = await activation.reloadConfigFile(auth, { expectedEpoch: next.epoch });
            expect(validation).toEqual([local.machineLearning.urls]);
            expect((await metadataRepo.getEffectiveConfigEpoch())!.recoveryMl).toBeDefined();
            bytes.machineLearning.urls = ['http://127.0.0.1:12347'];
            await writeFile(filename, JSON.stringify(bytes));
            const authorized = await activation.reloadConfigFile(auth, { expectedEpoch: unchanged.epoch });
            expect(validation[1]).toEqual(bytes.machineLearning.urls);
            expect((await metadataRepo.getEffectiveConfigEpoch())!.recoveryMl).toBeUndefined();
            expect((await readConfig(repos)).machineLearning.urls).toEqual(bytes.machineLearning.urls);
            expect(
              (await metadataRepo.get(SystemMetadataKey.FrameleafRecoveryMlAuthority))!.quarantine[foreignId],
            ).toBeDefined();
            await db.deleteFrom('session').where('id', '=', session.id).execute();
            bytes.machineLearning.urls = old.machineLearning.urls;
            await writeFile(filename, JSON.stringify(bytes));
            await expect(activation.reloadConfigFile(auth, { expectedEpoch: authorized.epoch })).rejects.toThrow(
              'effective_config_admin_session_required',
            );
            expect(validation).toHaveLength(2);
          } else {
            await withEffectiveConfigWrite(repos, async (bound) => {
              const next = await readConfig(bound);
              next.trash.enabled = !next.trash.enabled;
              await updateConfig(bound, next);
            });
            expect((await metadataRepo.getEffectiveConfigEpoch())!.recoveryMl).toBeUndefined();
            expect((await readConfig(repos)).machineLearning.urls).toEqual(local.machineLearning.urls);
            expect(
              recoveryAuthorityDigest(JSON.parse(await readFile(join(recovery, 'settings-rollback.json'), 'utf8'))),
            ).toMatch(/^[a-f0-9]{64}$/);
          }
          await sql`delete from system_metadata where key=${SystemMetadataKey.FrameleafRecoveryMlAuthority}`.execute(
            db,
          );
          clearConfigCache();
          await expect(readConfig(repos)).rejects.toThrow('replacement_ml_authority');
        } finally {
          clearConfigCache();
          await db.destroy();
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
});
