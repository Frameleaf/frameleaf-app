import { Kysely, sql } from 'kysely';
import type { FrameleafCloudLink, FrameleafLicense, FrameleafLicenseStore } from 'src/types.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { FrameleafLicenseService } from 'src/services/frameleaf-license.service.js';
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

const license = (id: string, kind: 'plan' | 'server' = 'plan'): FrameleafLicense => {
  const now = Math.floor(Date.now() / 1000);
  return {
    certificate: id,
    kind,
    source: kind === 'plan' ? 'account' : 'key',
    kid: 'signer',
    verifiedAt: new Date().toISOString(),
    claims: {
      iss: 'https://id.cloud.test',
      aud: 'frameleaf-server',
      sub: 'owner',
      iid: 'instance',
      ent: kind === 'plan' ? ['CLOUD'] : ['SUPPORTER_SERVER'],
      lic_exp: now + 86_400,
      iat: now,
      exp: now + 86_400,
      jti: id,
    },
  };
};

it.each([false, true])(
  'unlink drains a PostgreSQL licence writer before removing its plan (issuer failure: %s)',
  async (fail) => {
    const h = await setup();
    const gate = h.delayResponse(fail);
    const refresh = h.sut.handleRefresh({ force: true });
    await gate.entered;
    const lockAttempt = Promise.withResolvers<void>();
    const database = h.cloudCtx.get(DatabaseRepository),
      withLock = database.withLock.bind(database);
    vi.spyOn(database, 'withLock').mockImplementation((lock, action) => {
      if (lock === DatabaseLock.FrameleafLicenseRefresh) lockAttempt.resolve();
      return withLock(lock, action);
    });
    const unlink = h.clear();
    try {
      await lockAttempt.promise;
      expect(await tryLicenceLock()).toBe(false);
      gate.resume();
      await Promise.all([refresh, unlink]);
      expect(await h.metadata.get(SystemMetadataKey.FrameleafLicense)).toMatchObject({
        key: { claims: { jti: 'supporter' } },
        plan: null,
      });
    } finally {
      gate.resume();
      await Promise.allSettled([refresh, unlink]);
      await h.restore();
    }
  },
);

it.each([false, true])(
  'a committed link replacement rejects old refresh publication (issuer failure: %s)',
  async (fail) => {
    const h = await setup();
    const gate = h.delayResponse(fail);
    const refresh = h.sut.handleRefresh({ force: true });
    await gate.entered;
    try {
      await h.cloudCtx
        .get(DatabaseRepository)
        .withLock(DatabaseLock.FrameleafLinkAuthority, () =>
          h.metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...h.link, linkedAt: 'replacement-generation' }),
        );
      gate.resume();
      await refresh;
      expect(await h.metadata.get(SystemMetadataKey.FrameleafLicense)).toEqual(h.initial);
    } finally {
      gate.resume();
      await Promise.allSettled([refresh]);
      await h.restore();
    }
  },
);

it('serializes plan removal and a concurrent supporter-key write on separate PostgreSQL connections', async () => {
  const h = await setup();
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const cloudMetadata = h.cloudCtx.get(SystemMetadataRepository),
    get = cloudMetadata.get.bind(cloudMetadata);
  let paused = false;
  vi.spyOn(cloudMetadata, 'get').mockImplementation(async (key) => {
    const value = await get(key);
    if (key === SystemMetadataKey.FrameleafLicense && !paused) {
      paused = true;
      entered.resolve();
      await resume.promise;
    }
    return value;
  });
  const unlink = h.clear();
  await entered.promise;
  const update = h.ctx.get(DatabaseRepository).withLock(DatabaseLock.FrameleafLicenseRefresh, async () => {
    const current = await h.metadata.get(SystemMetadataKey.FrameleafLicense);
    await h.metadata.set(SystemMetadataKey.FrameleafLicense, { ...current!, key: license('new-supporter', 'server') });
  });
  try {
    expect(await tryLicenceLock()).toBe(false);
    expect(await tryLicenceLock(DatabaseLock.FrameleafLinkAuthority)).toBe(false);
    resume.resolve();
    await Promise.all([unlink, update]);
    expect(await h.metadata.get(SystemMetadataKey.FrameleafLicense)).toMatchObject({
      key: { claims: { jti: 'new-supporter' } },
      plan: null,
    });
  } finally {
    resume.resolve();
    await Promise.allSettled([unlink, update]);
    await h.restore();
  }
});

const tryLicenceLock = (lock = DatabaseLock.FrameleafLicenseRefresh) =>
  db.transaction().execute(async (tx) => {
    const { rows } = await sql<{
      acquired: boolean;
    }>`select pg_try_advisory_xact_lock(${lock}::bigint) as acquired`.execute(tx);
    return rows[0].acquired;
  });

const setup = async () => {
  const options = {
    database: db,
    real: [DatabaseRepository, SystemMetadataRepository],
    mock: [
      ConfigRepository,
      EventRepository,
      FrameleafAccountRepository,
      FrameleafCloudRepository,
      LoggingRepository,
      UserRepository,
    ],
  };
  const { sut, ctx } = newMediumService(FrameleafLicenseService, options);
  const { sut: cloud, ctx: cloudCtx } = newMediumService(FrameleafCloudService, options);
  for (const context of [ctx, cloudCtx]) {
    context.getMock(ConfigRepository).getEnv.mockReturnValue({
      ...mockEnvData,
      frameleafCloud: { ...mockEnvData.frameleafCloud, url: 'https://cloud.test' },
    });
    context.getMock(UserRepository).getAdmins.mockResolvedValue([]);
    context.getMock(EventRepository).emit.mockResolvedValue();
    context.getMock(FrameleafAccountRepository).deleteAllSessions.mockResolvedValue([]);
  }
  const metadata = ctx.get(SystemMetadataRepository);
  const previousLink = await metadata.get(SystemMetadataKey.FrameleafCloudLink),
    previousStore = await metadata.get(SystemMetadataKey.FrameleafLicense);
  const link: FrameleafCloudLink = {
    status: 'linked',
    cloudUrl: 'https://cloud.test',
    instanceId: 'instance',
    accountId: 'owner',
    linkedAt: '2026-10-16T00:00:00Z',
  };
  const initial: FrameleafLicenseStore = {
    key: license('supporter', 'server'),
    plan: license('old-plan'),
    noticeState: 'active',
  };
  await metadata.set(SystemMetadataKey.FrameleafCloudLink, link);
  await metadata.set(SystemMetadataKey.FrameleafLicense, initial);
  const internals = sut as unknown as {
    apiToken: () => Promise<unknown>;
    verifyForStore: (certificate: string) => Promise<unknown>;
  };
  vi.spyOn(internals, 'apiToken').mockResolvedValue({ document: { api: 'https://api.cloud.test' }, token: {} });
  vi.spyOn(internals, 'verifyForStore').mockImplementation((certificate) =>
    Promise.resolve(license(certificate, certificate === 'supporter' ? 'server' : 'plan')),
  );
  const cloudInternals = cloud as unknown as {
    clearLink: (url: string, link: FrameleafCloudLink, status: 'unlinked') => Promise<void>;
    updateConfigExclusively: () => Promise<unknown>;
  };
  vi.spyOn(cloudInternals, 'updateConfigExclusively').mockResolvedValue({
    oldConfig: { frameleafCloud: {} },
    newConfig: { frameleafCloud: {} },
  });
  const delayResponse = (fail: boolean) => {
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    ctx.getMock(FrameleafCloudRepository).requestJson.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      if (fail) throw new Error('issuer unavailable');
      return { certificates: ['new-plan', 'supporter'] } as never;
    });
    return { entered: entered.promise, resume: resume.resolve };
  };
  const restore = async () => {
    if (previousLink) await metadata.set(SystemMetadataKey.FrameleafCloudLink, previousLink);
    else await metadata.delete(SystemMetadataKey.FrameleafCloudLink);
    if (previousStore) await metadata.set(SystemMetadataKey.FrameleafLicense, previousStore);
    else await metadata.delete(SystemMetadataKey.FrameleafLicense);
  };
  return {
    sut,
    ctx,
    cloudCtx,
    metadata,
    initial,
    link,
    delayResponse,
    clear: () => cloudInternals.clearLink(link.cloudUrl!, link, 'unlinked'),
    restore,
  };
};
