import { AsyncLocalStorage } from 'node:async_hooks';
import type { FrameleafCloudLink, FrameleafLicense } from 'src/types.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { FrameleafRemoteAccessService } from 'src/services/frameleaf-remote-access.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { ServiceOverrides, newTestService } from 'test/utils.js';

const setup = () => {
  const { sut, mocks } = newTestService(FrameleafRemoteAccessService);
  const { sut: cloud } = newTestService(FrameleafCloudService, mocks as unknown as ServiceOverrides);
  const cloudUrl = 'https://api.frameleaf.cloud';
  const link: FrameleafCloudLink = {
    status: 'linked',
    cloudUrl,
    instanceId: 'instance',
    accountId: 'owner',
    linkedAt: 'generation',
    desired: { remoteAccess: true, cloudBackup: false },
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
  const metadata = new Map<string, unknown>([
    [SystemMetadataKey.FrameleafCloudLink, link],
    [SystemMetadataKey.FrameleafLicense, { key: null, plan }],
  ]);
  const config = {
    server: { name: 'Fixture' },
    frameleafCloud: {
      cloudMl: { enabled: true },
      remoteAccess: {
        enabled: true,
        mode: 'relay',
        directPort: 2443,
        portMapping: true,
        publicUrl: 'custom',
        customHostname: { host: 'photos.example.com', status: 'verified', checkedAt: null },
      },
    },
  };
  const effects: string[] = [];
  const held = new AsyncLocalStorage<DatabaseLock[]>(),
    tails = new Map<DatabaseLock, Promise<unknown>>(),
    contended = Promise.withResolvers<void>();
  mocks.database.withLock.mockImplementation((lock, action) => {
    const parent = held.getStore() ?? [];
    if (parent.includes(lock)) throw new Error('Reentrant lifecycle lock');
    const prior = tails.get(lock);
    if (prior && lock === DatabaseLock.FrameleafHeartbeat) contended.resolve();
    const next = (prior ?? Promise.resolve()).then(() => held.run([...parent, lock], action));
    const done = next.catch(() => {});
    tails.set(lock, done);
    void done.then(() => {
      if (tails.get(lock) === done) tails.delete(lock);
    });
    return next as never;
  });
  const env = mocks.config.getEnv();
  mocks.config.getEnv.mockReturnValue({ ...env, frameleafCloud: { ...env.frameleafCloud, url: cloudUrl } });
  mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
  mocks.systemMetadata.set.mockImplementation((key, value) => {
    metadata.set(key, value);
    if (key === SystemMetadataKey.FrameleafCloudLink && (value as FrameleafCloudLink).status === 'unlinked')
      effects.push('unlinked');
    if (key === SystemMetadataKey.FrameleafRemoteAccessTest) effects.push('remote:test-published');
    return Promise.resolve();
  });
  mocks.systemMetadata.delete.mockImplementation((key) => {
    metadata.delete(key);
    return Promise.resolve();
  });
  mocks.frameleafAccount.deleteAllSessions.mockResolvedValue([]);
  mocks.user.getAdmins.mockResolvedValue([]);
  mocks.event.emit.mockResolvedValue();
  vi.spyOn(sut, 'getStatus').mockResolvedValue({} as never);
  vi.spyOn(cloud, 'getStatus').mockResolvedValue({} as never);
  const internal = sut as unknown as {
    getConfig: () => Promise<unknown>;
    session: () => Promise<unknown>;
    probe: () => Promise<{ ok: boolean; detail: string }>;
  };
  const cloudInternal = cloud as unknown as { apiToken: () => Promise<unknown>; clearKeyRecovery: () => Promise<void> };
  const document = cloudContractFixture('instance/discovery.json');
  const session = { document, token: { signer: { kid: 'fixture' } } };
  vi.spyOn(internal, 'getConfig').mockImplementation(() => Promise.resolve(config));
  vi.spyOn(internal, 'session').mockResolvedValue(session);
  vi.spyOn(cloudInternal, 'apiToken').mockResolvedValue(session);
  vi.spyOn(cloudInternal, 'clearKeyRecovery').mockResolvedValue();
  const write = (change: Parameters<typeof sut.updateConfigExclusively>[0]) => {
    const oldConfig = structuredClone(config);
    change(config as never);
    if (!oldConfig.frameleafCloud.remoteAccess.enabled && config.frameleafCloud.remoteAccess.enabled)
      effects.push('remote:enabled');
    if (
      config.frameleafCloud.remoteAccess.customHostname.host &&
      oldConfig.frameleafCloud.remoteAccess.customHostname.host !==
        config.frameleafCloud.remoteAccess.customHostname.host
    )
      effects.push('remote:hostname');
    return { oldConfig, newConfig: structuredClone(config) } as never;
  };
  vi.spyOn(sut, 'updateConfigExclusively').mockImplementation((change) => Promise.resolve(write(change)));
  vi.spyOn(cloud, 'updateConfigExclusively').mockImplementation((change) => Promise.resolve(write(change)));
  mocks.frameleafCloud.discovery.mockResolvedValue(document);
  const answer = (request: { method?: string; url: string; body?: unknown }) => {
    if (!request.url.includes('/remote/')) return {};
    effects.push('remote:provider');
    if (request.url.endsWith('/usage')) return cloudContractFixture('remote/remote-usage.json');
    if (request.method === 'DELETE') return {};
    const hostname = {
      ...cloudContractFixture('remote/hostnames-list.json').hostnames[0],
      hostname: (request.body as { hostname?: string } | undefined)?.hostname ?? 'photos.example.com',
    };
    return request.method === 'PUT' ? hostname : { hostnames: [hostname] };
  };
  mocks.frameleafCloud.requestJson.mockImplementation((_schema, request) => {
    expect(held.getStore() ?? []).not.toContain(DatabaseLock.FrameleafLinkAuthority);
    return Promise.resolve(answer(request) as never);
  });
  const probe = vi.spyOn(internal, 'probe').mockResolvedValue({ ok: true, detail: 'mocked direct probe' });
  const gate = () => {
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    return { entered: entered.promise, enter: entered.resolve, resume: resume.resolve, wait: resume.promise };
  };
  return {
    sut,
    cloud,
    mocks,
    metadata,
    config,
    effects,
    link,
    answer,
    write,
    probe,
    gate,
    contended: contended.promise,
    current: () => metadata.get(SystemMetadataKey.FrameleafCloudLink) as FrameleafCloudLink,
  };
};

it('remote enable rechecks link availability after an in-flight unlink finishes', async () => {
  const h = setup(),
    gate = h.gate();
  h.config.frameleafCloud.remoteAccess.enabled = false;
  h.mocks.frameleafCloud.requestJson.mockImplementationOnce(async () => {
    gate.enter();
    await gate.wait;
    return {} as never;
  });
  const unlink = h.cloud.unlink(authStub.admin);
  await gate.entered;
  const operation = h.sut.update(authStub.admin, { enabled: true });
  const settled = operation.then(() => ({ ok: true })).catch((error: unknown) => ({ ok: false, error }));
  try {
    await h.contended;
    gate.resume();
    await unlink;
    expect(await settled).toMatchObject({ ok: false, error: { status: 400 } });
    expect(h.config.frameleafCloud.remoteAccess.enabled).toBe(false);
  } finally {
    gate.resume();
    await Promise.allSettled([unlink, operation]);
  }
});

it('publishes configuration and desired state before another heartbeat can change them', async () => {
  const h = setup(),
    gate = h.gate();
  h.config.frameleafCloud.remoteAccess.enabled = false;
  vi.mocked(h.sut.updateConfigExclusively).mockImplementationOnce(async (change) => {
    const value = h.write(change);
    gate.enter();
    await gate.wait;
    return value;
  });
  const operation = h.sut.update(authStub.admin, { enabled: true });
  await gate.entered;
  const beat = h.mocks.database.withLock(DatabaseLock.FrameleafHeartbeat, () => {
    h.config.frameleafCloud.remoteAccess.enabled = false;
    h.metadata.set(SystemMetadataKey.FrameleafCloudLink, {
      ...h.current(),
      desired: { remoteAccess: false, cloudBackup: false },
    });
    return Promise.resolve();
  });
  try {
    await Promise.race([beat, h.contended]);
    gate.resume();
    await Promise.all([operation, beat]);
    expect(h.config.frameleafCloud.remoteAccess.enabled).toBe(h.current().desired?.remoteAccess);
  } finally {
    gate.resume();
    await Promise.allSettled([operation, beat]);
  }
});

it.each(['set-host', 'check-host', 'remove-host', 'usage', 'self-test'] as const)(
  'unlink drains an in-flight %s operation before cleanup',
  async (kind) => {
    const h = setup(),
      gate = h.gate();
    if (kind === 'self-test') {
      h.metadata.set(SystemMetadataKey.FrameleafRemoteAccess, {
        status: 'ready',
        updatedAt: new Date().toISOString(),
        certificate: { names: ['fixture'], notAfter: new Date(Date.now() + 86_400_000).toISOString() },
        names: {},
        relay: { connected: true },
        direct: { listening: true, port: 2443 },
      });
      h.probe.mockImplementationOnce(async () => {
        gate.enter();
        await gate.wait;
        h.effects.push('remote:probe');
        return { ok: true, detail: 'mocked direct probe' };
      });
    } else
      h.mocks.frameleafCloud.requestJson.mockImplementationOnce(async (_schema, request) => {
        gate.enter();
        await gate.wait;
        return h.answer(request) as never;
      });
    const operation =
      kind === 'set-host'
        ? h.sut.setCustomHostname(authStub.admin, { hostname: 'new.example.com' })
        : kind === 'check-host'
          ? h.sut.checkCustomHostname(authStub.admin)
          : kind === 'remove-host'
            ? h.sut.removeCustomHostname(authStub.admin)
            : kind === 'usage'
              ? h.sut.getUsage(authStub.admin)
              : h.sut.test(authStub.admin);
    await gate.entered;
    const unlink = h.cloud.unlink(authStub.admin);
    try {
      await Promise.race([unlink, h.contended]);
      gate.resume();
      await Promise.all([operation, unlink]);
      const ended = h.effects.indexOf('unlinked');
      expect(ended).toBeGreaterThanOrEqual(0);
      expect(h.effects.slice(ended + 1).filter((value) => value.startsWith('remote:'))).toEqual([]);
      expect(h.config.frameleafCloud.remoteAccess.customHostname.host).toBe('');
    } finally {
      gate.resume();
      await Promise.allSettled([operation, unlink]);
    }
  },
);

it.each(['owner', 'generation', 'cloud', 'instance'] as const)(
  'invalidates relay usage cache after %s authority replacement',
  async (kind) => {
    const h = setup(),
      now = Date.now();
    await h.sut.getUsage(authStub.admin, now);
    const cloudUrl = kind === 'cloud' ? 'https://api.other.test' : h.link.cloudUrl;
    h.metadata.set(SystemMetadataKey.FrameleafCloudLink, {
      ...h.link,
      cloudUrl,
      accountId: kind === 'owner' ? 'new-owner' : h.link.accountId,
      linkedAt: kind === 'generation' ? 'new-generation' : h.link.linkedAt,
      instanceId: kind === 'instance' ? 'new-instance' : h.link.instanceId,
    });
    const env = h.mocks.config.getEnv();
    h.mocks.config.getEnv.mockReturnValue({ ...env, frameleafCloud: { ...env.frameleafCloud, url: cloudUrl } });
    h.mocks.frameleafCloud.requestJson.mockResolvedValueOnce({
      ...cloudContractFixture('remote/remote-usage.json'),
      bytes: 2,
    } as never);
    await expect(h.sut.getUsage(authStub.admin, now + 1000)).resolves.toMatchObject({ bytes: 2 });
    expect(h.mocks.frameleafCloud.requestJson).toHaveBeenCalledTimes(2);
  },
);

it('does not extend a usage cache entry when the clock moves backwards', async () => {
  const h = setup(),
    now = Date.now();
  await h.sut.getUsage(authStub.admin, now);
  h.mocks.frameleafCloud.requestJson.mockResolvedValueOnce({
    ...cloudContractFixture('remote/remote-usage.json'),
    bytes: 2,
  } as never);
  await expect(h.sut.getUsage(authStub.admin, now - 1)).resolves.toMatchObject({ bytes: 2 });
});

it('keeps a fresh usage cache across contact/display changes, and refetches at its deadline', async () => {
  const h = setup(),
    now = Date.now();
  const first = await h.sut.getUsage(authStub.admin, now);
  h.metadata.set(SystemMetadataKey.FrameleafCloudLink, {
    ...h.link,
    accountLabel: 'New display name',
    lastContactAt: new Date().toISOString(),
  });
  await expect(h.sut.getUsage(authStub.admin, now + 59_999)).resolves.toEqual(first);
  expect(h.mocks.frameleafCloud.requestJson).toHaveBeenCalledOnce();
  await h.sut.getUsage(authStub.admin, now + 60_000);
  expect(h.mocks.frameleafCloud.requestJson).toHaveBeenCalledTimes(2);
});
