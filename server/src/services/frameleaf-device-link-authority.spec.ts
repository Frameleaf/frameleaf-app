import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrameleafCloudLink } from 'src/types.js';
import { DatabaseLock, MlAdmissionRefusal, SystemMetadataKey } from 'src/enum.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { newTestService } from 'test/utils.js';

const directories = new Set<string>();
afterEach(async () => {
  await Promise.all([...directories].map((path) => rm(path, { recursive: true, force: true })));
  directories.clear();
});
const url = 'https://api.frameleaf.cloud';
const pending = (code = 'device-1'): FrameleafCloudLink => ({
  status: 'pending',
  cloudUrl: url,
  permissions: { allowRemoteEnable: false, allowBackupTrigger: false, allowEntitlementRefresh: true },
  pending: {
    deviceCode: code,
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://id.frameleaf.cloud/device',
    verificationUriComplete: 'https://id.frameleaf.cloud/device?user_code=ABCD-EFGH',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    intervalSeconds: 5,
    nextPollAt: new Date(0).toISOString(),
  },
});
const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloud-device-authority-'));
  directories.add(directory);
  const { sut, mocks } = newTestService(FrameleafCloudService, { instanceIdentity: new InstanceIdentityRepository() });
  const metadata = new Map<string, unknown>();
  const env = mocks.config.getEnv();
  mocks.config.getEnv.mockReturnValue({
    ...env,
    setup: { ...env.setup, allow: true },
    frameleafCloud: { ...env.frameleafCloud, url, identityDir: directory },
  });
  mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
  mocks.systemMetadata.set.mockImplementation((key, value) => {
    metadata.set(key, value);
    return Promise.resolve();
  });
  mocks.systemMetadata.delete.mockImplementation((key) => {
    metadata.delete(key);
    return Promise.resolve();
  });
  mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
  mocks.user.getAdmins.mockResolvedValue([]);
  mocks.event.emit.mockResolvedValue();
  mocks.frameleafCloud.discovery.mockResolvedValue(cloudContractFixture('instance/discovery.json'));
  mocks.frameleafCloud.requestJson.mockResolvedValue(cloudContractFixture('instance/register-response.json'));
  vi.spyOn(sut, 'getStatus').mockResolvedValue({} as never);
  const internals = sut as unknown as { pollSafely: (url: string, link: FrameleafCloudLink) => Promise<void> };
  const set = (link: FrameleafCloudLink) => metadata.set(SystemMetadataKey.FrameleafCloudLink, link);
  const current = () => metadata.get(SystemMetadataKey.FrameleafCloudLink) as FrameleafCloudLink;
  const replace = (kind: 'cancelled' | 'pending' | 'linked') => {
    const next: FrameleafCloudLink =
      kind === 'pending'
        ? pending('device-2')
        : kind === 'linked'
          ? {
              status: 'linked',
              cloudUrl: url,
              instanceId: 'new-instance',
              accountId: 'new-owner',
              linkedAt: 'replacement-generation',
            }
          : { status: 'unlinked', cloudUrl: url };
    set(next);
    return next;
  };
  const gate = () => {
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    return { entered: entered.promise, enter: entered.resolve, resume: resume.resolve, wait: resume.promise };
  };
  return {
    sut,
    mocks,
    set,
    current,
    replace,
    gate,
    poll: (link: FrameleafCloudLink) => internals.pollSafely(url, link),
  };
};

describe.each(['cancelled', 'pending', 'linked'] as const)('replacement: %s', (replacement) => {
  it.each(['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'unknown_error'])(
    'drops a delayed %s poll result',
    async (error) => {
      const h = await setup(),
        link = pending(),
        gate = h.gate();
      h.set(link);
      h.mocks.frameleafCloud.requestOAuth.mockImplementationOnce(async () => {
        gate.enter();
        await gate.wait;
        return { ok: false, error } as never;
      });
      const operation = h.poll(link);
      try {
        await gate.entered;
        const next = h.replace(replacement);
        gate.resume();
        await operation;
        expect(h.current()).toEqual(next);
      } finally {
        gate.resume();
        await Promise.allSettled([operation]);
      }
    },
  );

  it('drops a registration response for an ended attempt', async () => {
    const h = await setup(),
      link = pending(),
      gate = h.gate();
    h.set(link);
    h.mocks.frameleafCloud.requestOAuth.mockResolvedValue({ ok: true, data: { access_token: 'synthetic-link-token' } });
    h.mocks.frameleafCloud.requestJson.mockImplementationOnce(async () => {
      gate.enter();
      await gate.wait;
      return cloudContractFixture('instance/register-response.json');
    });
    const operation = h.poll(link);
    try {
      await gate.entered;
      const next = h.replace(replacement);
      gate.resume();
      await operation;
      expect(h.current()).toEqual(next);
      expect(h.mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
      expect(h.mocks.event.emit).not.toHaveBeenCalled();
    } finally {
      gate.resume();
      await Promise.allSettled([operation]);
    }
  });
});

it('does not register a device approval whose attempt was cancelled while polling', async () => {
  const h = await setup(),
    link = pending(),
    gate = h.gate();
  h.set(link);
  h.mocks.frameleafCloud.requestOAuth.mockImplementationOnce(async () => {
    gate.enter();
    await gate.wait;
    return { ok: true, data: { access_token: 'synthetic-link-token' } };
  });
  const operation = h.poll(link);
  try {
    await gate.entered;
    const next = h.replace('cancelled');
    gate.resume();
    await operation;
    expect(h.current()).toEqual(next);
    expect(h.mocks.frameleafCloud.requestJson).not.toHaveBeenCalled();
  } finally {
    gate.resume();
    await Promise.allSettled([operation]);
  }
});

it('keeps an old poll transport error off a new pending attempt', async () => {
  const h = await setup(),
    link = pending(),
    gate = h.gate();
  h.set(link);
  h.mocks.frameleafCloud.requestOAuth.mockImplementationOnce(async () => {
    gate.enter();
    await gate.wait;
    throw new Error('old poll failed');
  });
  const operation = h.poll(link);
  try {
    await gate.entered;
    const next = h.replace('pending');
    gate.resume();
    await operation;
    expect(h.current()).toEqual(next);
  } finally {
    gate.resume();
    await Promise.allSettled([operation]);
  }
});

it('does not overwrite a linked server with a delayed device authorization', async () => {
  const h = await setup(),
    gate = h.gate();
  h.mocks.frameleafCloud.requestJson.mockImplementationOnce(async () => {
    gate.enter();
    await gate.wait;
    return {
      device_code: 'late-device',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://id.frameleaf.cloud/device',
      expires_in: 600,
      interval: 5,
    } as never;
  });
  const operation = h.sut.startLink(authStub.admin);
  const refused = expect(operation).rejects.toMatchObject({ status: 409 });
  try {
    await gate.entered;
    const next = h.replace('linked');
    gate.resume();
    await refused;
    expect(h.current()).toEqual(next);
  } finally {
    gate.resume();
    await Promise.allSettled([operation, refused]);
  }
});

it('does not cancel a new authority acquired while cancellation waits for its lock', async () => {
  const h = await setup();
  h.set(pending());
  let next: FrameleafCloudLink;
  h.mocks.database.withLock.mockImplementation((lock, action) => {
    if (lock === DatabaseLock.FrameleafLinkAuthority) next = h.replace('linked');
    return action() as never;
  });
  await h.sut.cancelLink();
  expect(h.current()).toEqual(next!);
});

it('keeps a concurrent administrator permission change when a poll completes', async () => {
  const h = await setup(),
    link = pending(),
    gate = h.gate();
  h.set(link);
  h.mocks.frameleafCloud.requestOAuth.mockImplementationOnce(async () => {
    gate.enter();
    await gate.wait;
    return { ok: false, error: 'authorization_pending' } as never;
  });
  const operation = h.poll(link);
  try {
    await gate.entered;
    await h.sut.updatePermissions(authStub.admin, { allowRemoteEnable: true });
    gate.resume();
    await operation;
    expect(h.current().permissions?.allowRemoteEnable).toBe(true);
  } finally {
    gate.resume();
    await Promise.allSettled([operation]);
  }
});

it.each(['continue', 'headless', 'setup'] as const)(
  'keeps a stale %s registration failure off replacement authority',
  async (flow) => {
    const h = await setup(),
      gate = h.gate();
    h.set({
      status: 'unlinked',
      cloudUrl: url,
      ...(flow === 'continue' && { heldLink: { linkToken: 'synthetic-link-token', accountRegion: 'eu' } }),
    });
    h.mocks.frameleafCloud.requestJson.mockImplementationOnce(async () => {
      gate.enter();
      await gate.wait;
      throw new Error('old registration failed');
    });
    const operation =
      flow === 'continue'
        ? h.sut.continueLink(authStub.admin)
        : flow === 'headless'
          ? h.sut.linkHeadless(url, 'fll_synthetic-token')
          : h.sut.claimNewServer({ linkToken: 'fll_synthetic-token' }, { ip: '192.168.1.5', via: null });
    const settled = operation.catch(() => {});
    try {
      await gate.entered;
      const next = h.replace('linked');
      gate.resume();
      await settled;
      expect(h.current()).toEqual(next);
    } finally {
      gate.resume();
      await Promise.allSettled([operation, settled]);
    }
  },
);

it('publishes an unchanged attempt with new timing and administrator permissions', async () => {
  const h = await setup(),
    link = pending(),
    gate = h.gate();
  h.set(link);
  h.mocks.frameleafCloud.requestOAuth.mockResolvedValue({ ok: true, data: { access_token: 'synthetic-link-token' } });
  h.mocks.frameleafCloud.requestJson.mockImplementationOnce(async () => {
    gate.enter();
    await gate.wait;
    return cloudContractFixture('instance/register-response.json');
  });
  const operation = h.poll(link);
  try {
    await gate.entered;
    h.set({
      ...link,
      pending: { ...link.pending!, nextPollAt: new Date(Date.now() + 5000).toISOString() },
      permissions: { ...link.permissions!, allowRemoteEnable: true },
    });
    gate.resume();
    await operation;
    expect(h.current()).toMatchObject({ status: 'linked', permissions: { allowRemoteEnable: true } });
  } finally {
    gate.resume();
    await Promise.allSettled([operation]);
  }
});

it('keeps a headless token reservation against delayed device authorization', async () => {
  const h = await setup(),
    gate = h.gate();
  h.set({ status: 'unlinked', cloudUrl: url });
  h.mocks.frameleafCloud.requestJson.mockImplementationOnce(async () => {
    gate.enter();
    await gate.wait;
    return {
      device_code: 'late-device',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://id.frameleaf.cloud/device',
      expires_in: 600,
      interval: 5,
    } as never;
  });
  const operation = h.sut.startLink(authStub.admin);
  const refused = expect(operation).rejects.toMatchObject({ status: 409 });
  try {
    await gate.entered;
    const reserved: FrameleafCloudLink = {
      status: 'unlinked',
      cloudUrl: url,
      usedLinkTokens: ['synthetic-token-hash'],
    };
    h.set(reserved);
    gate.resume();
    await refused;
    expect(h.current()).toEqual(reserved);
  } finally {
    gate.resume();
    await Promise.allSettled([operation, refused]);
  }
});

it('serializes page polls and rereads the next-poll boundary', async () => {
  const h = await setup(),
    gate = h.gate();
  h.set(pending());
  let tail = Promise.resolve();
  h.mocks.database.withLock.mockImplementation((lock, action) => {
    if (lock !== DatabaseLock.FrameleafHeartbeat) return action() as never;
    const next = tail.then(action);
    tail = next.then(() => {}).catch(() => {});
    return next as never;
  });
  h.mocks.frameleafCloud.requestOAuth.mockImplementationOnce(async () => {
    gate.enter();
    await gate.wait;
    return { ok: false, error: 'authorization_pending' } as never;
  });
  const first = h.sut.getLink();
  let second: ReturnType<typeof h.sut.getLink> | undefined;
  try {
    await gate.entered;
    second = h.sut.getLink();
    gate.resume();
    await Promise.all([first, second]);
    expect(h.mocks.frameleafCloud.requestOAuth).toHaveBeenCalledOnce();
    expect(Date.parse(h.current().pending!.nextPollAt)).toBeGreaterThan(Date.now());
  } finally {
    gate.resume();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});

it.each(['poll', 'continue', 'headless', 'setup'] as const)(
  'keeps a delayed %s region refusal off replacement authority',
  async (flow) => {
    const h = await setup(),
      gate = h.gate();
    const link: FrameleafCloudLink =
      flow === 'poll'
        ? pending()
        : {
            status: 'unlinked',
            cloudUrl: url,
            ...(flow === 'continue' && { heldLink: { linkToken: 'synthetic-link-token', accountRegion: 'eu' } }),
          };
    h.set(link);
    h.mocks.frameleafCloud.requestOAuth.mockResolvedValue({ ok: true, data: { access_token: 'synthetic-link-token' } });
    h.mocks.frameleafCloud.requestJson.mockImplementationOnce(async () => {
      gate.enter();
      await gate.wait;
      throw new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, 409, 'Different region', {
        code: 'region-mismatch',
        message: 'Different region',
        retryable: false,
        refusal: null,
        detail: null,
        data: { accountRegion: 'eu', requestedRegion: 'na' },
        requestId: null,
      });
    });
    const operation =
      flow === 'poll'
        ? h.poll(link)
        : flow === 'continue'
          ? h.sut.continueLink(authStub.admin)
          : flow === 'headless'
            ? h.sut.linkHeadless(url, 'fll_synthetic-token')
            : h.sut.claimNewServer({ linkToken: 'fll_synthetic-token' }, { ip: '192.168.1.5', via: null });
    const settled = operation.catch(() => {});
    try {
      await gate.entered;
      const next = h.replace('linked');
      gate.resume();
      await settled;
      expect(h.current()).toEqual(next);
    } finally {
      gate.resume();
      await Promise.allSettled([operation, settled]);
    }
  },
);

it('starts linking to the configured Cloud when metadata still belongs to another Cloud URL', async () => {
  const h = await setup();
  h.set({ status: 'linked', cloudUrl: 'https://api.other.test', instanceId: 'other-instance' });
  h.mocks.frameleafCloud.requestJson.mockResolvedValueOnce({
    device_code: 'new-device',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://id.frameleaf.cloud/device',
    expires_in: 600,
    interval: 5,
  } as never);
  await expect(h.sut.startLink(authStub.admin)).resolves.toBeDefined();
  expect(h.current()).toMatchObject({ status: 'pending', cloudUrl: url, pending: { deviceCode: 'new-device' } });
});
