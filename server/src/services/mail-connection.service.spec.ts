import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrameleafMailConnection } from 'src/types.js';
import { defaults } from 'src/dtos/config.dto.js';
import {
  MailConnectionStatus,
  MailSignInProvider,
  MailSignInState,
  MailSignInUnavailableReason,
  MailTransportType,
  SystemMetadataKey,
} from 'src/enum.js';
import { MailApiError } from 'src/repositories/email.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MailConnectionService } from 'src/services/mail-connection.service.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { mailSealKey, openMailSecret, sealMailSecret } from 'src/utils/frameleaf-mail.js';
import {
  MailAccountNotConnectedError,
  type MailConnectionDeps,
  MailNeedsSignInError,
  forgetMailAccessTokens,
  mailAccessToken,
  sendConnectedEmail,
} from 'src/utils/mail-connection.js';
import { type FakeCloud, type FakeCloudAnswer, startFakeCloud, tokenAnswer } from 'test/fake-frameleaf-cloud.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { type ServiceMocks, expectLocalisedSystemNotices, newTestService } from 'test/utils.js';

const SIGN_IN_ID = '0b6f4c6e-3d0b-4f0e-9d0b-0a1b2c3d4e5f';
const REFRESH = 'refresh-token-FIXTURE-ONLY';
const ACCESS = 'access-token-FIXTURE-ONLY';

const envelope = (status: number, code: string, headers?: Record<string, string>): FakeCloudAnswer => ({
  status,
  headers,
  body: { code, message: code, retryable: status >= 500, requestId: 'req_fixture' },
});

/**
 * FL-379 against a fake Frameleaf Cloud over real HTTP: the real cloud client signs every call with a
 * real instance key (DPoP), and the fake answers the broker contract of FC-160. Google and Microsoft
 * themselves are never contacted: the email repository is a mock.
 */
describe(MailConnectionService.name, () => {
  let sut: MailConnectionService;
  let mocks: ServiceMocks;
  let cloud: FakeCloud;
  let dir: string;
  let metadata: Map<string, unknown>;
  let key: Buffer;
  let useTransport: ReturnType<typeof vi.spyOn>;

  const link = () =>
    metadata.set(SystemMetadataKey.FrameleafCloudLink, {
      status: 'linked',
      instanceId: 'instance-1',
      cloudUrl: cloud.url,
    });
  const connection = () => metadata.get(SystemMetadataKey.FrameleafMailConnection) as FrameleafMailConnection;
  const pending = () => metadata.get(SystemMetadataKey.FrameleafMailSignIn) as { sealed: string } | undefined;
  const calls = (path: string) => cloud.requests.filter((request) => request.path === `/api/v1/instance/mail/${path}`);
  const connect = (overrides: Partial<FrameleafMailConnection> = {}) => {
    const stored: FrameleafMailConnection = {
      id: 'connection-1',
      provider: MailSignInProvider.Gmail,
      email: 'rivera@example.com',
      status: MailConnectionStatus.Connected,
      sealedRefreshToken: sealMailSecret(key, overrides.id ?? 'connection-1', REFRESH),
      connectedAt: '2026-10-11T10:00:00.000Z',
      ...overrides,
    };
    metadata.set(SystemMetadataKey.FrameleafMailConnection, stored);
    return stored;
  };
  /** Starts a sign-in and returns what the cloud was sent. */
  const start = async (provider = MailSignInProvider.Gmail) => {
    cloud.on('POST /api/v1/instance/mail/sign-ins', () => ({
      status: 201,
      body: {
        signInId: SIGN_IN_ID,
        authorizationUrl: 'https://accounts.example.com/authorize?state=cloud-own-state',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    }));
    const answer = await sut.start(authStub.admin, { provider });
    return { answer, sent: calls('sign-ins')[0].json() as { service: string; state: string; codeChallenge: string } };
  };
  const mailDeps = (): MailConnectionDeps => (sut as unknown as { mailDeps: MailConnectionDeps }).mailDeps;

  beforeEach(async () => {
    forgetMailAccessTokens();
    dir = await mkdtemp(join(tmpdir(), 'frameleaf-mail-'));
    cloud = await startFakeCloud();
    cloud.on('POST /id/token', (request) => tokenAnswer(request, 'api-token'));
    metadata = new Map();
    ({ sut, mocks } = newTestService(MailConnectionService, {
      frameleafCloud: new FrameleafCloudRepository(LoggingRepository.create()),
      instanceIdentity: new InstanceIdentityRepository(),
    }));
    const env = mockEnvData({});
    mocks.config.getEnv.mockReturnValue({
      ...env,
      frameleafCloud: { ...env.frameleafCloud, url: cloud.url, identityDir: dir },
    });
    mocks.systemMetadata.get.mockImplementation((name) => Promise.resolve((metadata.get(name) ?? null) as never));
    mocks.systemMetadata.set.mockImplementation((name, value) => Promise.resolve(void metadata.set(name, value)));
    mocks.systemMetadata.delete.mockImplementation((name) => Promise.resolve(void metadata.delete(name)));
    key = mailSealKey(await mocks.crypto.serverKeyedHash(dir, 'mail-connection-seal', 'v1'));
    useTransport = vi.spyOn(sut, 'updateConfigExclusively').mockImplementation((change) => {
      const newConfig = structuredClone(defaults);
      change(newConfig);
      return Promise.resolve({ oldConfig: defaults, newConfig });
    });
    link();
  });

  afterEach(async () => {
    await cloud.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe('getState', () => {
    it('says why sign-in is not offered on a server without Frameleaf Cloud, and contacts nothing', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({}));
      await expect(sut.getState()).resolves.toEqual({
        available: false,
        unavailableReason: MailSignInUnavailableReason.NotConfigured,
        providers: [],
        connection: null,
        signIn: MailSignInState.None,
      });
      expect(cloud.requests).toHaveLength(0);
    });

    it('says a server that is not linked needs linking, and contacts nothing', async () => {
      metadata.delete(SystemMetadataKey.FrameleafCloudLink);
      await expect(sut.getState()).resolves.toMatchObject({
        available: false,
        unavailableReason: MailSignInUnavailableReason.NotLinked,
      });
      expect(cloud.requests).toHaveLength(0);
    });

    it('offers only the providers Frameleaf Cloud has configured', async () => {
      cloud.on('GET /api/v1/instance/mail/services', () => ({
        status: 200,
        body: {
          services: [
            { service: 'google', available: true },
            { service: 'microsoft', available: false },
          ],
        },
      }));
      await expect(sut.getState()).resolves.toMatchObject({ available: true, providers: [MailSignInProvider.Gmail] });
      expect(calls('services')[0].dpop).not.toBeNull();
    });

    it('returns the connected address and never the token', async () => {
      cloud.on('GET /api/v1/instance/mail/services', () => envelope(502, 'bad-gateway'));
      connect({ status: MailConnectionStatus.NeedsSignIn, needsSignInSince: '2026-10-11T11:00:00.000Z' });
      const state = await sut.getState();
      expect(state).toMatchObject({
        available: false,
        unavailableReason: MailSignInUnavailableReason.CloudUnreachable,
        connection: {
          provider: MailSignInProvider.Gmail,
          email: 'rivera@example.com',
          status: MailConnectionStatus.NeedsSignIn,
          needsSignInSince: '2026-10-11T11:00:00.000Z',
        },
      });
      expect(JSON.stringify(state)).not.toContain('sealedRefreshToken');
      expect(JSON.stringify(state)).not.toContain(connection().sealedRefreshToken);
    });
  });

  describe('start', () => {
    it('sends the cloud a state and an S256 challenge, and keeps the state and verifier sealed here', async () => {
      const { answer, sent } = await start();

      expect(answer.authorizationUrl).toBe('https://accounts.example.com/authorize?state=cloud-own-state');
      expect(sent.service).toBe('google');
      expect(sent.state).toMatch(/^[\w-]{43}$/);
      expect(sent.codeChallenge).toMatch(/^[\w-]{43}$/);
      expect(Object.keys(sent).sort()).toEqual(['codeChallenge', 'service', 'state']);

      const stored = JSON.stringify(pending());
      expect(stored).not.toContain(sent.state);
      const secret = openMailSecret<{ state: string; verifier: string }>(key, SIGN_IN_ID, pending()!.sealed)!;
      expect(secret.state).toBe(sent.state);
      expect(createHash('sha256').update(secret.verifier).digest('base64url')).toBe(sent.codeChallenge);
      expect(stored).not.toContain(secret.verifier);
    });

    it('refuses on a server that is not linked', async () => {
      metadata.delete(SystemMetadataKey.FrameleafCloudLink);
      await expect(sut.start(authStub.admin, { provider: MailSignInProvider.Gmail })).rejects.toThrow(
        'needs this server to be linked to a Frameleaf account',
      );
      expect(cloud.requests).toHaveLength(0);
    });

    it('says so when the cloud has not configured the provider', async () => {
      cloud.on('POST /api/v1/instance/mail/sign-ins', () =>
        envelope(503, 'mail-sign-in-unavailable', { 'Retry-After': '3600' }),
      );
      await expect(sut.start(authStub.admin, { provider: MailSignInProvider.Microsoft })).rejects.toThrow(
        'does not offer signing in with Microsoft yet',
      );
      expect(pending()).toBeUndefined();
    });
  });

  describe('complete', () => {
    const claim = (body: unknown) =>
      cloud.on(`POST /api/v1/instance/mail/sign-ins/${SIGN_IN_ID}/claim`, () => ({ status: 200, body }));
    const token = (body: unknown) => cloud.on('POST /api/v1/instance/mail/token', () => ({ status: 200, body }));

    it('answers none when no sign-in was started', async () => {
      await expect(sut.complete(authStub.admin)).resolves.toEqual({ state: MailSignInState.None, connection: null });
      expect(cloud.requests).toHaveLength(0);
    });

    it('keeps waiting while the administrator is still at the provider', async () => {
      await start();
      claim({ status: 'pending' });
      await expect(sut.complete(authStub.admin)).resolves.toEqual({
        state: MailSignInState.Pending,
        connection: null,
      });
      expect(pending()).toBeDefined();
      expect(calls('token')).toHaveLength(0);
    });

    it('exchanges the code with its verifier, seals the refresh token and switches email to Gmail', async () => {
      const { sent } = await start();
      claim({ status: 'ready', state: sent.state, code: 'one-time-code' });
      token({ accessToken: ACCESS, expiresInSec: 3600, refreshToken: REFRESH, email: 'rivera@example.com' });

      const answer = await sut.complete(authStub.admin);

      expect(answer).toEqual({
        state: MailSignInState.Connected,
        connection: {
          provider: MailSignInProvider.Gmail,
          email: 'rivera@example.com',
          status: MailConnectionStatus.Connected,
          connectedAt: expect.any(String),
        },
      });
      const exchange = calls('token')[0].json();
      expect(exchange).toMatchObject({ grant: 'authorization_code', service: 'google', code: 'one-time-code' });
      expect(createHash('sha256').update(exchange.codeVerifier).digest('base64url')).toBe(sent.codeChallenge);

      // the refresh token is stored sealed, and no answer or stored record carries it in the clear
      expect(JSON.stringify(metadata.values().toArray())).not.toContain(REFRESH);
      expect(JSON.stringify(answer)).not.toContain(REFRESH);
      expect(openMailSecret(key, connection().id, connection().sealedRefreshToken)).toBe(REFRESH);
      expect(pending()).toBeUndefined();

      const changed = structuredClone(defaults);
      (useTransport.mock.calls[0][0] as (config: typeof defaults) => void)(changed);
      expect(changed.notifications.smtp).toMatchObject({ enabled: true, transport: { type: MailTransportType.Gmail } });
      expect(mocks.event.emit).toHaveBeenCalledWith('ConfigUpdate', expect.anything());

      // the access token from the sign-in is used for the first send: no renewal
      await expect(mailAccessToken(mailDeps(), MailSignInProvider.Gmail)).resolves.toBe(ACCESS);
      expect(calls('token')).toHaveLength(1);
    });

    it('reads the address of a Microsoft account from Microsoft, which sends none with the tokens', async () => {
      const { sent } = await start(MailSignInProvider.Microsoft);
      expect(sent.service).toBe('microsoft');
      claim({ status: 'ready', state: sent.state, code: 'one-time-code' });
      token({ accessToken: ACCESS, expiresInSec: 3600, refreshToken: REFRESH });
      mocks.email.readMicrosoftAddress.mockResolvedValue('rivera@outlook.com');

      await expect(sut.complete(authStub.admin)).resolves.toMatchObject({
        state: MailSignInState.Connected,
        connection: { provider: MailSignInProvider.Microsoft, email: 'rivera@outlook.com' },
      });
      expect(mocks.email.readMicrosoftAddress).toHaveBeenCalledWith(ACCESS);
    });

    it('discards an answer with the wrong state and never sends the verifier', async () => {
      await start();
      claim({ status: 'ready', state: 'someone-elses-state-000000000000', code: 'one-time-code' });

      await expect(sut.complete(authStub.admin)).rejects.toThrow('did not match the one this server started');

      expect(calls('token')).toHaveLength(0);
      expect(pending()).toBeUndefined();
      expect(connection()).toBeUndefined();
      expect(useTransport).not.toHaveBeenCalled();
    });

    it('treats a sign-in the cloud does not know for this server as expired (wrong server, used, too late)', async () => {
      await start();
      cloud.on(`POST /api/v1/instance/mail/sign-ins/${SIGN_IN_ID}/claim`, () =>
        envelope(404, 'mail-sign-in-not-found'),
      );

      await expect(sut.complete(authStub.admin)).resolves.toEqual({
        state: MailSignInState.Expired,
        connection: null,
      });
      expect(calls('token')).toHaveLength(0);
      expect(pending()).toBeUndefined();
      expect(connection()).toBeUndefined();
    });

    it('reports a sign-in the administrator cancelled', async () => {
      const { sent } = await start();
      claim({ status: 'denied', state: sent.state });
      await expect(sut.complete(authStub.admin)).resolves.toEqual({ state: MailSignInState.Denied, connection: null });
      expect(pending()).toBeUndefined();
    });

    it('says so when the person signed in without allowing Frameleaf to send', async () => {
      const { sent } = await start();
      claim({ status: 'ready', state: sent.state, code: 'one-time-code' });
      cloud.on('POST /api/v1/instance/mail/token', () => ({
        status: 400,
        body: { code: 'mail-grant-invalid', message: 'x', retryable: false, detail: 'send-scope-missing' },
      }));
      await expect(sut.complete(authStub.admin)).rejects.toThrow('was not allowed to send email');
      expect(connection()).toBeUndefined();
      expect(pending()).toBeUndefined();
    });

    it('answers expired when the provider refuses the code', async () => {
      const { sent } = await start();
      claim({ status: 'ready', state: sent.state, code: 'one-time-code' });
      cloud.on('POST /api/v1/instance/mail/token', () => envelope(400, 'mail-grant-invalid'));
      await expect(sut.complete(authStub.admin)).resolves.toEqual({ state: MailSignInState.Expired, connection: null });
      expect(connection()).toBeUndefined();
    });

    it('forgets a sign-in that ran out of time without asking the cloud', async () => {
      await start();
      metadata.set(SystemMetadataKey.FrameleafMailSignIn, {
        ...(pending() as object),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      await expect(sut.complete(authStub.admin)).resolves.toEqual({ state: MailSignInState.None, connection: null });
      expect(calls(`sign-ins/${SIGN_IN_ID}/claim`)).toHaveLength(0);
      expect(pending()).toBeUndefined();
    });

    it('revokes the account a new sign-in replaces', async () => {
      connect({ id: 'old-connection', sealedRefreshToken: sealMailSecret(key, 'old-connection', 'old-refresh') });
      cloud.on('POST /api/v1/instance/mail/revoke', () => ({ status: 200, body: { status: 'revoked' } }));
      const { sent } = await start();
      claim({ status: 'ready', state: sent.state, code: 'one-time-code' });
      token({ accessToken: ACCESS, expiresInSec: 3600, refreshToken: REFRESH, email: 'new@example.com' });

      await sut.complete(authStub.admin);

      expect(calls('revoke')[0].json()).toEqual({ service: 'google', refreshToken: 'old-refresh' });
      expect(connection().email).toBe('new@example.com');
    });
  });

  describe('disconnect', () => {
    it('revokes at the provider, deletes the token and switches email off', async () => {
      connect();
      cloud.on('POST /api/v1/instance/mail/revoke', () => ({ status: 200, body: { status: 'revoked' } }));

      await expect(sut.disconnect(authStub.admin)).resolves.toEqual({
        provider: MailSignInProvider.Gmail,
        revoked: true,
      });

      expect(calls('revoke')[0].json()).toEqual({ service: 'google', refreshToken: REFRESH });
      expect(connection()).toBeUndefined();
      const changed = structuredClone(defaults);
      changed.notifications.smtp.enabled = true;
      changed.notifications.smtp.transport.type = MailTransportType.Gmail;
      (useTransport.mock.calls[0][0] as (config: typeof defaults) => void)(changed);
      expect(changed.notifications.smtp).toMatchObject({ enabled: false, transport: { type: MailTransportType.Smtp } });
    });

    it('says when the provider offers no revocation (Microsoft), and still forgets the token', async () => {
      connect({ provider: MailSignInProvider.Microsoft });
      cloud.on('POST /api/v1/instance/mail/revoke', () => ({ status: 200, body: { status: 'not-supported' } }));
      await expect(sut.disconnect(authStub.admin)).resolves.toEqual({
        provider: MailSignInProvider.Microsoft,
        revoked: false,
      });
      expect(connection()).toBeUndefined();
    });

    it('still disconnects when the cloud cannot be reached', async () => {
      connect();
      cloud.on('POST /api/v1/instance/mail/revoke', () => envelope(502, 'mail-provider-unavailable'));
      await expect(sut.disconnect(authStub.admin)).resolves.toMatchObject({ revoked: false });
      expect(connection()).toBeUndefined();
    });

    it('leaves the settings of a server managed by a configuration file alone', async () => {
      const env = mockEnvData({ configFile: '/config/frameleaf.json' });
      mocks.config.getEnv.mockReturnValue({
        ...env,
        frameleafCloud: { ...env.frameleafCloud, url: cloud.url, identityDir: dir },
      });
      connect();
      cloud.on('POST /api/v1/instance/mail/revoke', () => ({ status: 200, body: { status: 'revoked' } }));
      await sut.disconnect(authStub.admin);
      expect(useTransport).not.toHaveBeenCalled();
    });

    it('keeps a replacement account when the original disconnect waits for provider revocation', async () => {
      connect();
      const revoking = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      cloud.on('POST /api/v1/instance/mail/revoke', async () => {
        revoking.resolve();
        await released.promise;
        return { status: 200, body: { status: 'revoked' } };
      });
      const disconnect = sut.disconnect(authStub.admin);
      const refusal = expect(disconnect).rejects.toThrow('The connected mail account changed');
      try {
        await revoking.promise;
        connect({ id: 'replacement-connection', email: 'replacement@example.com' });
      } finally {
        released.resolve();
      }
      await refusal;
      expect(connection()).toMatchObject({ id: 'replacement-connection', email: 'replacement@example.com' });
      expect(useTransport).not.toHaveBeenCalled();
    });

    it('refuses when nothing is connected', async () => {
      await expect(sut.disconnect(authStub.admin)).rejects.toThrow('No mail account is connected');
    });
  });

  describe('access tokens', () => {
    const refreshed = (body: unknown) => cloud.on('POST /api/v1/instance/mail/token', () => ({ status: 200, body }));

    it('renews through the cloud with the opened refresh token, then uses the cached token', async () => {
      connect();
      refreshed({ accessToken: ACCESS, expiresInSec: 3600 });

      await expect(mailAccessToken(mailDeps(), MailSignInProvider.Gmail)).resolves.toBe(ACCESS);
      await expect(mailAccessToken(mailDeps(), MailSignInProvider.Gmail)).resolves.toBe(ACCESS);

      expect(calls('token')).toHaveLength(1);
      expect(calls('token')[0].json()).toEqual({ grant: 'refresh_token', service: 'google', refreshToken: REFRESH });
      expect(calls('token')[0].dpop).not.toBeNull();
    });

    it('renews again once the token is in its last minute', async () => {
      connect();
      refreshed({ accessToken: ACCESS, expiresInSec: 3600 });
      const now = Date.now();
      await mailAccessToken(mailDeps(), MailSignInProvider.Gmail, { now });
      await mailAccessToken(mailDeps(), MailSignInProvider.Gmail, { now: now + 3_590_000 });
      expect(calls('token')).toHaveLength(2);
    });

    it('stores a refresh token the provider rotated, sealed', async () => {
      connect({ provider: MailSignInProvider.Microsoft });
      refreshed({ accessToken: ACCESS, expiresInSec: 3600, refreshToken: 'rotated-refresh' });

      await mailAccessToken(mailDeps(), MailSignInProvider.Microsoft);

      expect(openMailSecret(key, 'connection-1', connection().sealedRefreshToken)).toBe('rotated-refresh');
      expect(JSON.stringify(connection())).not.toContain('rotated-refresh');
      expect(connection().status).toBe(MailConnectionStatus.Connected);
    });

    it('marks the account as needing sign-in and tells the administrators when the grant is dead', async () => {
      connect();
      cloud.on('POST /api/v1/instance/mail/token', () => envelope(400, 'mail-grant-invalid'));

      await expect(mailAccessToken(mailDeps(), MailSignInProvider.Gmail)).rejects.toBeInstanceOf(MailNeedsSignInError);

      expect(connection()).toMatchObject({
        status: MailConnectionStatus.NeedsSignIn,
        needsSignInSince: expect.any(String),
        email: 'rivera@example.com',
      });
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({
          title: 'Email stopped: sign in to Gmail again',
          dedupeKey: 'frameleaf-mail:needs-sign-in',
          systemTemplate: { version: 1, key: 'mail-needs-sign-in', args: { provider: 'Gmail' } },
        }),
      );
      expectLocalisedSystemNotices(mocks.event.emit);
      // nothing more is asked of the cloud until an administrator signs in again
      await expect(mailAccessToken(mailDeps(), MailSignInProvider.Gmail)).rejects.toBeInstanceOf(MailNeedsSignInError);
      expect(calls('token')).toHaveLength(1);
    });

    it('keeps the connection when the provider is only unreachable', async () => {
      connect();
      cloud.on('POST /api/v1/instance/mail/token', () => envelope(502, 'mail-provider-unavailable'));
      await expect(mailAccessToken(mailDeps(), MailSignInProvider.Gmail)).rejects.toBeInstanceOf(FrameleafCloudError);
      expect(connection().status).toBe(MailConnectionStatus.Connected);
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AdminNotify', expect.anything());
    });

    it('needs a new sign-in when the stored token was sealed by another server', async () => {
      connect({ sealedRefreshToken: sealMailSecret(mailSealKey('another server'), 'connection-1', REFRESH) });
      await expect(mailAccessToken(mailDeps(), MailSignInProvider.Gmail)).rejects.toBeInstanceOf(MailNeedsSignInError);
      expect(calls('token')).toHaveLength(0);
      expect(connection().status).toBe(MailConnectionStatus.NeedsSignIn);
    });

    it('refuses when the account connected is for another provider', async () => {
      connect();
      await expect(mailAccessToken(mailDeps(), MailSignInProvider.Microsoft)).rejects.toBeInstanceOf(
        MailAccountNotConnectedError,
      );
    });
  });

  describe('sending', () => {
    const message = {
      to: 'ana@example.com',
      from: 'Rivera photos <photos@example.net>',
      subject: 's',
      html: '',
      text: '',
    };

    it('sends as the connected account, with a token renewed through the cloud', async () => {
      connect();
      cloud.on('POST /api/v1/instance/mail/token', () => ({
        status: 200,
        body: { accessToken: ACCESS, expiresInSec: 3600 },
      }));
      mocks.email.sendEmailWithAccount.mockResolvedValue({ messageId: 'message-1', response: 'ok' });

      await expect(sendConnectedEmail(mailDeps(), MailSignInProvider.Gmail, message)).resolves.toMatchObject({
        messageId: 'message-1',
      });

      // a saved sender for another address is replaced by the account's own
      expect(mocks.email.sendEmailWithAccount).toHaveBeenCalledWith({
        ...message,
        from: 'rivera@example.com',
        account: { provider: MailSignInProvider.Gmail, accessToken: ACCESS },
      });
    });

    it('keeps a display name on a sender with the account’s own address', async () => {
      connect();
      cloud.on('POST /api/v1/instance/mail/token', () => ({
        status: 200,
        body: { accessToken: ACCESS, expiresInSec: 3600 },
      }));
      mocks.email.sendEmailWithAccount.mockResolvedValue({ messageId: 'message-1', response: 'ok' });
      await sendConnectedEmail(mailDeps(), MailSignInProvider.Gmail, {
        ...message,
        from: 'Rivera photos <Rivera@Example.com>',
      });
      expect(mocks.email.sendEmailWithAccount).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'Rivera photos <Rivera@Example.com>' }),
      );
    });

    it('renews once and sends again when the provider no longer accepts the token', async () => {
      connect();
      let issued = 0;
      cloud.on('POST /api/v1/instance/mail/token', () => ({
        status: 200,
        body: { accessToken: `access-${++issued}`, expiresInSec: 3600 },
      }));
      mocks.email.sendEmailWithAccount
        .mockRejectedValueOnce(new MailApiError(MailSignInProvider.Gmail, 401, 'Gmail refused (401)'))
        .mockResolvedValueOnce({ messageId: 'message-2', response: 'ok' });

      await expect(sendConnectedEmail(mailDeps(), MailSignInProvider.Gmail, message)).resolves.toMatchObject({
        messageId: 'message-2',
      });
      expect(mocks.email.sendEmailWithAccount).toHaveBeenLastCalledWith(
        expect.objectContaining({ account: { provider: MailSignInProvider.Gmail, accessToken: 'access-2' } }),
      );
    });

    it('passes every other refusal on, so the email is never dropped without an error', async () => {
      connect();
      cloud.on('POST /api/v1/instance/mail/token', () => ({
        status: 200,
        body: { accessToken: ACCESS, expiresInSec: 3600 },
      }));
      mocks.email.sendEmailWithAccount.mockRejectedValue(
        new MailApiError(MailSignInProvider.Gmail, 403, 'Gmail refused (403): Daily sending limit reached'),
      );
      await expect(sendConnectedEmail(mailDeps(), MailSignInProvider.Gmail, message)).rejects.toThrow(
        'Daily sending limit reached',
      );
      expect(mocks.email.sendEmailWithAccount).toHaveBeenCalledTimes(1);
    });
  });
});
