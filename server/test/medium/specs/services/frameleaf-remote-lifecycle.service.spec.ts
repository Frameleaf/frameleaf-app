import { Kysely, sql } from 'kysely';
import type { FrameleafCloudLink, FrameleafLicense } from 'src/types.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { FrameleafRemoteAccessService } from 'src/services/frameleaf-remote-access.service.js';
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

it('rechecks remote enable admission after another PostgreSQL lifecycle owner commits unlink', async () => {
  const h = await setup(),
    entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const holder = h.owner.ctx.get(DatabaseRepository).withLock(DatabaseLock.FrameleafHeartbeat, async () => {
    entered.resolve();
    await resume.promise;
    await h.metadata.set(SystemMetadataKey.FrameleafCloudLink, { status: 'unlinked', cloudUrl: h.link.cloudUrl });
  });
  await entered.promise;
  const requested = Promise.withResolvers<void>();
  const database = h.ctx.get(DatabaseRepository),
    withLock = database.withLock.bind(database);
  vi.spyOn(database, 'withLock').mockImplementation((lock, action) => {
    if (lock === DatabaseLock.FrameleafHeartbeat) requested.resolve();
    return withLock(lock, action);
  });
  const operation = h.sut.update(authStub.admin, { enabled: true });
  const settled = operation.then(() => ({ ok: true })).catch((error: unknown) => ({ ok: false, error }));
  try {
    await Promise.race([requested.promise, settled]);
    expect(h.write).not.toHaveBeenCalled();
    resume.resolve();
    await holder;
    expect(await settled).toMatchObject({ ok: false, error: { status: 400 } });
    expect(h.config.frameleafCloud.remoteAccess.enabled).toBe(false);
  } finally {
    resume.resolve();
    await Promise.allSettled([holder, operation]);
    await h.restore();
  }
});

it('holds lifecycle ownership through a hostname reply and local publication without holding974 during issuer work', async () => {
  const h = await setup(),
    entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  h.ctx.getMock(FrameleafCloudRepository).requestJson.mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    return { ...cloudContractFixture('remote/hostnames-list.json').hostnames[0], hostname: 'new.example.com' } as never;
  });
  const operation = h.sut.setCustomHostname(authStub.admin, { hostname: 'new.example.com' });
  let cleanup: Promise<void> | undefined;
  try {
    await Promise.race([
      entered.promise,
      operation.then(() => {
        throw new Error('Hostname operation bypassed issuer request');
      }),
    ]);
    expect(await lockAvailability()).toEqual({ lifecycle: false, publication: true });
    let observed: string | undefined;
    cleanup = h.owner.ctx.get(DatabaseRepository).withLock(DatabaseLock.FrameleafHeartbeat, async () => {
      observed = h.config.frameleafCloud.remoteAccess.customHostname.host;
      await h.metadata.set(SystemMetadataKey.FrameleafCloudLink, { status: 'unlinked', cloudUrl: h.link.cloudUrl });
      h.config.frameleafCloud.remoteAccess.customHostname.host = '';
    });
    resume.resolve();
    await Promise.all([operation, cleanup]);
    expect(observed).toBe('new.example.com');
    expect(h.config.frameleafCloud.remoteAccess.customHostname.host).toBe('');
  } finally {
    resume.resolve();
    await Promise.allSettled([operation, ...(cleanup ? [cleanup] : [])]);
    await h.restore();
  }
});

it('invalidates relay usage after another PostgreSQL lifecycle owner commits a new link generation', async () => {
  const h = await setup(),
    now = Date.now();
  try {
    h.ctx
      .getMock(FrameleafCloudRepository)
      .requestJson.mockResolvedValue(cloudContractFixture('remote/remote-usage.json'));
    await h.sut.getUsage(authStub.admin, now);
    await h.owner.ctx
      .get(DatabaseRepository)
      .withLock(DatabaseLock.FrameleafHeartbeat, () =>
        h.metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...h.link, linkedAt: 'new-generation' }),
      );
    h.ctx.getMock(FrameleafCloudRepository).requestJson.mockResolvedValueOnce({
      ...cloudContractFixture<Record<string, unknown>>('remote/remote-usage.json'),
      bytes: 2,
    } as never);
    await expect(h.sut.getUsage(authStub.admin, now + 1000)).resolves.toMatchObject({ bytes: 2 });
    expect(h.ctx.getMock(FrameleafCloudRepository).requestJson).toHaveBeenCalledTimes(2);
  } finally {
    await h.restore();
  }
});

it('publishes desired state with its configuration before another PostgreSQL heartbeat owner observes them', async () => {
  const h = await setup(),
    entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  h.write.mockImplementationOnce(async (change) => {
    const value = h.apply(change);
    entered.resolve();
    await resume.promise;
    return value;
  });
  const operation = h.sut.update(authStub.admin, { enabled: true });
  let beat: Promise<void> | undefined;
  try {
    await Promise.race([
      entered.promise,
      operation.then(() => {
        throw new Error('Remote update skipped configuration');
      }),
    ]);
    expect(await lockAvailability()).toEqual({ lifecycle: false, publication: true });
    let observed: boolean[] | undefined;
    beat = h.owner.ctx.get(DatabaseRepository).withLock(DatabaseLock.FrameleafHeartbeat, async () => {
      const current = await h.metadata.get(SystemMetadataKey.FrameleafCloudLink);
      observed = [h.config.frameleafCloud.remoteAccess.enabled, current?.desired?.remoteAccess ?? false];
      h.config.frameleafCloud.remoteAccess.enabled = false;
      await h.metadata.set(SystemMetadataKey.FrameleafCloudLink, {
        ...current!,
        desired: { remoteAccess: false, cloudBackup: false },
      });
    });
    resume.resolve();
    await Promise.all([operation, beat]);
    expect(observed).toEqual([true, true]);
    expect(h.config.frameleafCloud.remoteAccess.enabled).toBe(
      (await h.metadata.get(SystemMetadataKey.FrameleafCloudLink))?.desired?.remoteAccess,
    );
  } finally {
    resume.resolve();
    await Promise.allSettled([operation, ...(beat ? [beat] : [])]);
    await h.restore();
  }
});

const lockAvailability = () =>
  db.transaction().execute(async (tx) => {
    const { rows } = await sql<{
      lifecycle: boolean;
      publication: boolean;
    }>`select pg_try_advisory_xact_lock(${DatabaseLock.FrameleafHeartbeat}::bigint) as lifecycle, pg_try_advisory_xact_lock(${DatabaseLock.FrameleafLinkAuthority}::bigint) as publication`.execute(
      tx,
    );
    return rows[0];
  });

const setup = async () => {
  const env = mockEnvData({});
  const options = {
    database: db,
    real: [DatabaseRepository, SystemMetadataRepository],
    mock: [ConfigRepository, EventRepository, FrameleafCloudRepository, LoggingRepository],
  };
  const { sut, ctx } = newMediumService(FrameleafRemoteAccessService, options),
    owner = newMediumService(FrameleafRemoteAccessService, options);
  const url = 'https://api.frameleaf.cloud';
  for (const context of [ctx, owner.ctx]) {
    context
      .getMock(ConfigRepository)
      .getEnv.mockReturnValue({ ...env, frameleafCloud: { ...env.frameleafCloud, url } });
    context.getMock(EventRepository).emit.mockResolvedValue();
    context
      .getMock(FrameleafCloudRepository)
      .discovery.mockResolvedValue(cloudContractFixture('instance/discovery.json'));
    context.getMock(FrameleafCloudRepository).requestJson.mockResolvedValue({} as never);
  }
  const config = {
    frameleafCloud: {
      remoteAccess: {
        enabled: false,
        mode: 'relay',
        directPort: 2443,
        portMapping: true,
        publicUrl: 'frameleaf',
        customHostname: { host: 'photos.example.com', status: 'verified', checkedAt: null },
      },
    },
  };
  const internal = sut as unknown as { getConfig: () => Promise<unknown>; session: () => Promise<unknown> };
  vi.spyOn(internal, 'getConfig').mockImplementation(() => Promise.resolve(config));
  vi.spyOn(internal, 'session').mockResolvedValue({
    document: cloudContractFixture('instance/discovery.json'),
    token: { signer: { kid: 'fixture' } },
  });
  vi.spyOn(sut, 'getStatus').mockResolvedValue({} as never);
  const apply = (change: Parameters<typeof sut.updateConfigExclusively>[0]) => {
    const oldConfig = structuredClone(config);
    change(config as never);
    return { oldConfig, newConfig: structuredClone(config) } as never;
  };
  const write = vi.spyOn(sut, 'updateConfigExclusively').mockImplementation((change) => Promise.resolve(apply(change)));
  const metadata = ctx.get(SystemMetadataRepository),
    previous = await metadata.get(SystemMetadataKey.FrameleafCloudLink),
    previousLicense = await metadata.get(SystemMetadataKey.FrameleafLicense);
  const link: FrameleafCloudLink = {
    status: 'linked',
    cloudUrl: url,
    instanceId: 'instance',
    accountId: 'owner',
    linkedAt: 'generation',
    desired: { remoteAccess: false, cloudBackup: false },
  };
  const now = Math.floor(Date.now() / 1000);
  const plan: FrameleafLicense = {
    certificate: 'synthetic',
    kind: 'plan',
    source: 'account',
    kid: 'signer',
    verifiedAt: new Date().toISOString(),
    claims: {
      iss: 'https://id.frameleaf.cloud',
      aud: 'frameleaf-server',
      sub: 'owner',
      iid: 'instance',
      ent: ['CLOUD', 'REMOTE_ACCESS'],
      lic_exp: now + 86_400,
      iat: now,
      exp: now + 86_400,
    },
  };
  await metadata.set(SystemMetadataKey.FrameleafCloudLink, link);
  await metadata.set(SystemMetadataKey.FrameleafLicense, { key: null, plan });
  const restore = async () => {
    if (previous) await metadata.set(SystemMetadataKey.FrameleafCloudLink, previous);
    else await metadata.delete(SystemMetadataKey.FrameleafCloudLink);
    if (previousLicense) await metadata.set(SystemMetadataKey.FrameleafLicense, previousLicense);
    else await metadata.delete(SystemMetadataKey.FrameleafLicense);
  };
  return { sut, ctx, owner, config, metadata, link, write, apply, restore };
};
