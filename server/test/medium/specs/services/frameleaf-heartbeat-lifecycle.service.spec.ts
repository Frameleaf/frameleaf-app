import { Kysely, sql } from 'kysely';
import type { FrameleafCloudLink } from 'src/types.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db.destroy();
});
afterEach(() => vi.restoreAllMocks());

it.each(['unlink', 'permissions', 'sign-in', 'remote-access'] as const)(
  '%s waits for another worker lifecycle owner before reading or changing Cloud state',
  async (kind) => {
    const h = await setup();
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>(),
      requested = Promise.withResolvers<void>();
    const holder = h.owner.ctx.get(DatabaseRepository).withLock(DatabaseLock.FrameleafHeartbeat, async () => {
      entered.resolve();
      await resume.promise;
      await h.metadata.set(
        SystemMetadataKey.FrameleafCloudLink,
        kind === 'unlink'
          ? { ...h.link, lastContactAt: new Date().toISOString() }
          : { status: 'unlinked', cloudUrl: h.link.cloudUrl },
      );
    });
    await entered.promise;
    let attempted = false;
    const database = h.ctx.get(DatabaseRepository),
      withLock = database.withLock.bind(database);
    vi.spyOn(database, 'withLock').mockImplementation((lock, action) => {
      if (lock === DatabaseLock.FrameleafHeartbeat) {
        attempted = true;
        requested.resolve();
      }
      return withLock(lock, action);
    });
    const operation =
      kind === 'unlink'
        ? h.sut.unlink(authStub.admin)
        : kind === 'permissions'
          ? h.sut.updatePermissions(authStub.admin, { allowRemoteEnable: false })
          : kind === 'sign-in'
            ? h.sut.updateSignIn(authStub.admin, { showOnLocalLogin: true })
            : h.sut.updateRemoteAccess(authStub.admin, { allowPasswordOverRelay: true });
    const settled = operation.then(() => ({ ok: true })).catch((error: unknown) => ({ ok: false, error }));
    try {
      await Promise.race([requested.promise, settled]);
      expect(attempted).toBe(true);
      expect(await h.metadata.get(SystemMetadataKey.FrameleafCloudLink)).toEqual(h.link);
      expect(h.ctx.getMock(FrameleafCloudRepository).requestJson).not.toHaveBeenCalled();
      const available = await db.transaction().execute(async (tx) => {
        const { rows } = await sql<{
          available: boolean;
        }>`select pg_try_advisory_xact_lock(${DatabaseLock.FrameleafLinkAuthority}::bigint) as available`.execute(tx);
        return rows[0].available;
      });
      expect(available).toBe(true);
      resume.resolve();
      await holder;
      const result = await settled;
      if (kind === 'sign-in' || kind === 'remote-access')
        expect(result).toMatchObject({ ok: false, error: { status: 400 } });
      else expect(result.ok).toBe(true);
      expect(await h.metadata.get(SystemMetadataKey.FrameleafCloudLink)).toMatchObject({ status: 'unlinked' });
      if (kind === 'permissions')
        expect(await h.metadata.get(SystemMetadataKey.FrameleafCloudLink)).toMatchObject({
          permissions: { allowRemoteEnable: false },
        });
    } finally {
      resume.resolve();
      await Promise.allSettled([holder, operation]);
      await h.restore();
    }
  },
);

const setup = async () => {
  const env = mockEnvData({});
  const options = {
    database: db,
    real: [DatabaseRepository, SystemMetadataRepository],
    mock: [ConfigRepository, FrameleafAccountRepository, FrameleafCloudRepository, LoggingRepository, UserRepository],
  };
  const { sut, ctx } = newMediumService(FrameleafCloudService, options),
    owner = newMediumService(FrameleafCloudService, options);
  const url = 'https://api.frameleaf.cloud';
  for (const context of [ctx, owner.ctx]) {
    context
      .getMock(ConfigRepository)
      .getEnv.mockReturnValue({ ...env, frameleafCloud: { ...env.frameleafCloud, url } });
    context.getMock(UserRepository).getAdmins.mockResolvedValue([]);
    context.getMock(FrameleafAccountRepository).deleteAllSessions.mockResolvedValue([]);
    context.getMock(FrameleafCloudRepository).requestJson.mockResolvedValue({} as never);
  }
  vi.spyOn(sut, 'getStatus').mockResolvedValue({} as never);
  vi.spyOn(sut, 'updateConfigExclusively').mockResolvedValue({
    oldConfig: { frameleafCloud: {} },
    newConfig: { frameleafCloud: {} },
  } as never);
  const internal = sut as unknown as {
    apiToken: () => Promise<unknown>;
    clearKeyRecovery: () => Promise<void>;
    notify: () => void;
  };
  vi.spyOn(internal, 'apiToken').mockResolvedValue({
    document: cloudContractFixture('instance/discovery.json'),
    token: { signer: { kid: 'fixture' } },
  });
  vi.spyOn(internal, 'clearKeyRecovery').mockResolvedValue();
  vi.spyOn(internal, 'notify').mockReturnValue();
  const metadata = ctx.get(SystemMetadataRepository),
    previous = await metadata.get(SystemMetadataKey.FrameleafCloudLink),
    previousLicense = await metadata.get(SystemMetadataKey.FrameleafLicense);
  const link: FrameleafCloudLink = {
    status: 'linked',
    cloudUrl: url,
    instanceId: 'instance',
    accountId: 'owner',
    linkedAt: 'generation',
  };
  await metadata.set(SystemMetadataKey.FrameleafCloudLink, link);
  await metadata.set(SystemMetadataKey.FrameleafLicense, { key: null, plan: null });
  const restore = async () => {
    if (previous) await metadata.set(SystemMetadataKey.FrameleafCloudLink, previous);
    else await metadata.delete(SystemMetadataKey.FrameleafCloudLink);
    if (previousLicense) await metadata.set(SystemMetadataKey.FrameleafLicense, previousLicense);
    else await metadata.delete(SystemMetadataKey.FrameleafLicense);
  };
  return { sut, ctx, owner, metadata, link, restore };
};
