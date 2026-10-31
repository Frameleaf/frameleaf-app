import { Kysely, sql } from 'kysely';
import type { FrameleafCloudLink } from 'src/types.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { AdminAuditRepository } from 'src/repositories/admin-audit.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
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

it('does not recreate the linking administrator account link after committed unlink cleanup', async () => {
  const h = await setup();
  try {
    await h.clear();
    await h.connect();
    expect(await h.accounts.getLinkByUser(h.actor.id)).toBeUndefined();
    expect(h.audit.create).not.toHaveBeenCalled();
  } finally {
    await h.restore();
  }
});

it('holds the PostgreSQL authority fence through registration account writes, then lets unlink remove them', async () => {
  const h = await setup();
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const users = h.ctx.get(UserRepository),
    get = users.get.bind(users);
  vi.spyOn(users, 'get').mockImplementation(async (...args) => {
    entered.resolve();
    await resume.promise;
    return get(...args);
  });
  const connect = h.connect();
  let unlink: Promise<void> | undefined;
  try {
    await Promise.race([
      entered.promise,
      connect.then(() => {
        throw new Error('Registration skipped actor lookup');
      }),
    ]);
    const acquired = await db.transaction().execute(async (tx) => {
      const { rows } = await sql<{
        acquired: boolean;
      }>`select pg_try_advisory_xact_lock(${DatabaseLock.FrameleafLinkAuthority}::bigint) as acquired`.execute(tx);
      return rows[0].acquired;
    });
    expect(acquired).toBe(false);
    unlink = h.clear();
    resume.resolve();
    await Promise.all([connect, unlink]);
    expect(h.audit.create).toHaveBeenCalledOnce();
    expect(await h.accounts.getLinkByUser(h.actor.id)).toBeUndefined();
    expect(await h.accounts.getLinkBySub(h.link.accountId!)).toBeUndefined();
    expect(await h.metadata.get(SystemMetadataKey.FrameleafCloudLink)).toMatchObject({ status: 'unlinked' });
  } finally {
    resume.resolve();
    await Promise.allSettled([connect, ...(unlink ? [unlink] : [])]);
    await h.restore();
  }
});

const setup = async () => {
  const env = mockEnvData({});
  const { sut, ctx } = newMediumService(FrameleafCloudService, {
    database: db,
    real: [DatabaseRepository, FrameleafAccountRepository, SessionRepository, SystemMetadataRepository, UserRepository],
    mock: [AdminAuditRepository, ConfigRepository, EventRepository, FrameleafCloudRepository, LoggingRepository],
  });
  ctx.getMock(ConfigRepository).getEnv.mockReturnValue({
    ...env,
    frameleafCloud: { ...env.frameleafCloud, url: 'https://cloud.test' },
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  // unlink cleanup drops the cached Cloud tokens
  ctx.getMock(FrameleafCloudRepository).forget.mockReturnValue();
  const audit = ctx.getMock(AdminAuditRepository);
  audit.create.mockResolvedValue();
  const { result: actor } = await ctx.newUser({ isAdmin: true });
  const metadata = ctx.get(SystemMetadataRepository),
    accounts = ctx.get(FrameleafAccountRepository);
  const previous = await metadata.get(SystemMetadataKey.FrameleafCloudLink);
  const link: FrameleafCloudLink = {
    status: 'linked',
    cloudUrl: 'https://cloud.test',
    instanceId: 'instance',
    accountId: 'owner',
    linkedAt: '2026-10-16T00:00:00Z',
  };
  await metadata.set(SystemMetadataKey.FrameleafCloudLink, link);
  const internal = sut as unknown as {
    connectLinkingAdministrator: (link: FrameleafCloudLink, actor: string) => Promise<void>;
    clearLink: (url: string, link: FrameleafCloudLink, status: 'unlinked') => Promise<void>;
    updateConfigExclusively: () => Promise<unknown>;
  };
  vi.spyOn(internal, 'updateConfigExclusively').mockResolvedValue({
    oldConfig: { frameleafCloud: {} },
    newConfig: { frameleafCloud: {} },
  });
  const restore = async () => {
    if (previous) await metadata.set(SystemMetadataKey.FrameleafCloudLink, previous);
    else await metadata.delete(SystemMetadataKey.FrameleafCloudLink);
  };
  return {
    ctx,
    actor,
    accounts,
    metadata,
    audit,
    link,
    connect: () => internal.connectLinkingAdministrator(link, actor.id),
    clear: () => internal.clearLink(link.cloudUrl, link, 'unlinked'),
    restore,
  };
};
