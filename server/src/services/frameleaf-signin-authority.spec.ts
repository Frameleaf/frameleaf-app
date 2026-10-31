import { AsyncLocalStorage } from 'node:async_hooks';
import { FrameleafTokenExchangeErrorCode } from 'src/dtos/frameleaf-auth.dto.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { FrameleafAuthService } from 'src/services/frameleaf-auth.service.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { newTestService } from 'test/utils.js';

const details = { isSecure: true, clientIp: '127.0.0.1', deviceOS: '', deviceType: '', appVersion: null };
const config = { issuerUrl: 'https://id.cloud.test', clientId: 'instance', scope: 'openid email profile' };
const setup = (flow: 'callback' | 'exchange') => {
  const { sut, mocks } = newTestService(FrameleafAuthService);
  const user = UserFactory.create({ isAdmin: false });
  const now = Math.floor(Date.now() / 1000);
  const profile = {
    sub: 'subject',
    email: user.email,
    email_verified: true,
    frameleaf_role: 'user',
    frameleaf_access: 'viewer',
    iat: now,
    exp: now + 120,
    jti: 'jti',
    sid: 'sid',
  };
  let link: Record<string, unknown> = {
    status: 'linked',
    cloudUrl: 'https://cloud.test',
    instanceId: 'instance',
    accountId: 'owner',
    linkedAt: '2026-10-16T00:00:00Z',
    oidc: { issuer: config.issuerUrl, clientId: config.clientId, scope: config.scope },
  };
  mocks.config.getEnv.mockReturnValue({
    ...mocks.config.getEnv(),
    frameleafCloud: { ...mocks.config.getEnv().frameleafCloud, url: 'https://cloud.test' },
  });
  mocks.systemMetadata.get.mockImplementation((key) =>
    Promise.resolve((key === SystemMetadataKey.FrameleafCloudLink ? link : null) as never),
  );
  const internals = sut as unknown as { config: () => Promise<unknown>; exchange: () => Promise<unknown> };
  vi.spyOn(internals, 'config').mockResolvedValue(config);
  const exchange = vi
    .spyOn(internals, 'exchange')
    .mockResolvedValue({ profile, sid: profile.sid, idToken: 'synthetic-id-token' });
  mocks.oauth.verifyClientToken.mockResolvedValue(profile);
  mocks.frameleafAccount.redeemExchangeToken.mockResolvedValue('ok');
  mocks.frameleafAccount.isSignInRevoked.mockResolvedValue(false);
  mocks.frameleafAccount.getLinkBySub.mockResolvedValue({ userId: user.id, sub: profile.sub } as never);
  mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
  mocks.user.get.mockResolvedValue(user as never);
  mocks.frameleafAccount.touchLink.mockResolvedValue();
  mocks.frameleafAccount.tagSession.mockResolvedValue();
  mocks.session.create.mockResolvedValue({ id: 'session' } as never);
  mocks.crypto.randomBytesAsText.mockReturnValue('synthetic-token');
  mocks.session.delete.mockResolvedValue();
  mocks.frameleafAccount.deleteSessions.mockResolvedValue();
  const held = new AsyncLocalStorage<DatabaseLock[]>();
  mocks.database.withLock.mockImplementation(
    (lock, callback) => held.run([...(held.getStore() ?? []), lock], callback) as never,
  );
  const submit = () =>
    flow === 'callback'
      ? sut.callback(
          { url: 'https://photos.test/auth/login?code=synthetic', state: 'state', codeVerifier: 'verifier' },
          {},
          details,
        )
      : sut.exchangeToken({ token: 'synthetic' }, details);
  const delayVerification = () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    if (flow === 'callback')
      exchange.mockImplementationOnce(async () => {
        expect(held.getStore() ?? []).not.toContain(DatabaseLock.FrameleafLinkAuthority);
        entered.resolve();
        await resume.promise;
        return { profile, sid: profile.sid, idToken: 'synthetic-id-token' };
      });
    else
      mocks.oauth.verifyClientToken.mockImplementationOnce(async () => {
        expect(held.getStore() ?? []).not.toContain(DatabaseLock.FrameleafLinkAuthority);
        entered.resolve();
        await resume.promise;
        return profile;
      });
    return { entered: entered.promise, resume: resume.resolve };
  };
  return {
    sut,
    mocks,
    user,
    profile,
    held,
    submit,
    delayVerification,
    replace: (patch: Record<string, unknown>) => {
      link = { ...link, ...patch };
    },
  };
};

describe.each(['callback', 'exchange'] as const)('%s authority admission', (flow) => {
  it.each(['unlinked', 'revoked', 'generation', 'owner', 'instance', 'issuer', 'client', 'scope'] as const)(
    'refuses an authority changed during verification: %s',
    async (change) => {
      const h = setup(flow);
      const gate = h.delayVerification();
      const operation = h.submit();
      const refused = expect(operation).rejects.toMatchObject({ status: flow === 'callback' ? 401 : 403 });
      await gate.entered;
      try {
        const patch =
          change === 'unlinked' || change === 'revoked'
            ? { status: change }
            : change === 'generation'
              ? { linkedAt: '2026-10-16T00:01:00Z' }
              : change === 'owner'
                ? { accountId: 'replacement' }
                : change === 'instance'
                  ? { instanceId: 'replacement' }
                  : {
                      oidc: {
                        issuer: change === 'issuer' ? 'https://id.replacement.test' : config.issuerUrl,
                        clientId: change === 'client' ? 'replacement' : config.clientId,
                        scope: change === 'scope' ? 'openid' : config.scope,
                      },
                    };
        h.replace(patch);
        gate.resume();
        await refused;
        expect(h.mocks.session.create).not.toHaveBeenCalled();
        expect(h.mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
        expect(h.mocks.frameleafAccount.touchLink).not.toHaveBeenCalled();
        expect(h.mocks.user.update).not.toHaveBeenCalled();
      } finally {
        gate.resume();
        await Promise.allSettled([operation, refused]);
      }
    },
  );

  it.each(['existing', 'first-admin'] as const)(
    'takes the server claim fence before Cloud authority for %s sign-in',
    async (mode) => {
      const h = setup(flow);
      if (mode === 'first-admin') {
        h.profile.frameleaf_role = 'admin';
        h.replace({ accountId: h.profile.sub });
        h.mocks.user.getAdmin.mockResolvedValue(undefined);
        h.mocks.frameleafAccount.getLinkBySub.mockResolvedValue(undefined);
        h.mocks.user.getByEmail.mockResolvedValue(undefined);
        h.mocks.clusterGroup.create.mockResolvedValue({ id: 'group' } as never);
        h.mocks.user.create.mockResolvedValue({ ...h.user, isAdmin: true } as never);
      }
      h.mocks.database.withLock.mockImplementation((lock, callback) => {
        const held = h.held.getStore() ?? [];
        expect(held).not.toContain(lock);
        if (lock === DatabaseLock.FrameleafLinkAuthority) expect(held).toContain(DatabaseLock.FrameleafServerClaim);
        return h.held.run([...held, lock], callback) as never;
      });
      await expect(h.submit()).resolves.toMatchObject({ userId: h.user.id });
      expect(h.mocks.session.create).toHaveBeenCalledOnce();
      if (mode === 'first-admin') expect(h.mocks.user.create).toHaveBeenCalledOnce();
    },
  );

  it('rereads authority after waiting for the Cloud link lock', async () => {
    const h = setup(flow);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    h.mocks.database.withLock.mockImplementation(async (lock, callback) => {
      if (lock === DatabaseLock.FrameleafServerClaim) return callback();
      expect(lock).toBe(DatabaseLock.FrameleafLinkAuthority);
      entered.resolve();
      await resume.promise;
      return callback();
    });
    const operation = h.submit();
    const refused = expect(operation).rejects.toMatchObject({ status: flow === 'callback' ? 401 : 403 });
    try {
      await entered.promise;
      h.replace({ linkedAt: 'replacement-generation' });
      resume.resolve();
      await refused;
      expect(h.mocks.frameleafAccount.redeemExchangeToken).not.toHaveBeenCalled();
      expect(h.mocks.frameleafAccount.touchLink).not.toHaveBeenCalled();
      expect(h.mocks.session.create).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await Promise.allSettled([operation, refused]);
    }
  });

  it.each(['tagging', 'revocation-read'] as const)('removes an unpublished session after %s fails', async (phase) => {
    const h = setup(flow);
    if (phase === 'tagging') h.mocks.frameleafAccount.tagSession.mockRejectedValue(new Error('tagging unavailable'));
    else
      h.mocks.frameleafAccount.tagSession.mockImplementation(() => {
        h.mocks.frameleafAccount.isSignInRevoked.mockRejectedValue(new Error('revocation-read unavailable'));
        return Promise.resolve();
      });
    await expect(h.submit()).rejects.toThrow(`${phase} unavailable`);
    expect(h.mocks.session.delete).toHaveBeenCalledExactlyOnceWith('session');
    expect(h.mocks.frameleafAccount.deleteSessions).toHaveBeenCalledExactlyOnceWith(['session']);
  });

  it.each(['legacy', 'contact'] as const)(
    'accepts unchanged %s authority and fences account/session writes',
    async (mode) => {
      const h = setup(flow);
      if (mode === 'legacy') h.replace({ linkedAt: undefined });
      h.mocks.frameleafAccount.touchLink.mockImplementation(() => {
        expect(h.held.getStore()).toContain(DatabaseLock.FrameleafLinkAuthority);
        return Promise.resolve();
      });
      h.mocks.session.create.mockImplementation(() => {
        expect(h.held.getStore()).toContain(DatabaseLock.FrameleafLinkAuthority);
        return Promise.resolve({ id: 'session' } as never);
      });
      const gate = h.delayVerification();
      const operation = h.submit();
      await gate.entered;
      try {
        h.replace({ lastContactAt: '2026-10-16T00:02:00Z', accountLabel: 'New display name' });
        gate.resume();
        await expect(operation).resolves.toMatchObject({ userId: h.user.id });
      } finally {
        gate.resume();
        await Promise.allSettled([operation]);
      }
    },
  );
});

it.each(['before', 'during', 'read-failure'] as const)(
  'browser sign-in refuses logout %s session tagging',
  async (phase) => {
    const h = setup('callback');
    if (phase === 'before') h.mocks.frameleafAccount.isSignInRevoked.mockResolvedValue(true);
    else
      h.mocks.frameleafAccount.tagSession.mockImplementation(() => {
        if (phase === 'during') h.mocks.frameleafAccount.isSignInRevoked.mockResolvedValue(true);
        else h.mocks.frameleafAccount.isSignInRevoked.mockRejectedValue(new Error('proof unavailable'));
        return Promise.resolve();
      });
    await expect(h.submit()).rejects.toThrow(phase === 'read-failure' ? 'proof unavailable' : 'not available');
    if (phase === 'before') expect(h.mocks.session.create).not.toHaveBeenCalled();
    else expect(h.mocks.session.delete).toHaveBeenCalledWith('session');
  },
);

it.each(['lock-wait', 'tagging'] as const)('exchange refuses expiry during %s', async (phase) => {
  const h = setup('exchange');
  const clock = vi.spyOn(Date, 'now');
  if (phase === 'lock-wait')
    h.mocks.database.withLock.mockImplementation((_lock, callback) => {
      clock.mockReturnValue((h.profile.exp + 6) * 1000);
      return callback() as never;
    });
  else
    h.mocks.frameleafAccount.tagSession.mockImplementation(() => {
      clock.mockReturnValue((h.profile.exp + 6) * 1000);
      return Promise.resolve();
    });
  try {
    await expect(h.submit()).rejects.toMatchObject({
      status: 401,
      response: { code: FrameleafTokenExchangeErrorCode.Expired },
    });
    if (phase === 'lock-wait') expect(h.mocks.session.create).not.toHaveBeenCalled();
    else expect(h.mocks.session.delete).toHaveBeenCalledExactlyOnceWith('session');
  } finally {
    clock.mockRestore();
  }
});
