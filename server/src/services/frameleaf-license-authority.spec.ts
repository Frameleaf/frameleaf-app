import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseRepository } from 'src/repositories/database.repository.js';
import type { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import type { UserRepository } from 'src/repositories/user.repository.js';
import type { FrameleafCloudLink, FrameleafLicense, FrameleafLicenseStore } from 'src/types.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { FrameleafLicenseService } from 'src/services/frameleaf-license.service.js';
import { newTestService } from 'test/utils.js';

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

const setup = () => {
  const { sut, mocks } = newTestService(FrameleafLicenseService);
  const link: FrameleafCloudLink = {
    status: 'linked',
    cloudUrl: 'https://cloud.test',
    instanceId: 'instance',
    accountId: 'owner',
    linkedAt: '2026-10-16T00:00:00Z',
  };
  const metadata = new Map<string, unknown>([
    [SystemMetadataKey.FrameleafCloudLink, link],
    [
      SystemMetadataKey.FrameleafLicense,
      { key: license('supporter', 'server'), plan: license('old-plan'), noticeState: 'active' },
    ],
  ]);
  const env = mocks.config.getEnv();
  mocks.config.getEnv.mockReturnValue({ ...env, frameleafCloud: { ...env.frameleafCloud, url: link.cloudUrl } });
  mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
  mocks.systemMetadata.set.mockImplementation((key, value) => {
    metadata.set(key, value);
    return Promise.resolve();
  });
  mocks.systemMetadata.delete.mockImplementation((key) => {
    metadata.delete(key);
    return Promise.resolve();
  });
  mocks.user.getAdmins.mockResolvedValue([]);
  const held = new AsyncLocalStorage<DatabaseLock[]>();
  const contended = Promise.withResolvers<void>();
  const tails = new Map<DatabaseLock, Promise<unknown>>();
  mocks.database.withLock.mockImplementation((key, action) => {
    const previous = tails.get(key);
    if (previous && key === DatabaseLock.FrameleafLicenseRefresh) contended.resolve();
    const result = (previous ?? Promise.resolve()).then(() => held.run([...(held.getStore() ?? []), key], action));
    const done = result.catch(() => {});
    tails.set(key, done);
    void done.then(() => {
      if (tails.get(key) === done) tails.delete(key);
    });
    return result as never;
  });
  const internals = sut as unknown as {
    apiToken: () => Promise<unknown>;
    verifyForStore: (certificate: string) => Promise<unknown>;
  };
  vi.spyOn(internals, 'apiToken').mockResolvedValue({ document: { api: 'https://api.cloud.test' }, token: {} });
  vi.spyOn(internals, 'verifyForStore').mockImplementation((certificate) =>
    Promise.resolve(license(certificate, certificate === 'supporter' ? 'server' : 'plan')),
  );
  mocks.frameleafCloud.requestJson.mockResolvedValue({ certificates: ['new-plan', 'supporter'] } as never);
  const { sut: cloud, mocks: cloudMocks } = newTestService(FrameleafCloudService, {
    config: mocks.config,
    // Both services share the licence service's mocks; a mock lacks the repositories' private
    // members, so it needs the same cast newTestService applies to its own mocks.
    database: mocks.database as unknown as DatabaseRepository,
    systemMetadata: mocks.systemMetadata as unknown as SystemMetadataRepository,
    user: mocks.user as unknown as UserRepository,
  });
  cloudMocks.frameleafAccount.deleteAllSessions.mockResolvedValue([]);
  const cloudInternals = cloud as unknown as {
    clearLink: (url: string, link: FrameleafCloudLink, status: 'unlinked' | 'revoked') => Promise<void>;
    updateConfigExclusively: () => Promise<unknown>;
  };
  vi.spyOn(cloudInternals, 'updateConfigExclusively').mockResolvedValue({
    oldConfig: { frameleafCloud: {} },
    newConfig: { frameleafCloud: {} },
  });
  const clear = () => cloudInternals.clearLink(link.cloudUrl!, link, 'unlinked');
  const store = () => metadata.get(SystemMetadataKey.FrameleafLicense) as FrameleafLicenseStore;
  const delayResponse = (fail: boolean) => {
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    mocks.frameleafCloud.requestJson.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      if (fail) throw new Error('issuer unavailable');
      return { certificates: ['new-plan', 'supporter'] } as never;
    });
    return { entered: entered.promise, resume: resume.resolve };
  };
  return { sut, mocks, cloud, metadata, link, clear, store, delayResponse, held, contended: contended.promise };
};

it.each([false, true])('unlink drains an in-flight licence refresh (issuer failure: %s)', async (fail) => {
  const h = setup(),
    gate = h.delayResponse(fail);
  const refresh = h.sut.handleRefresh({ force: true });
  await gate.entered;
  const unlink = h.clear();
  try {
    await Promise.race([unlink, h.contended]);
    gate.resume();
    await Promise.all([refresh, unlink]);
    expect(h.store().plan).toBeNull();
    expect(h.store().key?.claims.jti).toBe('supporter');
  } finally {
    gate.resume();
    await Promise.allSettled([refresh, unlink]);
  }
});

describe.each(['generation', 'account', 'instance', 'revoked', 'cloud'] as const)('%s authority change', (change) => {
  it.each([false, true])('discards a refresh (issuer failure: %s)', async (fail) => {
    const h = setup(),
      gate = h.delayResponse(fail);
    const refresh = h.sut.handleRefresh({ force: true });
    await gate.entered;
    try {
      const patch =
        change === 'generation'
          ? { linkedAt: 'replacement-generation' }
          : change === 'account'
            ? { accountId: 'new-owner' }
            : change === 'instance'
              ? { instanceId: 'new-instance' }
              : change === 'revoked'
                ? { status: 'revoked' }
                : { cloudUrl: 'https://new.cloud.test' };
      h.metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...h.link, ...patch });
      const replacement = {
        key: license('new-supporter', 'server'),
        plan: license('replacement-plan'),
        noticeState: 'active',
      };
      h.metadata.set(SystemMetadataKey.FrameleafLicense, replacement);
      gate.resume();
      await refresh;
      expect(h.store()).toEqual(replacement);
    } finally {
      gate.resume();
      await Promise.allSettled([refresh]);
    }
  });
});

it.each(['contact', 'legacy'] as const)('retains unchanged %s authority', async (mode) => {
  const h = setup(),
    gate = h.delayResponse(false);
  if (mode === 'legacy') {
    delete h.link.linkedAt;
  }
  const refresh = h.sut.handleRefresh({ force: true });
  await gate.entered;
  try {
    h.metadata.set(SystemMetadataKey.FrameleafCloudLink, {
      ...h.link,
      accountLabel: 'Updated label',
      lastContactAt: new Date().toISOString(),
    });
    gate.resume();
    await refresh;
    expect(h.store().plan?.claims.jti).toBe('new-plan');
  } finally {
    gate.resume();
    await Promise.allSettled([refresh]);
  }
});

it('refuses stale unlink cleanup after the Cloud link was replaced', async () => {
  const h = setup();
  h.metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...h.link, linkedAt: 'replacement-generation' });
  const replacement = h.store();
  await expect(h.clear()).rejects.toMatchObject({ status: 409 });
  expect(h.metadata.get(SystemMetadataKey.FrameleafCloudLink)).toMatchObject({
    status: 'linked',
    linkedAt: 'replacement-generation',
  });
  expect(h.store()).toEqual(replacement);
});

it('plan cleanup does not overwrite a concurrent supporter-key update', async () => {
  const h = setup();
  const read = h.mocks.systemMetadata.get.getMockImplementation()!;
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  let paused = false;
  h.mocks.systemMetadata.get.mockImplementation(async (key) => {
    const value = await read(key);
    if (key === SystemMetadataKey.FrameleafLicense && !paused) {
      paused = true;
      entered.resolve();
      await resume.promise;
    }
    return value;
  });
  const unlink = h.clear();
  await entered.promise;
  const update = h.mocks.database.withLock(DatabaseLock.FrameleafLicenseRefresh, () => {
    h.metadata.set(SystemMetadataKey.FrameleafLicense, { ...h.store(), key: license('new-supporter', 'server') });
    return Promise.resolve();
  });
  try {
    await Promise.race([update, h.contended]);
    resume.resolve();
    await Promise.all([unlink, update]);
    expect(h.store().plan).toBeNull();
    expect(h.store().key?.claims.jti).toBe('new-supporter');
  } finally {
    resume.resolve();
    await Promise.allSettled([unlink, update]);
  }
});

it('does not roll back a committed refresh when its store acknowledgement fails', async () => {
  const h = setup();
  const write = h.mocks.systemMetadata.set.getMockImplementation()!;
  let failed = false;
  h.mocks.systemMetadata.set.mockImplementation(async (key, value) => {
    await write(key, value);
    if (key === SystemMetadataKey.FrameleafLicense && !failed) {
      failed = true;
      throw new Error('store acknowledgement lost');
    }
  });
  await expect(h.sut.handleRefresh({ force: true })).rejects.toThrow('store acknowledgement lost');
  expect(h.store().plan?.claims.jti).toBe('new-plan');
});

it('keeps replacement links fenced through plan cleanup', async () => {
  const h = setup();
  const read = h.mocks.systemMetadata.get.getMockImplementation()!;
  let held: DatabaseLock[] | undefined;
  h.mocks.systemMetadata.get.mockImplementation((key) => {
    if (key === SystemMetadataKey.FrameleafLicense) held = h.held.getStore();
    return read(key);
  });
  await h.clear();
  expect(held).toEqual(
    expect.arrayContaining([DatabaseLock.FrameleafLicenseRefresh, DatabaseLock.FrameleafLinkAuthority]),
  );
  expect(h.store().plan).toBeNull();
});
