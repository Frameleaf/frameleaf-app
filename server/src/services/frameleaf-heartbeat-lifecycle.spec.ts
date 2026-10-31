import { AsyncLocalStorage } from 'node:async_hooks';
import type { FrameleafCloudLink } from 'src/types.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { newTestService } from 'test/utils.js';

type Stage = 'heartbeat' | 'hostname' | 'suspension' | 'command-ack' | 'key-command' | 'key-recovery';
const setup = (stage: Stage = 'heartbeat') => {
  const { sut, mocks } = newTestService(FrameleafCloudService);
  const link: FrameleafCloudLink = {
    status: 'linked',
    cloudUrl: 'https://api.frameleaf.cloud',
    instanceId: 'instance',
    accountId: 'owner',
    linkedAt: 'generation',
    permissions: { allowRemoteEnable: true, allowBackupTrigger: true, allowEntitlementRefresh: true },
  };
  const metadata = new Map<string, unknown>([[SystemMetadataKey.FrameleafCloudLink, link]]);
  const config = {
    server: { name: 'Fixture' },
    frameleafCloud: {
      cloudMl: { enabled: true },
      signIn: { showOnLocalLogin: false },
      remoteAccess: {
        enabled: false,
        allowOriginalsOverRelay: false,
        allowPasswordOverRelay: false,
        customHostname: { host: '', status: 'pending', checkedAt: null },
      },
    },
  };
  const effects: string[] = [];
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>(),
    contended = Promise.withResolvers<void>();
  const step = async (name: Stage | 'pricing' | 'retired-key') => {
    if (name === stage) {
      entered.resolve();
      await resume.promise;
    }
    effects.push(`beat:${name}`);
  };
  const held = new AsyncLocalStorage<DatabaseLock[]>(),
    tails = new Map<DatabaseLock, Promise<unknown>>();
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
  mocks.config.getEnv.mockReturnValue({ ...env, frameleafCloud: { ...env.frameleafCloud, url: link.cloudUrl } });
  mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
  mocks.systemMetadata.set.mockImplementation((key, value) => {
    metadata.set(key, value);
    if (key === SystemMetadataKey.FrameleafCloudLink && (value as FrameleafCloudLink).status === 'unlinked')
      effects.push('unlinked');
    return Promise.resolve();
  });
  mocks.systemMetadata.delete.mockImplementation((key) => {
    metadata.delete(key);
    return Promise.resolve();
  });
  mocks.frameleafAccount.deleteAllSessions.mockResolvedValue([]);
  mocks.user.getAdmins.mockResolvedValue([]);
  mocks.event.emit.mockResolvedValue();
  mocks.job.queue.mockImplementation(() => {
    effects.push('beat:licence-queue');
    return Promise.resolve();
  });
  vi.spyOn(sut, 'getStatus').mockResolvedValue({} as never);
  vi.spyOn(sut, 'updateConfigExclusively').mockImplementation((change) => {
    const oldConfig = structuredClone(config);
    change(config as never);
    if (!oldConfig.frameleafCloud.remoteAccess.enabled && config.frameleafCloud.remoteAccess.enabled)
      effects.push('beat:remote-on');
    return Promise.resolve({ oldConfig, newConfig: structuredClone(config) } as never);
  });
  const internal = sut as unknown as {
    apiToken: () => Promise<unknown>;
    buildHeartbeatPayload: () => Promise<unknown>;
    getConfig: () => Promise<unknown>;
    clearKeyRecovery: () => Promise<void>;
    refreshCustomHostnameAfterServicesChanged: (url: string, link: FrameleafCloudLink) => Promise<FrameleafCloudLink>;
    followCloneSuspicion: () => Promise<void>;
    rotateOnCommand: () => Promise<void>;
    rotateAfterDamagedKey: (url: string, document: unknown, link: FrameleafCloudLink) => Promise<FrameleafCloudLink>;
    keepPublishedPricing: () => Promise<void>;
    removeRetiredKey: () => Promise<void>;
  };
  vi.spyOn(internal, 'getConfig').mockImplementation(() => Promise.resolve(config));
  vi.spyOn(internal, 'apiToken').mockResolvedValue({
    document: cloudContractFixture('instance/discovery.json'),
    token: { signer: { kid: 'fixture' } },
  });
  vi.spyOn(internal, 'buildHeartbeatPayload').mockResolvedValue({});
  vi.spyOn(internal, 'clearKeyRecovery').mockResolvedValue();
  vi.spyOn(internal, 'refreshCustomHostnameAfterServicesChanged').mockImplementation(async (_url, value) => {
    await step('hostname');
    return value;
  });
  vi.spyOn(internal, 'followCloneSuspicion').mockImplementation(async () => {
    await step('suspension');
    metadata.set(SystemMetadataKey.FrameleafMlSuspension, { fixture: true });
  });
  vi.spyOn(internal, 'rotateOnCommand').mockImplementation(() => step('key-command'));
  vi.spyOn(internal, 'rotateAfterDamagedKey').mockImplementation(async (_url, _document, value) => {
    await step('key-recovery');
    return value;
  });
  vi.spyOn(internal, 'keepPublishedPricing').mockImplementation(() => step('pricing'));
  vi.spyOn(internal, 'removeRetiredKey').mockImplementation(() => step('retired-key'));
  mocks.frameleafCloud.requestJson.mockImplementation(async (_schema, request) => {
    expect(held.getStore()).not.toContain(DatabaseLock.FrameleafLinkAuthority);
    if (request.method === 'DELETE') return {} as never;
    if (request.url.endsWith('/heartbeat')) {
      await step('heartbeat');
      return {
        cloneSuspected: true,
        servicesChanged: true,
        entitlementsChanged: true,
        notices: [],
        commands: [
          { id: 'remote', type: 'remote.enable' },
          { id: 'key', type: 'key.rotate' },
        ],
      } as never;
    }
    await step('command-ack');
    return {} as never;
  });
  return {
    sut,
    mocks,
    metadata,
    config,
    effects,
    entered: entered.promise,
    resume: resume.resolve,
    contended: contended.promise,
  };
};

it.each(['heartbeat', 'hostname', 'suspension', 'command-ack', 'key-command', 'key-recovery'] as const)(
  'unlink drains the %s phase before clearing Cloud authority and effects',
  async (stage) => {
    const h = setup(stage),
      checkIn = h.sut.handleHeartbeat({ force: true });
    await h.entered;
    const unlink = h.sut.unlink(authStub.admin);
    try {
      await Promise.race([unlink, h.contended]);
      h.resume();
      await Promise.all([checkIn, unlink]);
      const ended = h.effects.indexOf('unlinked');
      expect(ended).toBeGreaterThanOrEqual(0);
      expect(h.effects.slice(ended + 1).filter((effect) => effect.startsWith('beat:'))).toEqual([]);
      expect(h.config.frameleafCloud.remoteAccess.enabled).toBe(false);
      expect(h.metadata.has(SystemMetadataKey.FrameleafMlSuspension)).toBe(false);
    } finally {
      h.resume();
      await Promise.allSettled([checkIn, unlink]);
    }
  },
);

it('permission removal acknowledges after the current check-in, and the next check-in refuses that command', async () => {
  const h = setup(),
    checkIn = h.sut.handleHeartbeat({ force: true });
  await h.entered;
  let atAcknowledgement = -1;
  const change = h.sut.updatePermissions(authStub.admin, { allowRemoteEnable: false }).then(() => {
    atAcknowledgement = h.effects.filter((effect) => effect === 'beat:remote-on').length;
  });
  try {
    await Promise.race([change, h.contended]);
    h.resume();
    await Promise.all([checkIn, change]);
    expect(h.effects.filter((effect) => effect === 'beat:remote-on')).toHaveLength(atAcknowledgement);
    await h.sut.handleHeartbeat({ force: true });
    expect(h.effects.filter((effect) => effect === 'beat:remote-on')).toHaveLength(atAcknowledgement);
    expect(h.mocks.frameleafCloud.requestJson).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        url: expect.stringContaining('/commands/remote/ack'),
        body: { result: 'refused', detail: expect.stringContaining('allowRemoteEnable is off') },
      }),
    );
  } finally {
    h.resume();
    await Promise.allSettled([checkIn, change]);
  }
});

it.each(['sign-in', 'remote-access'] as const)(
  '%s settings recheck the link after waiting for lifecycle ownership',
  async (kind) => {
    const h = setup(),
      entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    const owner = h.mocks.database.withLock(DatabaseLock.FrameleafHeartbeat, async () => {
      entered.resolve();
      await resume.promise;
      h.metadata.set(SystemMetadataKey.FrameleafCloudLink, {
        status: 'unlinked',
        cloudUrl: 'https://api.frameleaf.cloud',
      });
    });
    await entered.promise;
    const operation =
      kind === 'sign-in'
        ? h.sut.updateSignIn(authStub.admin, { showOnLocalLogin: true })
        : h.sut.updateRemoteAccess(authStub.admin, { allowPasswordOverRelay: true });
    const settled = operation.then(() => ({ ok: true })).catch((error: unknown) => ({ ok: false, error }));
    try {
      await Promise.race([settled, h.contended]);
      resume.resolve();
      await owner;
      expect(await settled).toMatchObject({ ok: false, error: { status: 400 } });
    } finally {
      resume.resolve();
      await Promise.allSettled([owner, operation]);
    }
  },
);
