import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { SystemConfigController } from 'src/controllers/system-config.controller.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { DatabaseLock, Permission, SystemMetadataKey } from 'src/enum.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AuthService } from 'src/services/auth.service.js';
import { BuddyBackupRecoveryService } from 'src/services/buddy-backup-recovery.service.js';
import { CliService } from 'src/services/cli.service.js';
import { StorageTemplateService } from 'src/services/storage-template.service.js';
import { SystemConfigService } from 'src/services/system-config.service.js';
import {
  clearConfigCache,
  readConfig,
  updateConfig,
  withEffectiveConfigRead,
  withEffectiveConfigWrite,
} from 'src/utils/config.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { lockEffectiveConfig } from 'src/utils/effective-config-lock.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { controllerSetup, getKyselyDB } from 'test/utils.js';

const CONFIG_KEY = 'frameleaf-effective-config:v1';
const EPOCH_KEY = SystemMetadataKey.EffectiveConfigEpoch;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

/** Real canonical PG, actual CLI/config writes; independent DB sessions create barriers. */
describe('effective configuration transaction authority', () => {
  let db: Kysely<DB>;
  afterEach(async () => {
    clearConfigCache();
    await db.destroy();
  });
  beforeEach(async () => {
    db = await getKyselyDB();
    await db.deleteFrom('system_metadata').where('key', 'in', [SystemMetadataKey.SystemConfig, EPOCH_KEY]).execute();
    clearConfigCache();
  });
  const setup = () => {
    const harness = newMediumService(CliService, {
      database: db,
      real: [CryptoRepository, DatabaseRepository, SystemMetadataRepository],
      mock: [ConfigRepository, LoggingRepository],
    });
    harness.ctx.getMock(ConfigRepository).getEnv.mockReturnValue(mockEnvData({}));
    return harness;
  };

  async function fileSetup(directory: string) {
    const filename = join(directory, 'settings.json');
    await writeFile(filename, JSON.stringify({ trash: { enabled: false } }), { mode: 0o600 });
    const harness = newMediumService(SystemConfigService, {
      database: db,
      real: [DatabaseRepository, SystemMetadataRepository],
      mock: [ConfigRepository, LoggingRepository, EventRepository],
    });
    const env = { ...mockEnvData({}), configFile: filename };
    env.frameleafCloud.identityDir = join(directory, 'identity');
    harness.ctx.getMock(ConfigRepository).getEnv.mockReturnValue(env);
    harness.ctx.getMock(EventRepository).emit.mockResolvedValue(undefined);
    const { user } = await harness.ctx.newUser({ isAdmin: true });
    const { session } = await harness.ctx.newSession({ userId: user.id });
    const auth = { user, session: { ...session, hasElevatedPermission: false } } as AuthDto;
    const repos = {
      metadataRepo: harness.ctx.get(SystemMetadataRepository),
      configRepo: harness.ctx.getMock(ConfigRepository) as unknown as ConfigRepository,
      logger: harness.ctx.getMock(LoggingRepository) as unknown as LoggingRepository,
    };
    await readConfig(repos);
    const epoch = (await repos.metadataRepo.getEffectiveConfigEpoch())!;
    return { ...harness, filename, auth, repos, epoch };
  }

  it('refuses an unguarded durable configuration write', async () => {
    await expect(
      new SystemMetadataRepository(db).set(SystemMetadataKey.SystemConfig, { trash: { enabled: false } }),
    ).rejects.toThrow('effective_config_transaction_required');
  });

  it('ordinary CLI changes publish configuration and a durable local epoch together', async () => {
    const { sut } = setup();
    await sut.disablePasswordLogin();
    const rows = await db
      .selectFrom('system_metadata')
      .selectAll()
      .where('key', 'in', [SystemMetadataKey.SystemConfig, EPOCH_KEY])
      .execute();
    expect(rows.find((row) => row.key === SystemMetadataKey.SystemConfig)?.value).toMatchObject({
      passwordLogin: { enabled: false },
    });
    expect(rows.find((row) => row.key === EPOCH_KEY)?.value).toMatchObject({
      sourceKind: 'database',
      epoch: expect.any(Number),
    });
  });

  for (const terminate of ['outer', 'writer'] as const) {
    it(`keeps write/epoch authority on the write transaction when the ${terminate} connection is lost`, async () => {
      const { sut } = setup();
      await sut.enablePasswordLogin();
      const before = await db
        .selectFrom('system_metadata')
        .selectAll()
        .where('key', 'in', [SystemMetadataKey.SystemConfig, EPOCH_KEY])
        .orderBy('key')
        .execute();
      const name = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
      const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
      url.pathname = name.rows[0].name;
      const observer = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: url.href }));
      const locked = deferred();
      const release = deferred();
      const blocker = observer.transaction().execute(async (tx) => {
        await tx
          .selectFrom('system_metadata')
          .select('key')
          .where('key', '=', SystemMetadataKey.SystemConfig)
          .forUpdate()
          .execute();
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const write = sut
        .disablePasswordLogin()
        .then(() => {})
        .catch((error: unknown) => error);
      try {
        let writerPid: number | undefined;
        await vi.waitFor(async () => {
          const { rows } = await sql<{ pid: number }>`SELECT pid FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
              AND lower(query) LIKE '%insert into "system_metadata"%'`.execute(observer);
          expect(rows).toHaveLength(1);
          writerPid = rows[0].pid;
        });
        const { rows: holders } = await sql<{ pid: number }>`SELECT pid FROM pg_locks
          WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory' AND classid=0 AND objid=${DatabaseLock.SystemConfigUpdate} AND granted`.execute(
          observer,
        );
        expect(holders).toHaveLength(1);
        await sql`SELECT pg_terminate_backend(${terminate === 'outer' ? holders[0].pid : writerPid!})`.execute(
          observer,
        );
        await observer.transaction().execute(async (tx) => {
          const { rows } = await sql<{
            acquired: boolean;
          }>`SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${CONFIG_KEY},0)) AS acquired`.execute(tx);
          expect(rows[0].acquired).toBe(terminate === 'writer');
        });
      } finally {
        release.resolve();
        await blocker;
        await write;
      }
      const after = await observer
        .selectFrom('system_metadata')
        .selectAll()
        .where('key', 'in', [SystemMetadataKey.SystemConfig, EPOCH_KEY])
        .orderBy('key')
        .execute();
      if (terminate === 'writer' || JSON.stringify(after) === JSON.stringify(before)) expect(after).toEqual(before);
      else {
        expect(after.find((row) => row.key === SystemMetadataKey.SystemConfig)?.value).toMatchObject({
          passwordLogin: { enabled: false },
        });
        expect(after.find((row) => row.key === EPOCH_KEY)?.value).toMatchObject({
          sourceKind: 'database',
          epoch: expect.any(Number),
        });
      }
      await observer.destroy();
    });
  }

  it('does not activate changed file bytes through an ordinary uncached read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-config-epoch-'));
    const filename = join(directory, 'settings.json');
    try {
      const { ctx } = setup();
      const configRepo = ctx.getMock(ConfigRepository);
      configRepo.getEnv.mockReturnValue({ ...mockEnvData({}), configFile: filename });
      const repos = {
        configRepo: configRepo as unknown as ConfigRepository,
        metadataRepo: ctx.get(SystemMetadataRepository),
        logger: ctx.getMock(LoggingRepository) as unknown as LoggingRepository,
      };
      await writeFile(filename, JSON.stringify({ trash: { enabled: false } }), { mode: 0o600 });
      expect((await readConfig(repos)).trash.enabled).toBe(false);
      await writeFile(filename, JSON.stringify({ trash: { enabled: true } }));
      expect((await readConfig(repos)).trash.enabled).toBe(false);
      const epoch = await db
        .selectFrom('system_metadata')
        .select('value')
        .where('key', '=', EPOCH_KEY)
        .executeTakeFirst();
      expect(epoch?.value).toMatchObject({ sourceKind: 'file', trashEnabled: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('requires an explicit current-epoch administrator decision to activate prepared file settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-config-reload-'));
    try {
      const filename = join(directory, 'settings.json');
      await writeFile(filename, JSON.stringify({ trash: { enabled: false } }), { mode: 0o600 });
      const { sut, ctx } = newMediumService(SystemConfigService, {
        database: db,
        real: [DatabaseRepository, SystemMetadataRepository],
        mock: [ConfigRepository, LoggingRepository, EventRepository],
      });
      ctx.getMock(ConfigRepository).getEnv.mockReturnValue({ ...mockEnvData({}), configFile: filename });
      ctx.getMock(EventRepository).emit.mockResolvedValue(undefined);
      const { user } = await ctx.newUser({ isAdmin: true });
      const { session } = await ctx.newSession({ userId: user.id });
      const auth = { user, session: { ...session, hasElevatedPermission: false } } as AuthDto;
      expect((await sut.getAdminConfig()).trash.enabled).toBe(false);
      const before = (await new SystemMetadataRepository(db).getEffectiveConfigEpoch())!;
      await writeFile(filename, JSON.stringify({ trash: { enabled: true } }));
      const result = await sut.reloadConfigFile(auth, { expectedEpoch: before.epoch });
      expect(result).toEqual({ epoch: before.epoch + 1, sourceKind: 'file' });
      expect((await sut.getAdminConfig()).trash.enabled).toBe(true);
      await expect(sut.reloadConfigFile(auth, { expectedEpoch: before.epoch })).rejects.toThrow(
        'effective_config_epoch_changed',
      );
      const after = (await new SystemMetadataRepository(db).getEffectiveConfigEpoch())!;
      expect(after.epoch).toBe(result.epoch);
      expect(JSON.stringify(result)).not.toMatch(/digest|settings|filename|trash/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains the strict shared config snapshot through the policy transaction while a real CLI writer waits', async () => {
    const { sut, ctx } = setup();
    await sut.enablePasswordLogin();
    const repos = {
      metadataRepo: ctx.get(SystemMetadataRepository),
      configRepo: ctx.getMock(ConfigRepository) as unknown as ConfigRepository,
      logger: ctx.getMock(LoggingRepository) as unknown as LoggingRepository,
    };
    const held = deferred();
    const release = deferred();
    const policy = db.transaction().execute((tx) =>
      withEffectiveConfigRead(repos, tx, async (snapshot, epoch) => {
        expect(snapshot.passwordLogin.enabled).toBe(true);
        held.resolve();
        await release.promise;
        expect((await new SystemMetadataRepository(tx).getEffectiveConfigEpoch())?.epoch).toBe(epoch.epoch);
        expect(snapshot.passwordLogin.enabled).toBe(true);
      }),
    );
    await held.promise;
    const write = sut.disablePasswordLogin();
    try {
      await vi.waitFor(async () => {
        const { rows } = await sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_locks
          WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory' AND NOT granted AND mode='ExclusiveLock'`.execute(
          db,
        );
        expect(Number(rows[0].count)).toBeGreaterThan(0);
      });
    } finally {
      release.resolve();
      await policy;
      await write;
    }
    expect((await readConfig(repos)).passwordLogin.enabled).toBe(false);
  });

  it('refuses a strict policy read without an activated epoch, rather than deriving defaults as permission', async () => {
    const { ctx } = setup();
    const repos = {
      metadataRepo: ctx.get(SystemMetadataRepository),
      configRepo: ctx.getMock(ConfigRepository) as unknown as ConfigRepository,
      logger: ctx.getMock(LoggingRepository) as unknown as LoggingRepository,
    };
    await expect(
      db.transaction().execute((tx) => withEffectiveConfigRead(repos, tx, () => Promise.resolve('must not publish'))),
    ).rejects.toThrow('effective_config_unavailable');
  });

  it('a fresh worker refuses pending changed bytes and follows the durable reload even without a ConfigUpdate event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-config-worker-'));
    try {
      const f = await fileSetup(directory);
      const worker = { ...f.repos, configRepo: { getEnv: () => f.repos.configRepo.getEnv() } as ConfigRepository };
      expect((await readConfig(worker)).trash.enabled).toBe(false);
      await writeFile(f.filename, JSON.stringify({ trash: { enabled: true } }));
      const cold = { ...f.repos, configRepo: { getEnv: () => f.repos.configRepo.getEnv() } as ConfigRepository };
      await expect(readConfig(cold)).rejects.toThrow('effective_config_activation_required');
      await f.sut.reloadConfigFile(f.auth, { expectedEpoch: f.epoch.epoch });
      expect((await readConfig(worker)).trash.enabled).toBe(true);
      expect((await readConfig(cold)).trash.enabled).toBe(true);
      await rm(f.filename);
      const restarted = { ...f.repos, configRepo: { getEnv: () => f.repos.configRepo.getEnv() } as ConfigRepository };
      await expect(readConfig(restarted)).rejects.toThrow('effective_config_candidate_invalid');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('activates captured immutable file bytes only; later edits and a failed validator do not become authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-config-capture-'));
    try {
      const f = await fileSetup(directory);
      await writeFile(f.filename, JSON.stringify({ trash: { enabled: true } }));
      f.ctx.getMock(EventRepository).emit.mockImplementation(async (...args) => {
        const [event] = args;
        if (event === 'ConfigValidate') await writeFile(f.filename, JSON.stringify({ trash: { enabled: false } }));
      });
      await expect(f.sut.reloadConfigFile(f.auth, { expectedEpoch: f.epoch.epoch })).rejects.toThrow(
        'effective_config_epoch_changed',
      );
      expect(await f.repos.metadataRepo.getEffectiveConfigEpoch()).toEqual(f.epoch);
      expect((await readConfig(f.repos)).trash.enabled).toBe(false);
      // A fresh candidate may activate; changed bytes after activation still require another reload.
      f.ctx.getMock(EventRepository).emit.mockResolvedValue(undefined);
      await writeFile(f.filename, JSON.stringify({ trash: { enabled: true } }));
      const result = await f.sut.reloadConfigFile(f.auth, { expectedEpoch: f.epoch.epoch });
      expect((await readConfig(f.repos)).trash.enabled).toBe(true);
      await writeFile(f.filename, JSON.stringify({ trash: { enabled: false } }));
      const cold = { ...f.repos, configRepo: { getEnv: () => f.repos.configRepo.getEnv() } as ConfigRepository };
      await expect(readConfig(cold)).rejects.toThrow('effective_config_activation_required');
      f.ctx.getMock(EventRepository).emit.mockRejectedValue(new Error('validator refused'));
      await expect(f.sut.reloadConfigFile(f.auth, { expectedEpoch: result.epoch })).rejects.toThrow(
        'effective_config_candidate_invalid',
      );
      expect((await f.repos.metadataRepo.getEffectiveConfigEpoch())?.epoch).toBe(result.epoch);
      await writeFile(f.filename, '{private-invalid-parser-input');
      await expect(f.sut.reloadConfigFile(f.auth, { expectedEpoch: result.epoch })).rejects.toThrow(
        'effective_config_candidate_invalid',
      );
      expect((await f.repos.metadataRepo.getEffectiveConfigEpoch())?.epoch).toBe(result.epoch);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rechecks the actual administrator session after waiting for config authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-config-revoke-'));
    try {
      const f = await fileSetup(directory);
      await writeFile(f.filename, JSON.stringify({ trash: { enabled: true } }));
      const held = deferred(),
        release = deferred();
      const blocker = db.transaction().execute(async (tx) => {
        await lockEffectiveConfig(tx, 'write');
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const reload = f.sut
        .reloadConfigFile(f.auth, { expectedEpoch: f.epoch.epoch })
        .then(() => {})
        .catch((error: unknown) => error);
      try {
        await vi.waitFor(async () => {
          const { rows } = await sql<{
            count: string;
          }>`SELECT count(*)::text AS count FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory' AND NOT granted AND mode='ExclusiveLock'`.execute(
            db,
          );
          expect(Number(rows[0].count)).toBeGreaterThan(0);
        });
        await db.deleteFrom('session').where('id', '=', f.auth.session!.id).execute();
      } finally {
        release.resolve();
        await blocker;
      }
      expect(await reload).toMatchObject({ message: 'effective_config_admin_session_required' });
      expect((await f.repos.metadataRepo.getEffectiveConfigEpoch())?.epoch).toBe(f.epoch.epoch);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serves actual administrator-session HTTP reload with strict private serialization and refuses other credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-config-http-'));
    let http: Awaited<ReturnType<typeof controllerSetup>> | undefined;
    try {
      const f = await fileSetup(directory);
      const authService = newMediumService(AuthService, {
        database: db,
        real: [CryptoRepository, SessionRepository, UserRepository, ApiKeyRepository, SharedLinkRepository],
        mock: [LoggingRepository],
      }).sut;
      http = await controllerSetup(SystemConfigController, [
        { provide: SystemConfigService, useValue: f.sut },
        { provide: StorageTemplateService, useValue: {} },
        { provide: AuthService, useValue: authService },
      ]);
      const uri = '/system-config/config-file/activation',
        reload = '/system-config/config-file/reload';
      for (const path of [uri, reload]) {
        const result =
          path === uri
            ? await request(http.getHttpServer()).get(path).expect(401)
            : await request(http.getHttpServer()).post(path).send({ expectedEpoch: f.epoch.epoch }).expect(401);
        expect(result.headers['cache-control']).toBe('private, no-store');
      }
      const apiKey = randomUUID();
      await new ApiKeyRepository(db).create({
        name: 'fixture',
        userId: f.auth.user.id,
        key: createHash('sha256').update(apiKey).digest(),
        permissions: [Permission.All],
      });
      const denied = await request(http.getHttpServer())
        .post(reload)
        .set('x-api-key', apiKey)
        .send({ expectedEpoch: f.epoch.epoch })
        .expect(403);
      expect(denied.headers['cache-control']).toBe('private, no-store');
      const header = 'Bearer ' + f.auth.session!.id;
      const current = await request(http.getHttpServer()).get(uri).set('Authorization', header).expect(200);
      expect(current.body).toEqual({ epoch: f.epoch.epoch, sourceKind: 'file' });
      for (const body of [
        { expectedEpoch: 0 },
        { expectedEpoch: 1.5 },
        { expectedEpoch: f.epoch.epoch, filename: 'forbidden' },
      ]) {
        const rejected = await request(http.getHttpServer())
          .post(reload)
          .set('Authorization', header)
          .send(body)
          .expect(400);
        expect(rejected.headers['cache-control']).toBe('private, no-store');
      }
      await writeFile(f.filename, JSON.stringify({ trash: { enabled: true } }));
      const accepted = await request(http.getHttpServer())
        .post(reload)
        .set('Authorization', header)
        .send({ expectedEpoch: f.epoch.epoch })
        .expect(201);
      expect(accepted.body).toEqual({ epoch: f.epoch.epoch + 1, sourceKind: 'file' });
      expect(accepted.headers['cache-control']).toBe('private, no-store');
      const stale = await request(http.getHttpServer())
        .post(reload)
        .set('Authorization', header)
        .send({ expectedEpoch: f.epoch.epoch })
        .expect(409);
      expect(stale.headers['cache-control']).toBe('private, no-store');
      expect(JSON.stringify([current.body, accepted.body, stale.body])).not.toMatch(
        /digest|filename|identity|trash|settings.json/i,
      );
    } finally {
      await http?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['lease-after-commit', 'commit-response'] as const)(
    'recovery settings/epoch remain committed on %s and resume without file rollback',
    async (failure) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'frameleaf-config-recovery-')));
      try {
        const f = await fileSetup(directory);
        await f.ctx.get(DatabaseRepository).withLock(DatabaseLock.FrameleafIdentity, async () => {
          const identity = await new InstanceIdentityRepository().loadOrCreate(join(directory, 'identity'), null);
          await f.repos.metadataRepo.set(SystemMetadataKey.FrameleafInstance, identity);
        });
        const root = join(directory, 'identity', 'buddy'),
          id = randomUUID(),
          recovery = join(root, 'recovery', id);
        await mkdir(join(recovery, 'objects'), { recursive: true });
        StorageCore.setMediaLocation(directory);
        const repository = new BuddyBackupRepository(db, f.repos.configRepo);
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
            configurationFiles: [f.filename],
          },
        }));
        const content = Buffer.from(JSON.stringify({ trash: { enabled: true } })),
          sha256 = createHash('sha256').update(content).digest('hex');
        await writeFile(join(recovery, 'objects', sha256), content);
        const plan = {
          version: 1,
          scope: 'settings',
          mode: 'replace',
          files: [{ path: f.filename, sha256, size: content.length }],
          manifest: {
            version: 1,
            frameleafVersion: '2.6.0',
            storageRoot: directory,
            settings: { system: {}, users: [], fork: [] },
          },
        };
        await writeFile(join(recovery, 'prepared.json'), JSON.stringify(plan));
        const service = new BuddyBackupRecoveryService(
          repository,
          f.repos.configRepo,
          {} as never,
          new CloudBackupKeyRepository(LoggingRepository.create()),
        );
        const held = deferred(),
          release = deferred();
        const policy = db.transaction().execute(async (tx) => {
          await lockEffectiveConfig(tx, 'read');
          held.resolve();
          await release.promise;
        });
        await held.promise;
        const original = SystemMetadataRepository.prototype.withConfigTransaction;
        // Replacement authority capture is a separate real transaction. Lose only the response
        // from the settings publication, whose result carries the durable epoch object.
        const loseRecoveryPublicationResponse = (message: string) => {
          let injected = false;
          return vi
            .spyOn(SystemMetadataRepository.prototype, 'withConfigTransaction')
            .mockImplementation(async function (this: SystemMetadataRepository, callback) {
              const committed = await original.call(this, callback);
              if (
                !injected &&
                committed &&
                typeof committed === 'object' &&
                'epoch' in committed &&
                typeof committed.epoch === 'object'
              ) {
                injected = true;
                throw new Error(message);
              }
              return committed;
            });
        };
        const commitLoss =
          failure === 'commit-response' ? loseRecoveryPublicationResponse('lost COMMIT response') : undefined;
        const result = service
          .settings(id, async () => {
            const active = await f.repos.metadataRepo.getEffectiveConfigEpoch();
            if (failure === 'lease-after-commit' && active!.epoch > f.epoch.epoch)
              throw new Error('committed response lost');
          })
          .then(() => {})
          .catch((error: unknown) => error);
        try {
          await vi.waitFor(async () => {
            const { rows } = await sql<{
              count: string;
            }>`SELECT count(*)::text AS count FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory' AND NOT granted AND mode='ExclusiveLock'`.execute(
              db,
            );
            expect(Number(rows[0].count)).toBeGreaterThan(0);
          });
          expect(JSON.parse(await readFile(f.filename, 'utf8')).trash.enabled).toBe(false);
          expect((await f.repos.metadataRepo.getEffectiveConfigEpoch())?.epoch).toBe(f.epoch.epoch);
        } finally {
          release.resolve();
          await policy;
        }
        expect(await result).toMatchObject({
          message:
            failure === 'commit-response'
              ? 'Settings recovery commit outcome requires review'
              : 'committed response lost',
        });
        commitLoss?.mockRestore();
        expect(JSON.parse(await readFile(f.filename, 'utf8')).trash.enabled).toBe(true);
        const committed = (await f.repos.metadataRepo.getEffectiveConfigEpoch())!;
        expect(committed).toMatchObject({ epoch: f.epoch.epoch + 1, trashEnabled: true });
        const preimage = await readFile(join(recovery, 'settings-rollback.json'));
        if (failure === 'commit-response') {
          const lostReplay = loseRecoveryPublicationResponse('lost repeated COMMIT response');
          try {
            await expect(service.settings(id, async () => {})).rejects.toThrow(
              'Settings recovery commit outcome requires review',
            );
          } finally {
            lostReplay.mockRestore();
          }
          expect(JSON.parse(await readFile(f.filename, 'utf8')).trash.enabled).toBe(true);
          expect((await f.repos.metadataRepo.getEffectiveConfigEpoch())?.epoch).toBe(committed.epoch);
        }
        await service.settings(id, async () => {});
        expect((await f.repos.metadataRepo.getEffectiveConfigEpoch())?.epoch).toBe(committed.epoch);
        expect(await readFile(join(recovery, 'settings-rollback.json'))).toEqual(preimage);
        expect((await readConfig(f.repos)).trash.enabled).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('retains committed activation when its post-commit notification fails, without activating again on retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-config-notification-'));
    try {
      const f = await fileSetup(directory);
      await writeFile(f.filename, JSON.stringify({ trash: { enabled: true } }));
      f.ctx
        .getMock(EventRepository)
        .emit.mockImplementation((...args) =>
          args[0] === 'ConfigUpdate' ? Promise.reject(new Error('private notification details')) : Promise.resolve(),
        );
      await expect(f.sut.reloadConfigFile(f.auth, { expectedEpoch: f.epoch.epoch })).rejects.toThrow(
        'effective_config_activated_notification_pending',
      );
      expect((await f.repos.metadataRepo.getEffectiveConfigEpoch())?.epoch).toBe(f.epoch.epoch + 1);
      expect((await readConfig(f.repos)).trash.enabled).toBe(true);
      await expect(f.sut.reloadConfigFile(f.auth, { expectedEpoch: f.epoch.epoch })).rejects.toThrow(
        'effective_config_epoch_changed',
      );
      expect((await f.repos.metadataRepo.getEffectiveConfigEpoch())?.epoch).toBe(f.epoch.epoch + 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('a second real config writer waits for the surviving write transaction and rereads its committed result after outer-lock loss', async () => {
    const { sut } = setup();
    await sut.enablePasswordLogin();
    const { rows } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = rows[0].name;
    const observer = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: url.href }));
    const held = deferred(),
      release = deferred(),
      secondRead = deferred(),
      secondRelease = deferred();
    const blocker = observer.transaction().execute(async (tx) => {
      await tx
        .selectFrom('system_metadata')
        .select('key')
        .where('key', '=', SystemMetadataKey.SystemConfig)
        .forUpdate()
        .execute();
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const first = sut.disablePasswordLogin().catch(() => {});
    let second: Promise<unknown> | undefined;
    let observed: Awaited<ReturnType<typeof readConfig>> | undefined;
    try {
      let writerPid = 0;
      await vi.waitFor(async () => {
        const { rows } = await sql<{
          pid: number;
        }>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND lower(query) LIKE '%insert into "system_metadata"%'`.execute(
          observer,
        );
        expect(rows).toHaveLength(1);
        writerPid = rows[0].pid;
      });
      const { rows: holders } = await sql<{
        pid: number;
      }>`SELECT pid FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory' AND classid=0 AND objid=${DatabaseLock.SystemConfigUpdate} AND granted`.execute(
        observer,
      );
      expect(holders).toHaveLength(1);
      await sql`SELECT pg_terminate_backend(${holders[0].pid})`.execute(observer);
      const { ctx } = newMediumService(CliService, {
        database: observer,
        real: [DatabaseRepository, SystemMetadataRepository],
        mock: [ConfigRepository, LoggingRepository],
      });
      ctx.getMock(ConfigRepository).getEnv.mockReturnValue(mockEnvData({}));
      const repos = {
        metadataRepo: ctx.get(SystemMetadataRepository),
        configRepo: ctx.getMock(ConfigRepository) as unknown as ConfigRepository,
        logger: ctx.getMock(LoggingRepository) as unknown as LoggingRepository,
      };
      second = ctx.get(DatabaseRepository).withLock(DatabaseLock.SystemConfigUpdate, () =>
        withEffectiveConfigWrite(repos, async (bound) => {
          observed = await readConfig(bound);
          secondRead.resolve();
          await secondRelease.promise;
          const next = structuredClone(observed);
          next.server.name = 'second writer';
          return updateConfig(bound, next);
        }),
      );
      await vi.waitFor(async () => {
        const { rows } = await sql<{
          blockers: number[];
        }>`SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'`.execute(
          observer,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].blockers).toContain(writerPid);
      });
      release.resolve();
      await blocker;
      await first;
      await secondRead.promise;
      const settled = await readConfig(repos);
      expect(observed).toEqual(settled);
      secondRelease.resolve();
      await second;
      const final = await readConfig(repos);
      expect(final.server.name).toBe('second writer');
      expect(final.passwordLogin.enabled).toBe(settled.passwordLogin.enabled);
    } finally {
      release.resolve();
      secondRelease.resolve();
      await blocker;
      await first;
      await second?.catch(() => {});
      await observer.destroy();
    }
  });
});
