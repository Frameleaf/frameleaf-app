import { MailSignInUnavailableReason, MlAdmissionRefusal } from 'src/enum.js';
import {
  BROKER_SCOPES,
  BrokerAccessToken,
  LINK_FIRST,
  ProviderSignInBroker,
} from 'src/import-connectors/broker-sign-in.js';
import {
  RemoteSourceAuthError,
  RemoteSourceError,
  registerRemoteSource,
  unregisterRemoteSource,
} from 'src/import-connectors/remote-source.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { pkceChallenge } from 'src/utils/frameleaf-mail.js';
import { openImportConnection, readImportCredentials, sealImportCredentials } from 'src/utils/import-connector.js';
import { MailSignInUnavailableError, mailBrokerTarget } from 'src/utils/mail-connection.js';

vi.mock('src/utils/mail-connection.js', async (original) => ({
  ...(await original<typeof import('src/utils/mail-connection.js')>()),
  mailBrokerTarget: vi.fn(),
}));

const target = { api: 'https://api.cloud.test', token: { token: 'instance' } };
const signInId = '0195e2a0-0000-7000-8000-0000000000f1';
const userId = '0195e2a0-0000-7000-8000-0000000000a1';
const cloudError = (status: number, code: string, detail?: string) =>
  new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, status, 'refused', { code, detail } as never);

const setup = () => {
  const requestJson = vi.fn();
  const crypto = { serverKeyedHash: vi.fn().mockResolvedValue('server-key') };
  const config = { getEnv: () => ({ frameleafCloud: { identityDir: '/identity' } }) };
  const broker = new ProviderSignInBroker({
    frameleafCloudRepository: { requestJson },
    cryptoRepository: crypto,
    configRepository: config,
  } as never);
  return { broker, requestJson, crypto, config };
};

const started = async (context: ReturnType<typeof setup>) => {
  context.requestJson.mockResolvedValueOnce({
    signInId,
    authorizationUrl: 'https://www.dropbox.com/oauth2/authorize?x=1',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const answer = await context.broker.start('dropbox', { userId });
  const request = context.requestJson.mock.calls[0][1];
  return { answer, state: request.body.state as string, request };
};

describe('ProviderSignInBroker', () => {
  beforeEach(() => {
    vi.mocked(mailBrokerTarget).mockResolvedValue(target as never);
  });

  it('starts with the exact scopes and a challenge, and hands out no verifier', async () => {
    const context = setup();
    const { answer, request } = await started(context);
    expect(request.url).toBe('https://api.cloud.test/v1/instance/provider-sign-in/sign-ins');
    expect(request.body.scopes).toEqual([...BROKER_SCOPES.dropbox]);
    expect(request.body.codeChallenge).toMatch(/^[\w-]{43}$/);
    expect(request.body).not.toHaveProperty('codeVerifier');
    expect(answer.signInToken).not.toContain(request.body.state);
  });

  it('tells an unlinked server to link first', async () => {
    vi.mocked(mailBrokerTarget).mockRejectedValue(
      new MailSignInUnavailableError(MailSignInUnavailableReason.NotLinked, 'mail words'),
    );
    const { broker } = setup();
    await expect(broker.start('dropbox', { userId })).rejects.toThrow(LINK_FIRST);
    await expect(broker.availability('dropbox')).resolves.toEqual({ available: false, reason: 'not-linked' });
  });

  it('exchanges the code with the verifier behind the challenge', async () => {
    const context = setup();
    const { answer, state, request } = await started(context);
    context.requestJson
      .mockResolvedValueOnce({ status: 'ready', state, code: 'one-time' })
      .mockResolvedValueOnce({ accessToken: 'a', expiresInSec: 14_400, refreshToken: 'r' });
    const result = await context.broker.finish('dropbox', userId, answer.signInToken);
    expect(result).toMatchObject({ state: 'ready', connectionId: null, tokens: { refreshToken: 'r' } });
    const exchange = context.requestJson.mock.calls[2][1].body;
    expect(exchange).toMatchObject({ grant: 'authorization_code', service: 'dropbox', code: 'one-time' });
    expect(pkceChallenge(exchange.codeVerifier)).toBe(request.body.codeChallenge);
  });

  it('never sends the verifier for an answer with the wrong state', async () => {
    const context = setup();
    const { answer } = await started(context);
    context.requestJson.mockResolvedValueOnce({ status: 'ready', state: 'someone-elses', code: 'c' });
    await expect(context.broker.finish('dropbox', userId, answer.signInToken)).rejects.toThrow('did not match');
    expect(context.requestJson).toHaveBeenCalledTimes(2);
  });

  it('opens a sign-in only for the account that started it', async () => {
    const context = setup();
    const { answer } = await started(context);
    await expect(
      context.broker.finish('dropbox', '0195e2a0-0000-7000-8000-0000000000a2', answer.signInToken),
    ).rejects.toThrow('not started here');
    await expect(context.broker.finish('google-drive', userId, answer.signInToken)).rejects.toThrow('not started here');
  });

  it('reports pending, denied and expired', async () => {
    const context = setup();
    const { answer, state } = await started(context);
    context.requestJson.mockResolvedValueOnce({ status: 'pending' });
    await expect(context.broker.finish('dropbox', userId, answer.signInToken)).resolves.toEqual({ state: 'pending' });
    context.requestJson.mockResolvedValueOnce({ status: 'denied', state });
    await expect(context.broker.finish('dropbox', userId, answer.signInToken)).resolves.toEqual({ state: 'denied' });
    context.requestJson.mockRejectedValueOnce(cloudError(404, 'provider-sign-in-not-found'));
    await expect(context.broker.finish('dropbox', userId, answer.signInToken)).resolves.toEqual({ state: 'expired' });
  });

  it('turns a dead refresh token into a new sign-in, and a cloud failure into a retry', async () => {
    const { broker, requestJson } = setup();
    requestJson.mockRejectedValueOnce(cloudError(400, 'provider-grant-invalid'));
    await expect(broker.refresh('dropbox', 'r')).rejects.toBeInstanceOf(RemoteSourceAuthError);
    requestJson.mockRejectedValueOnce(cloudError(502, 'provider-unavailable'));
    const failure = await broker.refresh('dropbox', 'r').catch((error) => error);
    expect(failure).toBeInstanceOf(RemoteSourceError);
    expect(failure).not.toBeInstanceOf(RemoteSourceAuthError);
  });
});

describe('BrokerAccessToken', () => {
  const session = (credentials: Record<string, unknown>) => {
    const saved: Array<Record<string, unknown>> = [];
    return {
      saved,
      renewCredentials: vi.fn(async (renew: (current: Record<string, unknown>) => Promise<any>) => {
        const next = await renew(credentials);
        if (next) {
          saved.push(next);
        }
      }),
    };
  };
  const brokerOf = (answer: Record<string, unknown>) => ({
    target: vi.fn().mockResolvedValue(target),
    refresh: vi.fn().mockResolvedValue({ accessToken: 'a1', expiresInSec: 3600, ...answer }),
  });

  it('keeps a token until its last minute and renews concurrent callers once', async () => {
    let clock = 0;
    const broker = brokerOf({});
    const hook = session({ refreshToken: 'r' });
    const tokens = new BrokerAccessToken(broker as never, 'dropbox', hook, () => clock);
    await expect(Promise.all([tokens.get(), tokens.get()])).resolves.toEqual(['a1', 'a1']);
    expect(broker.refresh).toHaveBeenCalledTimes(1);
    clock = 3_530_000;
    await tokens.get();
    expect(broker.refresh).toHaveBeenCalledTimes(1);
    clock = 3_550_000;
    await tokens.get();
    expect(broker.refresh).toHaveBeenCalledTimes(2);
  });

  it('saves a rotated refresh token and leaves an unchanged one alone', async () => {
    const rotated = session({ refreshToken: 'r', accountId: 'dbid:1' });
    await new BrokerAccessToken(brokerOf({ refreshToken: 'r2' }) as never, 'dropbox', rotated).get();
    expect(rotated.saved).toEqual([{ refreshToken: 'r2', accountId: 'dbid:1' }]);

    const same = session({ refreshToken: 'r' });
    await new BrokerAccessToken(brokerOf({ refreshToken: 'r' }) as never, 'dropbox', same).get();
    expect(same.saved).toEqual([]);
  });
});

describe('the renewed-credentials hook', () => {
  it('stores what a provider renews sealed, and refreshes from the latest value', async () => {
    const deps = {
      crypto: { serverKeyedHash: vi.fn().mockResolvedValue('server-key') },
      config: { getEnv: () => ({ frameleafCloud: { identityDir: '/identity' } }) },
    };
    const id = '0195e2a0-0000-7000-8000-0000000000c9';
    let stored = await sealImportCredentials(deps as never, id, { refreshToken: 'first' });
    const repository = {
      withSealedCredentials: vi.fn(async (_id: string, change: (sealed: Buffer) => Promise<Buffer | null>) => {
        stored = (await change(stored)) ?? stored;
        return true;
      }),
    };
    let session: any;
    registerRemoteSource({
      provider: 'hook-test',
      credentials: (input) => input,
      open: (_credentials, opened) => {
        session = opened;
        return {} as never;
      },
    });
    try {
      await openImportConnection({ ...deps, repository } as never, {
        id,
        provider: 'hook-test',
        sealedCredentials: stored,
      });
      await session.renewCredentials((current: Record<string, unknown>) =>
        Promise.resolve({ ...current, refreshToken: 'second' }),
      );
      expect(stored.toString('latin1')).not.toContain('second');
      await expect(readImportCredentials(deps as never, { id, sealedCredentials: stored })).resolves.toEqual({
        refreshToken: 'second',
      });
    } finally {
      unregisterRemoteSource('hook-test');
    }
  });
});
