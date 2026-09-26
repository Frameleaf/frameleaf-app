import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { UserMetadataItem } from 'src/types.js';
import { SALT_ROUNDS } from 'src/constants.js';
import { UserAdmin } from 'src/database.js';
import { AuthDto, SignUpDto } from 'src/dtos/auth.dto.js';
import { AuthType, Permission, SystemMetadataKey, UserMetadataKey } from 'src/enum.js';
import { AuthService, emailVerificationProblem } from 'src/services/auth.service.js';
import { ApiKeyFactory } from 'test/factories/api-key.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { OAuthProfileFactory } from 'test/factories/oauth-profile.factory.js';
import { SessionFactory } from 'test/factories/session.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { sharedLinkStub } from 'test/fixtures/shared-link.stub.js';
import { systemConfigStub } from 'test/fixtures/system-config.stub.js';
import { userStub } from 'test/fixtures/user.stub.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const email = 'test@immich.com';
const loginDetails = {
  isSecure: true,
  clientIp: '127.0.0.1',
  deviceOS: '',
  deviceType: '',
  appVersion: null,
};

const dto = {
  email,
  password: 'password',
};

describe(AuthService.name, () => {
  let sut: AuthService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AuthService));

    mocks.oauth.authorize.mockResolvedValue({ url: 'http://test', state: 'state', codeVerifier: 'codeVerifier' });
    mocks.oauth.getLogoutEndpoint.mockResolvedValue('http://end-session-endpoint');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('login', () => {
    it('should throw an error if password login is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.disabled);

      await expect(sut.login(dto, loginDetails)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('should check the user exists', async () => {
      mocks.user.getByEmail.mockResolvedValue(void 0);

      await expect(sut.login(dto, loginDetails)).rejects.toBeInstanceOf(UnauthorizedException);

      expect(mocks.user.getByEmail).toHaveBeenCalledTimes(1);
    });

    it('should check the user has a password', async () => {
      mocks.user.getByEmail.mockResolvedValue({} as UserAdmin);

      await expect(sut.login(dto, loginDetails)).rejects.toBeInstanceOf(UnauthorizedException);

      expect(mocks.user.getByEmail).toHaveBeenCalledTimes(1);
    });

    it('should successfully log the user in', async () => {
      const user = UserFactory.create({ password: 'immich_password' });
      const session = SessionFactory.create();
      mocks.user.getByEmail.mockResolvedValue(user);
      mocks.session.create.mockResolvedValue(session);

      await expect(sut.login(dto, loginDetails)).resolves.toEqual({
        accessToken: 'cmFuZG9tLWJ5dGVz',
        userId: user.id,
        userEmail: user.email,
        name: user.name,
        profileImagePath: user.profileImagePath,
        isAdmin: user.isAdmin,
        isOnboarded: false,
        shouldChangePassword: user.shouldChangePassword,
      });

      expect(mocks.user.getByEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe('changePassword', () => {
    it('should change the password', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.create(user);
      const dto = { password: 'old-password', newPassword: 'new-password' };

      mocks.user.getForChangePassword.mockResolvedValue({ id: user.id, password: 'hash-password' });
      mocks.user.update.mockResolvedValue(user);

      await sut.changePassword(auth, dto);

      expect(mocks.user.getForChangePassword).toHaveBeenCalledWith(user.id);
      expect(mocks.crypto.compareBcrypt).toHaveBeenCalledWith('old-password', 'hash-password');
      expect(mocks.event.emit).toHaveBeenCalledWith('AuthChangePassword', {
        userId: user.id,
        currentSessionId: auth.session?.id,
        shouldLogoutSessions: undefined,
      });
    });

    it('should clear shouldChangePassword', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.create(user);
      const dto = { password: 'old-password', newPassword: 'new-password' };

      mocks.user.getForChangePassword.mockResolvedValue({ id: user.id, password: 'hash-password' });
      mocks.user.update.mockResolvedValue(user);

      await sut.changePassword(auth, dto);

      expect(mocks.user.update).toHaveBeenCalledWith(user.id, {
        password: 'new-password (hashed)',
        shouldChangePassword: false,
      });
    });

    it('should throw when password does not match existing password', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.create(user);
      const dto = { password: 'old-password', newPassword: 'new-password' };

      mocks.crypto.compareBcrypt.mockReturnValue(false);

      mocks.user.getForChangePassword.mockResolvedValue({ id: user.id, password: 'hash-password' });

      await expect(sut.changePassword(auth, dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw when user does not have a password', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.create(user);
      const dto = { password: 'old-password', newPassword: 'new-password' };

      mocks.user.getForChangePassword.mockResolvedValue({ id: user.id, password: '' });

      await expect(sut.changePassword(auth, dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should change the password and logout other sessions', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.create(user);
      const dto = { password: 'old-password', newPassword: 'new-password', invalidateSessions: true };

      mocks.user.getForChangePassword.mockResolvedValue({ id: user.id, password: 'hash-password' });
      mocks.user.update.mockResolvedValue(user);

      await sut.changePassword(auth, dto);

      expect(mocks.user.getForChangePassword).toHaveBeenCalledWith(user.id);
      expect(mocks.crypto.compareBcrypt).toHaveBeenCalledWith('old-password', 'hash-password');
      expect(mocks.event.emit).toHaveBeenCalledWith('AuthChangePassword', {
        userId: user.id,
        invalidateSessions: true,
        currentSessionId: auth.session?.id,
      });
    });
  });

  describe('logout', () => {
    it('should return the end session endpoint', async () => {
      const auth = AuthFactory.create();

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.enabled);

      await expect(sut.logout(auth, AuthType.OAuth)).resolves.toEqual({
        successful: true,
        redirectUri: 'http://end-session-endpoint/',
      });
    });

    it('should include the id token hint for OAuth sessions', async () => {
      const auth = AuthFactory.from().session().build();

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.enabled);
      mocks.session.get.mockResolvedValue({
        id: auth.session!.id,
        expiresAt: null,
        oauthBearerToken: 'id-token',
        pinExpiresAt: null,
      });
      mocks.session.delete.mockResolvedValue();

      await expect(sut.logout(auth, AuthType.OAuth)).resolves.toEqual({
        successful: true,
        redirectUri: 'http://end-session-endpoint/?id_token_hint=id-token',
      });
    });

    it('should return the custom end session endpoint if provided', async () => {
      const auth = AuthFactory.create();

      mocks.systemMetadata.get.mockResolvedValue({
        oauth: { enabled: true, endSessionEndpoint: 'http://custom-logout-url' },
      });

      await expect(sut.logout(auth, AuthType.OAuth)).resolves.toEqual({
        successful: true,
        redirectUri: 'http://custom-logout-url/',
      });
    });

    it('should return the auto-discovered end session endpoint if custom endpoint is not provided', async () => {
      const auth = AuthFactory.create();

      mocks.systemMetadata.get.mockResolvedValue({
        oauth: { enabled: true, endSessionEndpoint: '' },
      });

      await expect(sut.logout(auth, AuthType.OAuth)).resolves.toEqual({
        successful: true,
        redirectUri: 'http://end-session-endpoint/',
      });
    });

    it('should return the default redirect', async () => {
      const auth = AuthFactory.create();

      await expect(sut.logout(auth, AuthType.Password)).resolves.toEqual({
        successful: true,
        redirectUri: '/auth/login?autoLaunch=0',
      });
    });

    it('should delete the access token', async () => {
      const auth = { user: { id: '123' }, session: { id: 'token123' } } as AuthDto;
      mocks.session.get.mockResolvedValue({
        id: auth.session!.id,
        expiresAt: null,
        oauthBearerToken: null,
        pinExpiresAt: null,
      });
      mocks.session.delete.mockResolvedValue();

      await expect(sut.logout(auth, AuthType.Password)).resolves.toEqual({
        successful: true,
        redirectUri: '/auth/login?autoLaunch=0',
      });

      expect(mocks.session.delete).toHaveBeenCalledWith('token123');
      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'token123' });
    });

    describe('for a Sign in with Frameleaf session (FL-177)', () => {
      const auth = { user: { id: '123' }, session: { id: 'fl-session' } } as AuthDto;

      beforeEach(() => {
        mocks.config.getEnv.mockReturnValue({
          ...mocks.config.getEnv(),
          frameleafCloud: { ...mocks.config.getEnv().frameleafCloud, url: 'https://api.frameleaf.cloud' },
        });
        mocks.systemMetadata.get.mockImplementation((key) =>
          Promise.resolve(
            (key === SystemMetadataKey.FrameleafCloudLink
              ? {
                  status: 'linked',
                  cloudUrl: 'https://api.frameleaf.cloud',
                  instanceId: 'instance-1',
                  oidc: {
                    issuer: 'https://id.frameleaf.cloud',
                    clientId: 'instance-1',
                    scope: 'openid email profile',
                    roleClaim: 'frameleaf_role',
                    storageLabelClaim: '',
                  },
                }
              : null) as never,
          ),
        );
        mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
        mocks.instanceIdentity.loadOrCreate.mockResolvedValue({ instanceId: 'instance-1', kid: 'kid-1' } as never);
        mocks.session.get.mockResolvedValue({
          id: 'fl-session',
          expiresAt: null,
          oauthBearerToken: 'id-token-1',
          pinExpiresAt: null,
        });
        mocks.session.delete.mockResolvedValue();
        mocks.frameleafAccount.getSession.mockResolvedValue({ sessionId: 'fl-session', sub: 'fl-sub' } as never);
      });

      it('ends the Frameleaf session through the issuer’s end_session_endpoint', async () => {
        mocks.oauth.getLogoutEndpoint.mockResolvedValue('https://id.frameleaf.cloud/session/end');

        const result = await sut.logout(auth, AuthType.Password);

        const url = new URL(result.redirectUri);
        expect(`${url.origin}${url.pathname}`).toBe('https://id.frameleaf.cloud/session/end');
        expect(url.searchParams.get('client_id')).toBe('instance-1');
        expect(url.searchParams.get('id_token_hint')).toBe('id-token-1');
        expect(mocks.oauth.getLogoutEndpoint).toHaveBeenCalledWith(
          expect.objectContaining({ clientId: 'instance-1', issuerUrl: 'https://id.frameleaf.cloud' }),
        );
        expect(mocks.session.delete).toHaveBeenCalledWith('fl-session');
      });

      it('never sends anyone to an end-session endpoint outside the configured cloud', async () => {
        mocks.oauth.getLogoutEndpoint.mockResolvedValue('https://id.elsewhere.test/session/end');

        await expect(sut.logout(auth, AuthType.Password)).resolves.toEqual({
          successful: true,
          redirectUri: '/auth/login?autoLaunch=0',
        });
      });

      it('signs out locally when the issuer cannot be reached', async () => {
        mocks.oauth.getLogoutEndpoint.mockRejectedValue(new Error('unreachable'));

        await expect(sut.logout(auth, AuthType.Password)).resolves.toEqual({
          successful: true,
          redirectUri: '/auth/login?autoLaunch=0',
        });
        expect(mocks.session.delete).toHaveBeenCalledWith('fl-session');
      });

      it('leaves a session Sign in with Frameleaf did not create to the usual sign-out', async () => {
        mocks.frameleafAccount.getSession.mockResolvedValue(undefined);

        await expect(sut.logout(auth, AuthType.Password)).resolves.toEqual({
          successful: true,
          redirectUri: '/auth/login?autoLaunch=0',
        });
        expect(mocks.oauth.getLogoutEndpoint).not.toHaveBeenCalled();
      });
    });

    it('should return the default redirect if auth type is OAUTH but oauth is not enabled', async () => {
      const auth = { user: { id: '123' } } as AuthDto;

      await expect(sut.logout(auth, AuthType.OAuth)).resolves.toEqual({
        successful: true,
        redirectUri: '/auth/login?autoLaunch=0',
      });
    });
  });

  describe('backchannelLogout', () => {
    const dto = { logout_token: 'fake-jwt-token' };

    describe('for Sign in with Frameleaf (FL-158)', () => {
      const token = (aud: string) =>
        ['e30', Buffer.from(JSON.stringify({ aud })).toString('base64url'), 'sig'].join('.');

      beforeEach(() => {
        mocks.config.getEnv.mockReturnValue({
          ...mocks.config.getEnv(),
          frameleafCloud: { ...mocks.config.getEnv().frameleafCloud, url: 'https://cloud.test' },
        });
        mocks.systemMetadata.get.mockImplementation((key) =>
          Promise.resolve(
            (key === SystemMetadataKey.FrameleafCloudLink
              ? {
                  status: 'linked',
                  cloudUrl: 'https://cloud.test',
                  instanceId: 'instance-1',
                  oidc: {
                    issuer: 'https://id.cloud.test',
                    clientId: 'instance-1',
                    scope: 'openid',
                    roleClaim: 'frameleaf_role',
                    storageLabelClaim: '',
                  },
                }
              : null) as never,
          ),
        );
        // FL-177: the client authenticates with this server's key only
        mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
        mocks.instanceIdentity.loadOrCreate.mockResolvedValue({ instanceId: 'instance-1', kid: 'kid-1' } as never);
      });

      it('ends every session tagged with the sid or sub, verified against the Frameleaf client', async () => {
        mocks.oauth.validateLogoutToken.mockResolvedValue({ sid: 'fl-sid', sub: 'fl-sub' });
        mocks.session.delete.mockResolvedValue();
        mocks.frameleafAccount.findSessions.mockResolvedValue([
          { sessionId: 'session-1' },
          { sessionId: 'session-2' },
        ] as never);

        await sut.backchannelLogout({ logout_token: token('instance-1') });

        expect(mocks.oauth.validateLogoutToken).toHaveBeenCalledWith(
          expect.objectContaining({ clientId: 'instance-1', issuerUrl: 'https://id.cloud.test' }),
          expect.any(String),
        );
        expect(mocks.frameleafAccount.findSessions).toHaveBeenCalledWith({ sid: 'fl-sid', sub: 'fl-sub' });
        expect(mocks.session.delete).toHaveBeenCalledWith('session-1');
        expect(mocks.session.delete).toHaveBeenCalledWith('session-2');
        expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'session-2' });
        expect(mocks.frameleafAccount.deleteSessions).toHaveBeenCalledWith(['session-1', 'session-2']);
        expect(mocks.session.invalidateOAuth).not.toHaveBeenCalled();
      });

      it('leaves a token for another audience to the administrator’s own provider', async () => {
        await expect(sut.backchannelLogout({ logout_token: token('someone-else') })).rejects.toThrow(
          'Received backchannel logout request but OAuth is not enabled',
        );
        expect(mocks.frameleafAccount.findSessions).not.toHaveBeenCalled();
      });
    });

    it('should throw a Bad Request Exception if OAuth is not enabled', async () => {
      await expect(sut.backchannelLogout(dto)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.backchannelLogout(dto)).rejects.toThrow(
        'Received backchannel logout request but OAuth is not enabled',
      );
    });

    it('should throw a Bad Request Exception if the logout token validation fails', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.validateLogoutToken.mockRejectedValue(new Error('Token validation failed'));

      await expect(sut.backchannelLogout(dto)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.backchannelLogout(dto)).rejects.toThrow('Error backchannel logout: token validation failed');
    });

    it('should throw a Bad Request Exception if there are no claims in the logout token', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.validateLogoutToken.mockResolvedValue(null);

      await expect(sut.backchannelLogout(dto)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.backchannelLogout(dto)).rejects.toThrow('Invalid logout token: no claims found');
    });

    it('should throw a Bad Request Exception if there is neither the sub nor the sid claim', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.validateLogoutToken.mockResolvedValue({ sub: '', sid: '' });

      await expect(sut.backchannelLogout(dto)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.backchannelLogout(dto)).rejects.toThrow(
        'Invalid logout token: it must contain either a sub or a sid claim',
      );
    });

    it('should invalidate the OAuth session(s) if the logout token is valid', async () => {
      const claims = { sub: 'fake-sub', sid: 'fake-sid' };
      const deletedSessionIds: string[] = ['fake-session-1', 'fake-session-2'];

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.validateLogoutToken.mockResolvedValue(claims);
      mocks.session.invalidateOAuth.mockResolvedValue(deletedSessionIds);
      mocks.event.emit.mockResolvedValue(void 0);
      mocks.event.emit.mockResolvedValue(void 0);

      await sut.backchannelLogout(dto);

      expect(mocks.session.invalidateOAuth).toHaveBeenCalledWith({
        oauthSid: claims.sid,
        oauthId: claims.sub,
      });

      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'fake-session-1' });
      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'fake-session-2' });
    });
  });

  describe('adminSignUp', () => {
    const dto: SignUpDto = { email: 'test@immich.com', password: 'password', name: 'immich admin' };

    it('should sign up the admin', async () => {
      mocks.user.create.mockResolvedValue({
        ...userStub.admin,
        ...dto,
        id: 'admin',
        name: 'immich admin',
        createdAt: new Date('2021-01-01'),
        metadata: [] as UserMetadataItem[],
      } as UserAdmin);

      await expect(sut.adminSignUp(dto)).resolves.toMatchObject({
        avatarColor: expect.any(String),
        id: 'admin',
        createdAt: new Date('2021-01-01'),
        email: 'test@immich.com',
        name: 'immich admin',
      });

      expect(mocks.user.create).toHaveBeenCalled();
    });
  });

  describe('validate - socket connections', () => {
    it('should throw when token is not provided', async () => {
      await expect(
        sut.authenticate({
          headers: {},
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('should validate using authorization header', async () => {
      const session = SessionFactory.create();
      const sessionWithToken = {
        id: session.id,
        updatedAt: session.updatedAt,
        user: UserFactory.create(),
        pinExpiresAt: null,
        appVersion: null,
        oauthSid: null,
      };

      mocks.session.getByToken.mockResolvedValue(sessionWithToken);

      await expect(
        sut.authenticate({
          headers: { authorization: 'Bearer auth_token' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        }),
      ).resolves.toEqual({
        user: sessionWithToken.user,
        session: {
          id: session.id,
          hasElevatedPermission: false,
        },
      });
    });
  });

  describe('validate - shared key', () => {
    it('should not accept a non-existent key', async () => {
      mocks.sharedLink.getByKey.mockResolvedValue(void 0);

      await expect(
        sut.authenticate({
          headers: { 'x-immich-share-key': 'key' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: true, uri: 'test' },
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('should not accept an expired key', async () => {
      mocks.sharedLink.getByKey.mockResolvedValue(sharedLinkStub.expired as any);

      await expect(
        sut.authenticate({
          headers: { 'x-immich-share-key': 'key' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: true, uri: 'test' },
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('says an expired key expired, with the same message and nothing about the link', async () => {
      mocks.sharedLink.getByKey.mockResolvedValue(sharedLinkStub.expired as any);

      const error = await sut
        .authenticate({
          headers: { 'x-immich-share-key': 'key' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: true, uri: 'test' },
        })
        .catch((error_: UnauthorizedException) => error_);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getResponse()).toEqual({
        message: 'Invalid share key',
        error: 'Unauthorized',
        statusCode: 401,
        reason: 'expired',
      });
    });

    it('does not say a link of a removed account expired', async () => {
      mocks.sharedLink.getByKey.mockResolvedValue({ ...sharedLinkStub.expired, user: null } as any);

      const error = await sut
        .authenticate({
          headers: { 'x-immich-share-key': 'key' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: true, uri: 'test' },
        })
        .catch((error_: UnauthorizedException) => error_);

      expect((error as UnauthorizedException).getResponse()).not.toHaveProperty('reason');
    });

    it('gives an unknown key no reason', async () => {
      mocks.sharedLink.getByKey.mockResolvedValue(void 0);

      const error = await sut
        .authenticate({
          headers: { 'x-immich-share-key': 'key' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: true, uri: 'test' },
        })
        .catch((error_: UnauthorizedException) => error_);

      expect((error as UnauthorizedException).getResponse()).not.toHaveProperty('reason');
    });

    it('should not accept a key on a non-shared route', async () => {
      mocks.sharedLink.getByKey.mockResolvedValue(sharedLinkStub.valid as any);

      await expect(
        sut.authenticate({
          headers: { 'x-immich-share-key': 'key' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('should not accept a key without a user', async () => {
      mocks.sharedLink.getByKey.mockResolvedValue(sharedLinkStub.expired as any);
      mocks.user.get.mockResolvedValue(void 0);

      await expect(
        sut.authenticate({
          headers: { 'x-immich-share-key': 'key' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: true, uri: 'test' },
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('should accept a base64url key', async () => {
      const user = UserFactory.create();
      const sharedLink = { ...sharedLinkStub.valid, user } as any;

      mocks.sharedLink.getByKey.mockResolvedValue(sharedLink);
      mocks.user.get.mockResolvedValue(user);

      const buffer = sharedLink.key;
      const key = buffer.toString('base64url');

      await expect(
        sut.authenticate({
          headers: { 'x-immich-share-key': key },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: true, uri: 'test' },
        }),
      ).resolves.toEqual({ user, sharedLink });

      expect(mocks.sharedLink.getByKey).toHaveBeenCalledWith(buffer);
    });

    it('should accept a hex key', async () => {
      const user = UserFactory.create();
      const sharedLink = { ...sharedLinkStub.valid, user } as any;

      mocks.sharedLink.getByKey.mockResolvedValue(sharedLink);
      mocks.user.get.mockResolvedValue(user);

      const buffer = sharedLink.key;
      const key = buffer.toString('hex');

      await expect(
        sut.authenticate({
          headers: { 'x-immich-share-key': key },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: true, uri: 'test' },
        }),
      ).resolves.toEqual({ user, sharedLink });

      expect(mocks.sharedLink.getByKey).toHaveBeenCalledWith(buffer);
    });
  });

  describe('validate - shared link slug', () => {
    it('should not accept a non-existent slug', async () => {
      mocks.sharedLink.getBySlug.mockResolvedValue(void 0);

      await expect(
        sut.authenticate({
          headers: { 'x-immich-share-slug': 'slug' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: true, uri: 'test' },
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('should accept a valid slug', async () => {
      const user = UserFactory.create();
      const sharedLink = { ...sharedLinkStub.valid, slug: 'slug-123', user } as any;

      mocks.sharedLink.getBySlug.mockResolvedValue(sharedLink);
      mocks.user.get.mockResolvedValue(user);

      await expect(
        sut.authenticate({
          headers: { 'x-immich-share-slug': 'slug-123' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: true, uri: 'test' },
        }),
      ).resolves.toEqual({ user, sharedLink });

      expect(mocks.sharedLink.getBySlug).toHaveBeenCalledWith('slug-123');
    });
  });

  describe('validate - user token', () => {
    it('should throw if no token is found', async () => {
      mocks.session.getByToken.mockResolvedValue(void 0);

      await expect(
        sut.authenticate({
          headers: { 'x-immich-user-token': 'auth_token' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('should return an auth dto', async () => {
      const session = SessionFactory.create();
      const sessionWithToken = {
        id: session.id,
        updatedAt: session.updatedAt,
        user: UserFactory.create(),
        pinExpiresAt: null,
        appVersion: null,
        oauthSid: null,
      };

      mocks.session.getByToken.mockResolvedValue(sessionWithToken);

      await expect(
        sut.authenticate({
          headers: { cookie: 'immich_access_token=auth_token' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        }),
      ).resolves.toEqual({
        user: sessionWithToken.user,
        session: {
          id: session.id,
          hasElevatedPermission: false,
        },
      });
    });

    it('should leave sensitive media to the lock record instead of the session filter (FL-34)', async () => {
      const session = SessionFactory.create();
      const sessionWithToken = {
        id: session.id,
        updatedAt: session.updatedAt,
        user: UserFactory.create(),
        pinExpiresAt: null,
        appVersion: null,
        oauthSid: null,
      };

      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { nsfwDetection: { hideFromLibrary: true } },
      });
      mocks.session.getByToken.mockResolvedValue(sessionWithToken);

      const result = await sut.authenticate({
        headers: { cookie: 'immich_access_token=auth_token' },
        queryParams: {},
        metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
      });

      expect(result).toEqual({
        user: sessionWithToken.user,
        session: {
          id: session.id,
          hasElevatedPermission: false,
        },
      });
      expect(result.hiddenContent).toBeUndefined();
      expect(result.hideNsfwAssets).toBeUndefined();
    });

    it('should keep suppressed people in the session filter without the sensitive flag', async () => {
      const session = SessionFactory.create();
      const sessionWithToken = {
        id: session.id,
        updatedAt: session.updatedAt,
        user: UserFactory.create(),
        pinExpiresAt: null,
        appVersion: null,
        oauthSid: null,
      };

      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { nsfwDetection: { hideFromLibrary: true } },
      });
      mocks.session.getByToken.mockResolvedValue(sessionWithToken);
      mocks.user.getMetadata.mockResolvedValue([
        {
          key: UserMetadataKey.Preferences,
          value: { privacy: { suppression: { personIds: ['person-1'], tagIds: [], petIds: [], scope: 'owned' } } },
        },
      ] as any);

      const result = await sut.authenticate({
        headers: { cookie: 'immich_access_token=auth_token' },
        queryParams: {},
        metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
      });

      expect(result.hiddenContent).toEqual(expect.objectContaining({ includeNsfw: false, personIds: ['person-1'] }));
    });

    it('should extend a near-expiry elevated PIN session to sixty minutes', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
      const session = SessionFactory.create({ updatedAt: new Date('2026-05-08T12:00:00.000Z') });
      const sessionWithToken = {
        id: session.id,
        updatedAt: session.updatedAt,
        user: UserFactory.create(),
        isPendingSyncReset: false,
        pinExpiresAt: DateTime.now().plus({ minutes: 1 }).toJSDate(),
        appVersion: null,
        oauthSid: null,
      };

      mocks.session.getByToken.mockResolvedValue(sessionWithToken);
      mocks.session.refreshPinExpiry.mockResolvedValue(true);

      await expect(
        sut.authenticate({
          headers: { cookie: 'immich_access_token=auth_token' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          session: {
            id: session.id,
            hasElevatedPermission: true,
          },
        }),
      );

      expect(mocks.session.refreshPinExpiry).toHaveBeenCalledWith(session.id, new Date('2026-05-08T13:00:00.000Z'));
      expect(mocks.session.update).not.toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ pinExpiresAt: expect.anything() }),
      );
      vi.useRealTimers();
    });

    describe('when the elevation refresh finds the session changed (FL-34)', () => {
      const nearExpiry = () => {
        const session = SessionFactory.create({ updatedAt: new Date() });
        return {
          id: session.id,
          updatedAt: session.updatedAt,
          user: UserFactory.create(),
          isPendingSyncReset: false,
          pinExpiresAt: DateTime.now().plus({ minutes: 1 }).toJSDate(),
          appVersion: null,
          oauthSid: null,
        };
      };
      const authenticate = () =>
        sut.authenticate({
          headers: { cookie: 'immich_access_token=auth_token' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        });

      it('continues without elevation when the session was locked meanwhile', async () => {
        const session = nearExpiry();
        mocks.session.getByToken
          .mockResolvedValueOnce(session)
          .mockResolvedValueOnce({ ...session, pinExpiresAt: null });
        mocks.session.refreshPinExpiry.mockResolvedValue(false);

        await expect(authenticate()).resolves.toEqual(
          expect.objectContaining({ session: { id: session.id, hasElevatedPermission: false } }),
        );
        expect(mocks.session.getByToken).toHaveBeenCalledTimes(2);
      });

      it('rejects the request when the session was deleted meanwhile', async () => {
        const session = nearExpiry();
        mocks.session.getByToken.mockResolvedValueOnce(session).mockResolvedValueOnce(void 0);
        mocks.session.refreshPinExpiry.mockResolvedValue(false);

        await expect(authenticate()).rejects.toBeInstanceOf(UnauthorizedException);
      });
    });

    it('does not extend an elevated session for a status read (FL-34)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
      const session = SessionFactory.create({ updatedAt: new Date('2026-05-08T12:00:00.000Z') });
      const sessionWithToken = {
        id: session.id,
        updatedAt: session.updatedAt,
        user: UserFactory.create(),
        isPendingSyncReset: false,
        pinExpiresAt: DateTime.now().plus({ minutes: 1 }).toJSDate(),
        appVersion: null,
        oauthSid: null,
      };
      mocks.session.getByToken.mockResolvedValue(sessionWithToken);

      await expect(
        sut.authenticate({
          headers: { cookie: 'immich_access_token=auth_token' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test', refreshElevation: false },
        }),
      ).resolves.toEqual(expect.objectContaining({ session: { id: session.id, hasElevatedPermission: true } }));

      expect(mocks.session.refreshPinExpiry).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('does not elevate a request whose refresh loses to a concurrent lock (FL-34)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
      const session = SessionFactory.create({ updatedAt: new Date('2026-05-08T12:00:00.000Z') });
      const sessionWithToken = {
        id: session.id,
        updatedAt: session.updatedAt,
        user: UserFactory.create(),
        isPendingSyncReset: false,
        pinExpiresAt: DateTime.now().plus({ minutes: 1 }).toJSDate(),
        appVersion: null,
        oauthSid: null,
      };

      mocks.session.getByToken.mockResolvedValue(sessionWithToken);
      mocks.session.refreshPinExpiry.mockResolvedValue(false);

      await expect(
        sut.authenticate({
          headers: { cookie: 'immich_access_token=auth_token' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          session: {
            id: session.id,
            hasElevatedPermission: false,
          },
        }),
      );

      expect(mocks.session.refreshPinExpiry).toHaveBeenCalledWith(session.id, new Date('2026-05-08T13:00:00.000Z'));
      expect(mocks.session.update).not.toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ pinExpiresAt: expect.anything() }),
      );
      vi.useRealTimers();
    });

    it('should return normal permissions for an expired elevated PIN session', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
      const session = SessionFactory.create({ updatedAt: new Date('2026-05-08T12:00:00.000Z') });
      const sessionWithToken = {
        id: session.id,
        updatedAt: session.updatedAt,
        user: UserFactory.create(),
        isPendingSyncReset: false,
        pinExpiresAt: DateTime.now().minus({ minutes: 1 }).toJSDate(),
        appVersion: null,
        oauthSid: null,
      };

      mocks.session.getByToken.mockResolvedValue(sessionWithToken);

      await expect(
        sut.authenticate({
          headers: { cookie: 'immich_access_token=auth_token' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          session: {
            id: session.id,
            hasElevatedPermission: false,
          },
        }),
      );

      expect(mocks.session.update).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should throw if admin route and not an admin', async () => {
      const session = SessionFactory.create();
      const sessionWithToken = {
        id: session.id,
        updatedAt: session.updatedAt,
        user: UserFactory.create(),
        isPendingSyncReset: false,
        pinExpiresAt: null,
        appVersion: null,
        oauthSid: null,
      };

      mocks.session.getByToken.mockResolvedValue(sessionWithToken);

      await expect(
        sut.authenticate({
          headers: { cookie: 'immich_access_token=auth_token' },
          queryParams: {},
          metadata: { adminRoute: true, sharedLinkRoute: false, uri: 'test' },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('should update when access time exceeds an hour', async () => {
      const session = SessionFactory.create({ updatedAt: DateTime.now().minus({ hours: 2 }).toJSDate() });
      const sessionWithToken = {
        id: session.id,
        updatedAt: session.updatedAt,
        user: UserFactory.create(),
        isPendingSyncReset: false,
        pinExpiresAt: null,
        appVersion: null,
        oauthSid: null,
      };

      mocks.session.getByToken.mockResolvedValue(sessionWithToken);
      mocks.session.update.mockResolvedValue(session);

      await expect(
        sut.authenticate({
          headers: { cookie: 'immich_access_token=auth_token' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        }),
      ).resolves.toBeDefined();

      expect(mocks.session.update).toHaveBeenCalled();
    });
  });

  describe('validate - api key', () => {
    it('should throw an error if no api key is found', async () => {
      mocks.apiKey.getKey.mockResolvedValue(void 0);

      await expect(
        sut.authenticate({
          headers: { 'x-api-key': 'auth_token' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.apiKey.getKey).toHaveBeenCalledWith(Buffer.from('auth_token (hashed)'));
    });

    it('should throw an error if api key has insufficient permissions', async () => {
      const authUser = UserFactory.create();
      const authApiKey = ApiKeyFactory.create({ permissions: [] });

      mocks.apiKey.getKey.mockResolvedValue({ ...authApiKey, user: authUser });

      const result = sut.authenticate({
        headers: { 'x-api-key': 'auth_token' },
        queryParams: {},
        metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test', permission: Permission.AssetRead },
      });

      await expect(result).rejects.toBeInstanceOf(ForbiddenException);
      await expect(result).rejects.toThrow('Missing required permission: asset.read');
    });

    it('should default to requiring the all permission when omitted', async () => {
      const authUser = UserFactory.create();
      const authApiKey = ApiKeyFactory.create({ permissions: [Permission.AssetRead] });

      mocks.apiKey.getKey.mockResolvedValue({ ...authApiKey, user: authUser });

      const result = sut.authenticate({
        headers: { 'x-api-key': 'auth_token' },
        queryParams: {},
        metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
      });
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);
      await expect(result).rejects.toThrow('Missing required permission: all');
    });

    it('should not require any permission when metadata is set to `false`', async () => {
      const authUser = UserFactory.create();
      const authApiKey = ApiKeyFactory.from({ permissions: [Permission.ActivityRead] })
        .user(authUser)
        .build();

      mocks.apiKey.getKey.mockResolvedValue(authApiKey);

      const result = sut.authenticate({
        headers: { 'x-api-key': 'auth_token' },
        queryParams: {},
        metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test', permission: false },
      });
      await expect(result).resolves.toEqual({ user: authUser, apiKey: expect.objectContaining(authApiKey) });
    });

    it('should return an auth dto', async () => {
      const authUser = UserFactory.create();
      const authApiKey = ApiKeyFactory.from({ permissions: [Permission.All] })
        .user(authUser)
        .build();

      mocks.apiKey.getKey.mockResolvedValue(authApiKey);

      await expect(
        sut.authenticate({
          headers: { 'x-api-key': 'auth_token' },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        }),
      ).resolves.toEqual({ user: authUser, apiKey: expect.objectContaining(authApiKey) });
      expect(mocks.apiKey.getKey).toHaveBeenCalledWith(Buffer.from('auth_token (hashed)'));
    });
  });

  describe('getMobileRedirect', () => {
    it('should pass along the query params', () => {
      expect(sut.getMobileRedirect('https://immich.app?code=123&state=456')).toEqual(
        'app.immich:///oauth-callback?code=123&state=456',
      );
    });

    it('should work if called without query params', () => {
      expect(sut.getMobileRedirect('https://immich.app')).toEqual('app.immich:///oauth-callback?');
    });
  });

  /** An override that is this server's mobile-redirect endpoint, so its Frameleaf sibling is known. */
  const frameleafOverride = {
    oauth: {
      ...systemConfigStub.oauthWithMobileOverride.oauth,
      mobileRedirectUri: 'https://photos.example.test/immich/api/oauth/mobile-redirect',
    },
  };

  describe('getFrameleafMobileRedirect (FL-131)', () => {
    it('passes the query to the Frameleaf app callback', () => {
      expect(sut.getFrameleafMobileRedirect('/api/oauth/frameleaf-mobile-redirect?code=123&state=456')).toEqual(
        'frameleaf-auth:///oauth-callback?code=123&state=456',
      );
    });

    it('works without query params', () => {
      expect(sut.getFrameleafMobileRedirect('https://immich.app')).toEqual('frameleaf-auth:///oauth-callback?');
    });
  });

  describe('authorize', () => {
    it('should fail if oauth is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ oauth: { enabled: false } });

      await expect(sut.authorize({ redirectUri: 'https://demo.immich.app' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should authorize the user', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithMobileOverride);

      await sut.authorize({ redirectUri: 'https://demo.immich.app' });
    });

    it('sends each app its own callback when the mobile redirect override is on (FL-131)', async () => {
      mocks.systemMetadata.get.mockResolvedValue(frameleafOverride);

      await sut.authorize({ redirectUri: 'frameleaf-auth:///oauth-callback' });
      await sut.authorize({ redirectUri: 'app.immich:///oauth-callback' });

      expect(mocks.oauth.authorize.mock.calls.map(([, redirectUri]) => redirectUri)).toEqual([
        'https://photos.example.test/immich/api/oauth/frameleaf-mobile-redirect',
        'https://photos.example.test/immich/api/oauth/mobile-redirect',
      ]);
    });

    it('refuses to send the Frameleaf callback anywhere but beside a mobile-redirect override (FL-131)', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithMobileOverride);

      await expect(sut.authorize({ redirectUri: 'frameleaf-auth:///oauth-callback' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // The Immich app's override is unchanged.
      await sut.authorize({ redirectUri: 'app.immich:///oauth-callback' });
      expect(mocks.oauth.authorize).toHaveBeenCalledWith(
        expect.anything(),
        'http://mobile-redirect',
        undefined,
        undefined,
      );
    });

    it('passes the Frameleaf callback through when the override is off (FL-131)', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);

      await sut.authorize({ redirectUri: 'frameleaf-auth:///oauth-callback' });

      expect(mocks.oauth.authorize).toHaveBeenCalledWith(
        expect.anything(),
        'frameleaf-auth:///oauth-callback',
        undefined,
        undefined,
      );
    });
  });

  describe('callback', () => {
    it('refuses to link an existing account by an email the provider has not verified (FL-158)', async () => {
      const user = UserFactory.create();
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ email: user.email, email_verified: false }),
      });
      mocks.user.getByEmail.mockResolvedValue(user);

      await expect(
        sut.callback(
          { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
          {},
          loginDetails,
        ),
      ).rejects.toThrow('has not been verified');
      expect(mocks.user.update).not.toHaveBeenCalled();
      expect(mocks.session.create).not.toHaveBeenCalled();
    });

    it('refuses to register an account when the provider omits email_verified, saying how to fix it (FL-158)', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithAutoRegister);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ email_verified: undefined }),
      });
      mocks.user.getByEmail.mockResolvedValue(void 0);

      await expect(
        sut.callback(
          { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
          {},
          loginDetails,
        ),
      ).rejects.toThrow('map the email_verified claim');
      expect(mocks.user.create).not.toHaveBeenCalled();
    });

    it('accepts email_verified sent as the string "true" (FL-158)', () => {
      expect(emailVerificationProblem({ email_verified: 'true' })).toBeNull();
      expect(emailVerificationProblem({ email_verified: true })).toBeNull();
      expect(emailVerificationProblem({ email_verified: 'false' })).toContain('has not been verified');
      expect(emailVerificationProblem({})).toContain('map the email_verified claim');
    });

    it('should throw an error if OAuth is not enabled', async () => {
      await expect(
        sut.callback({ url: '', state: 'xyz789', codeVerifier: 'foo' }, {}, loginDetails),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should not allow auto registering', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile: OAuthProfileFactory.create() });

      await expect(
        sut.callback(
          { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
          {},
          loginDetails,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.user.getByEmail).toHaveBeenCalledTimes(1);
    });

    it('should link an existing user', async () => {
      const user = UserFactory.create();
      const profile = OAuthProfileFactory.create();

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile });
      mocks.user.getByEmail.mockResolvedValue(user);
      mocks.user.update.mockResolvedValue(user);
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foobar' },
        {},
        loginDetails,
      );

      expect(mocks.user.getByEmail).toHaveBeenCalledTimes(1);
      expect(mocks.user.update).toHaveBeenCalledWith(user.id, { oauthId: profile.sub });
    });

    it('should store the OAuth bearer token on the new session', async () => {
      const user = UserFactory.create();
      const profile = OAuthProfileFactory.create();

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile, sid: 'oauth-sid', idToken: 'oauth-bearer-token' });
      mocks.user.getByEmail.mockResolvedValue(user);
      mocks.user.update.mockResolvedValue(user);
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foobar' },
        {},
        loginDetails,
      );

      expect(mocks.session.create).toHaveBeenCalledWith(
        expect.objectContaining({ oauthSid: 'oauth-sid', oauthBearerToken: 'oauth-bearer-token' }),
      );
    });

    it('should normalize the email from the OAuth profile before linking', async () => {
      const user = UserFactory.create();
      const profile = OAuthProfileFactory.create({ email: '  TEST@IMMICH.CLOUD  ' });

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile });
      mocks.user.getByEmail.mockResolvedValue(user);
      mocks.user.update.mockResolvedValue(user);
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foobar' },
        {},
        loginDetails,
      );

      expect(mocks.user.getByEmail).toHaveBeenCalledWith('test@immich.cloud');
      expect(mocks.user.update).toHaveBeenCalledWith(user.id, { oauthId: profile.sub });
    });

    it('should not link to a user with a different oauth sub', async () => {
      const user = UserFactory.create({ oauthId: 'existing-sub' });

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithAutoRegister);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile: OAuthProfileFactory.create() });
      mocks.user.getByEmail.mockResolvedValueOnce(user);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));

      await expect(
        sut.callback(
          { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foobar' },
          {},
          loginDetails,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(mocks.user.update).not.toHaveBeenCalled();
      expect(mocks.user.create).not.toHaveBeenCalled();
    });

    it('should allow auto registering by default', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.enabled);
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.user.create.mockResolvedValue(UserFactory.create({ oauthId: 'oauth-id' }));
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile: OAuthProfileFactory.create() });
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foobar' },
        {},
        loginDetails,
      );

      expect(mocks.user.getByEmail).toHaveBeenCalledTimes(2); // second call is for domain check before create
      expect(mocks.user.create).toHaveBeenCalledTimes(1);
    });

    it('should throw an error if user should be auto registered but the email claim does not exist', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.enabled);
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.user.create.mockResolvedValue(UserFactory.create());
      mocks.session.create.mockResolvedValue(SessionFactory.create());
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile: { sub: 'sub' } });

      await expect(
        sut.callback(
          { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foobar' },
          {},
          loginDetails,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.user.getByEmail).not.toHaveBeenCalled();
      expect(mocks.user.create).not.toHaveBeenCalled();
    });

    for (const url of [
      'app.immich:/oauth-callback?code=abc123',
      'app.immich://oauth-callback?code=abc123',
      'app.immich:///oauth-callback?code=abc123',
    ]) {
      it(`should use the mobile redirect override for a url of ${url}`, async () => {
        mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithMobileOverride);
        mocks.user.getByOAuthId.mockResolvedValue(UserFactory.create());
        mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile: OAuthProfileFactory.create() });
        mocks.session.create.mockResolvedValue(SessionFactory.create());

        await sut.callback({ url, state: 'xyz789', codeVerifier: 'foo' }, {}, loginDetails);

        expect(mocks.oauth.getProfileAndOAuthSid).toHaveBeenCalledWith(
          expect.objectContaining({}),
          'http://mobile-redirect?code=abc123',
          'xyz789',
          'foo',
        );
      });
    }

    for (const url of ['frameleaf-auth:/oauth-callback?code=abc123', 'frameleaf-auth:///oauth-callback?code=abc123']) {
      it(`should use the Frameleaf mobile redirect for a url of ${url} (FL-131)`, async () => {
        mocks.systemMetadata.get.mockResolvedValue(frameleafOverride);
        mocks.user.getByOAuthId.mockResolvedValue(UserFactory.create());
        mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile: OAuthProfileFactory.create() });
        mocks.session.create.mockResolvedValue(SessionFactory.create());

        await sut.callback({ url, state: 'xyz789', codeVerifier: 'foo' }, {}, loginDetails);

        expect(mocks.oauth.getProfileAndOAuthSid).toHaveBeenCalledWith(
          expect.objectContaining({}),
          'https://photos.example.test/immich/api/oauth/frameleaf-mobile-redirect?code=abc123',
          'xyz789',
          'foo',
        );
      });
    }

    it('refuses a Frameleaf callback when the override is not a mobile-redirect address (FL-131)', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithMobileOverride);

      await expect(
        sut.callback(
          { url: 'frameleaf-auth:///oauth-callback?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
          {},
          loginDetails,
        ),
      ).rejects.toThrow(/frameleaf-mobile-redirect/);
      expect(mocks.oauth.getProfileAndOAuthSid).not.toHaveBeenCalled();
    });

    it('should use the default quota', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithStorageQuota);
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile: OAuthProfileFactory.create() });
      mocks.user.create.mockResolvedValue(UserFactory.create({ oauthId: 'oauth-id' }));
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ quotaSizeInBytes: 1_073_741_824 }));
    });

    it('should infer name from given and family names', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.enabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ name: undefined, given_name: 'Given', family_name: 'Family' }),
      });
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.user.create.mockResolvedValue(UserFactory.create());
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Given Family' }));
    });

    it('should fallback to email when no username is provided', async () => {
      const profile = OAuthProfileFactory.create({ name: undefined, given_name: undefined, family_name: undefined });

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.enabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile });
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.user.create.mockResolvedValue(UserFactory.create());
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ name: profile.email }));
    });

    it('should ignore an invalid storage quota', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithStorageQuota);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ immich_quota: 'abc' }),
      });
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.create.mockResolvedValue(UserFactory.create({ oauthId: 'oauth-id' }));
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ quotaSizeInBytes: 1_073_741_824 }));
    });

    it('should ignore a negative quota', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithStorageQuota);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ immich_quota: -5 }),
      });
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.create.mockResolvedValue(UserFactory.create({ oauthId: 'oauth-id' }));
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ quotaSizeInBytes: 1_073_741_824 }));
    });

    it('should set quota for 0 quota', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithStorageQuota);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile: OAuthProfileFactory.create({ immich_quota: 0 }) });
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.create.mockResolvedValue(UserFactory.create({ oauthId: 'oauth-id' }));
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ quotaSizeInBytes: 0 }));
    });

    it('should use a valid storage quota', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithStorageQuota);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile: OAuthProfileFactory.create({ immich_quota: 5 }) });
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.user.getByOAuthId.mockResolvedValue(void 0);
      mocks.user.create.mockResolvedValue(UserFactory.create({ oauthId: 'oauth-id' }));
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ quotaSizeInBytes: 5_368_709_120 }));
    });

    it('should sync the profile picture', async () => {
      const fileId = newUuid();
      const user = UserFactory.create({ oauthId: 'oauth-id' });
      const profile = OAuthProfileFactory.create({ picture: 'https://auth.immich.cloud/profiles/1.jpg' });
      const pictureBytes = new Uint8Array([1, 2, 3, 4, 5]);

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile });
      mocks.user.getByOAuthId.mockResolvedValue(user);
      mocks.crypto.randomUUID.mockReturnValue(fileId);
      mocks.oauth.getProfilePicture.mockResolvedValue(pictureBytes.buffer);
      mocks.user.update.mockResolvedValue(user);
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.update).toHaveBeenCalledWith(user.id, {
        profileImagePath: expect.stringContaining(`/data/profile/${user.id}/${fileId}.webp`),
        profileImageAssetId: null,
        profileChangedAt: expect.any(Date),
      });
      expect(mocks.oauth.getProfilePicture).toHaveBeenCalledWith(profile.picture);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        Buffer.from(pictureBytes.buffer, pictureBytes.byteOffset, pictureBytes.byteLength),
        expect.objectContaining({ format: 'webp', processInvalidImages: false }),
        expect.stringContaining(`/data/profile/${user.id}/${fileId}.webp`),
      );
    });

    it('should not update the user when thumbnail processing fails on the OAuth picture', async () => {
      const user = UserFactory.create({ oauthId: 'oauth-id' });
      const profile = OAuthProfileFactory.create({ picture: 'https://auth.immich.cloud/profiles/1.jpg' });

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile });
      mocks.user.getByOAuthId.mockResolvedValue(user);
      mocks.oauth.getProfilePicture.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5]).buffer);
      mocks.media.generateThumbnail.mockRejectedValue(new Error('not an image'));
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await expect(
        sut.callback(
          { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
          {},
          loginDetails,
        ),
      ).resolves.toBeDefined();

      expect(mocks.user.update).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should not sync the profile picture if the user already has one', async () => {
      const oauthId = 'oauth-id';
      const user = UserFactory.create({ oauthId, profileImagePath: 'not-empty' });

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({
          sub: oauthId,
          email: user.email,
          picture: 'https://auth.immich.cloud/profiles/1.jpg',
        }),
      });
      mocks.user.getByOAuthId.mockResolvedValue(user);
      mocks.user.update.mockResolvedValue(user);
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.update).not.toHaveBeenCalled();
      expect(mocks.oauth.getProfilePicture).not.toHaveBeenCalled();
    });

    it('should only allow "admin" and "user" for the role claim', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithAutoRegister);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ immich_role: 'foo' }),
      });
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.user.getByOAuthId.mockResolvedValue(void 0);
      mocks.user.create.mockResolvedValue(UserFactory.create({ oauthId: 'oauth-id' }));
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: false }));
    });

    it('should create an admin user if the role claim is set to admin', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithAutoRegister);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ immich_role: 'admin' }),
      });
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getByOAuthId.mockResolvedValue(void 0);
      mocks.user.create.mockResolvedValue(UserFactory.create({ oauthId: 'oauth-id' }));
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: true }));
    });

    it('should accept a custom role claim', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        oauth: { ...systemConfigStub.oauthWithAutoRegister.oauth, roleClaim: 'my_role' },
      });
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ my_role: 'admin' }),
      });
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getByOAuthId.mockResolvedValue(void 0);
      mocks.user.create.mockResolvedValue(UserFactory.create({ oauthId: 'oauth-id' }));
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: true }));
    });

    it('should create an admin user if the role claim is an array containing admin', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithAutoRegister);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ immich_role: ['user', 'admin'] }),
      });
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getByOAuthId.mockResolvedValue(void 0);
      mocks.user.create.mockResolvedValue(UserFactory.create({ oauthId: 'oauth-id' }));
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: true }));
    });

    it('should create a standard user if the role claim is an array containing only user', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthWithAutoRegister);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ immich_role: ['user'] }),
      });
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getByOAuthId.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.user.create.mockResolvedValue(UserFactory.create({ oauthId: 'oauth-id' }));
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: false }));
    });

    it('should promote an existing user to admin if the role claim contains admin on login', async () => {
      const oauthId = 'oauth-id';
      const user = UserFactory.create({ isAdmin: false, oauthId });

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ sub: oauthId, immich_role: 'admin' }),
      });
      mocks.user.getByOAuthId.mockResolvedValue(user);
      mocks.user.update.mockResolvedValue({ ...user, isAdmin: true });
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.update).toHaveBeenCalledWith(user.id, { isAdmin: true });
    });

    it('should demote an existing admin if the role claim only contains user on login', async () => {
      const oauthId = 'oauth-id';
      const user = UserFactory.create({ isAdmin: true, oauthId });

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ sub: oauthId, immich_role: ['user'] }),
      });
      mocks.user.getByOAuthId.mockResolvedValue(user);
      mocks.user.update.mockResolvedValue({ ...user, isAdmin: false });
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.update).toHaveBeenCalledWith(user.id, { isAdmin: false });
    });

    it('should not change isAdmin for an existing user if the role claim is blank', async () => {
      const oauthId = 'oauth-id';
      const user = UserFactory.create({ isAdmin: true, oauthId });

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: OAuthProfileFactory.create({ sub: oauthId }),
      });
      mocks.user.getByOAuthId.mockResolvedValue(user);
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
        loginDetails,
      );

      expect(mocks.user.update).not.toHaveBeenCalled();
    });

    it('should re-evaluate the role claim for a user linked by email', async () => {
      const user = UserFactory.create({ isAdmin: false });
      const profile = OAuthProfileFactory.create({ immich_role: 'admin' });

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.oauthEnabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile });
      mocks.user.getByEmail.mockResolvedValue(user);
      mocks.user.update.mockResolvedValueOnce({ ...user, oauthId: profile.sub });
      mocks.user.update.mockResolvedValueOnce({ ...user, oauthId: profile.sub, isAdmin: true });
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.callback(
        { url: 'http://immich/auth/login?code=abc123', state: 'xyz789', codeVerifier: 'foobar' },
        {},
        loginDetails,
      );

      expect(mocks.user.update).toHaveBeenCalledWith(user.id, { oauthId: profile.sub });
      expect(mocks.user.update).toHaveBeenCalledWith(user.id, { isAdmin: true });
    });
  });

  describe('link', () => {
    it('should link an account', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.from(user).apiKey({ permissions: [] }).build();
      const profile = OAuthProfileFactory.create();

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.enabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile });
      mocks.user.update.mockResolvedValue(user);

      await sut.link(
        auth,
        { url: 'http://immich/user-settings?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
      );

      expect(mocks.user.update).toHaveBeenCalledWith(auth.user.id, { oauthId: profile.sub });
    });

    it('should link an account and update the session with the oauthSid', async () => {
      const user = UserFactory.create();
      const session = SessionFactory.create();
      const auth = AuthFactory.from(user).session(session).build();

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.enabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({
        profile: { sub: 'sub' },
        sid: session.oauthSid ?? undefined,
        idToken: session.oauthBearerToken ?? undefined,
      });
      mocks.user.update.mockResolvedValue(user);
      mocks.session.update.mockResolvedValue(session);

      await sut.link(
        auth,
        { url: 'http://immich/user-settings?code=abc123', state: 'xyz789', codeVerifier: 'foo' },
        {},
      );

      expect(mocks.session.update).toHaveBeenCalledWith(session.id, {
        oauthSid: session.oauthSid,
        oauthBearerToken: session.oauthBearerToken,
      });
      expect(mocks.user.update).toHaveBeenCalledWith(auth.user.id, { oauthId: 'sub' });
    });

    it('should not link an already linked oauth.sub', async () => {
      const authUser = UserFactory.create();
      const authApiKey = ApiKeyFactory.create({ permissions: [] });
      const auth = { user: authUser, apiKey: authApiKey };

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.enabled);
      mocks.oauth.getProfileAndOAuthSid.mockResolvedValue({ profile: OAuthProfileFactory.create() });
      mocks.user.getByOAuthId.mockResolvedValue({ id: 'other-user' } as UserAdmin);

      await expect(
        sut.link(auth, { url: 'http://immich/user-settings?code=abc123', state: 'xyz789', codeVerifier: 'foo' }, {}),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.user.update).not.toHaveBeenCalled();
    });
  });

  describe('unlink', () => {
    it('should unlink an account', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.from(user).apiKey({ permissions: [] }).build();

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.enabled);
      mocks.user.update.mockResolvedValue(user);

      await sut.unlink(auth);

      expect(mocks.user.update).toHaveBeenCalledWith(auth.user.id, { oauthId: null });
    });

    it('should unlink an account and remove the OAuth data from the session', async () => {
      const user = UserFactory.create();
      const session = SessionFactory.create();
      const auth = AuthFactory.from(user).session(session).build();

      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.enabled);
      mocks.session.update.mockResolvedValue(session);
      mocks.user.update.mockResolvedValue(user);

      await sut.unlink(auth);

      expect(mocks.session.update).toHaveBeenCalledWith(session.id, { oauthSid: null, oauthBearerToken: null });
      expect(mocks.user.update).toHaveBeenCalledWith(auth.user.id, { oauthId: null });
    });
  });

  describe('setupPinCode', () => {
    it('should setup a PIN code', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.create(user);
      const dto = { pinCode: '123456' };

      mocks.user.getForPinCode.mockResolvedValue({ pinCode: null, password: '' });
      mocks.user.update.mockResolvedValue(user);

      await sut.setupPinCode(auth, dto);

      expect(mocks.user.getForPinCode).toHaveBeenCalledWith(user.id);
      expect(mocks.crypto.hashBcrypt).toHaveBeenCalledWith('123456', SALT_ROUNDS);
      expect(mocks.user.update).toHaveBeenCalledWith(user.id, { pinCode: expect.any(String) });
    });

    it('should fail if the user already has a PIN code', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.create(user);

      mocks.user.getForPinCode.mockResolvedValue({ pinCode: '123456 (hashed)', password: '' });

      await expect(sut.setupPinCode(auth, { pinCode: '123456' })).rejects.toThrow('User already has a PIN code');
    });
  });

  describe('unlockSession', () => {
    it('should unlock the session for sixty minutes', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
      const user = UserFactory.create();
      const auth = AuthFactory.from(user).session().build();

      mocks.user.getForPinCode.mockResolvedValue({ pinCode: '123456 (hashed)', password: '' });
      mocks.crypto.compareBcrypt.mockImplementation((a, b) => `${a} (hashed)` === b);
      mocks.session.elevate.mockResolvedValue(true);

      await sut.unlockSession(auth, { pinCode: '123456' });

      // conditional on the credentials the check read (FL-34)
      expect(mocks.session.elevate).toHaveBeenCalledWith(
        auth.session!.id,
        user.id,
        { pinCode: '123456 (hashed)', password: '' },
        new Date('2026-05-08T13:00:00.000Z'),
      );
      vi.useRealTimers();
    });

    it('does not elevate when the PIN or password changed after the check (FL-34)', async () => {
      const auth = AuthFactory.from().session().build();
      mocks.user.getForPinCode.mockResolvedValue({ pinCode: '123456 (hashed)', password: '' });
      mocks.crypto.compareBcrypt.mockImplementation((a, b) => `${a} (hashed)` === b);
      mocks.session.elevate.mockResolvedValue(false);

      await expect(sut.unlockSession(auth, { pinCode: '123456' })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.session.update).not.toHaveBeenCalled();
    });

    it('should throttle repeated PIN failures and reset the count after a successful unlock', async () => {
      vi.useFakeTimers();
      const auth = AuthFactory.from().session().build();
      mocks.user.getForPinCode.mockResolvedValue({ pinCode: '123456 (hashed)', password: '' });
      mocks.crypto.compareBcrypt.mockImplementation((a, b) => `${a} (hashed)` === b);
      mocks.session.elevate.mockResolvedValue(true);

      for (let attempt = 0; attempt < 5; attempt++) {
        await expect(sut.unlockSession(auth, { pinCode: '000000' })).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(sut.unlockSession(auth, { pinCode: '123456' })).rejects.toThrow('Too many failed PIN attempts');
      expect(mocks.user.getForPinCode).toHaveBeenCalledTimes(5);
      expect(mocks.session.elevate).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_001);
      await sut.unlockSession(auth, { pinCode: '123456' });
      await expect(sut.unlockSession(auth, { pinCode: '000000' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.unlockSession(auth, { pinCode: '123456' })).resolves.toBeUndefined();
    });

    it('should reject unlock without a session token', async () => {
      const user = UserFactory.create();

      await expect(sut.unlockSession(AuthFactory.create(user), { pinCode: '123456' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('lockSession', () => {
    it('does not announce a lock before it is persisted', async () => {
      const auth = AuthFactory.from().session().build();
      mocks.session.update.mockRejectedValue(new Error('write failed'));

      await expect(sut.lockSession(auth)).rejects.toThrow('write failed');

      expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
    });

    it('should clear elevated access immediately', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.from(user).session({ hasElevatedPermission: true }).build();
      mocks.session.update.mockResolvedValue(SessionFactory.create());

      await sut.lockSession(auth);

      expect(mocks.session.update).toHaveBeenCalledWith(auth.session!.id, { pinExpiresAt: null });
      // only this session's other tabs are told (FL-34)
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_session_lock', auth.session!.id);
    });
  });

  describe('changePinCode', () => {
    it('should change the PIN code', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.create(user);
      const dto = { pinCode: '123456', newPinCode: '012345' };

      mocks.user.getForPinCode.mockResolvedValue({ pinCode: '123456 (hashed)', password: '' });
      mocks.user.update.mockResolvedValue(user);
      mocks.crypto.compareBcrypt.mockImplementation((a, b) => `${a} (hashed)` === b);
      mocks.session.lockAll.mockResolvedValue();

      await sut.changePinCode(auth, dto);

      expect(mocks.crypto.compareBcrypt).toHaveBeenCalledWith('123456', '123456 (hashed)');
      expect(mocks.user.update).toHaveBeenCalledWith(user.id, { pinCode: '012345 (hashed)' });
      // an elevation granted by the old PIN ends with it, in every session (FL-34)
      expect(mocks.session.lockAll).toHaveBeenCalledWith(user.id);
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_session_lock', user.id);
    });

    it('should fail if the PIN code does not match', async () => {
      const user = UserFactory.create();
      mocks.user.getForPinCode.mockResolvedValue({ pinCode: '123456 (hashed)', password: '' });
      mocks.crypto.compareBcrypt.mockImplementation((a, b) => `${a} (hashed)` === b);

      await expect(
        sut.changePinCode(AuthFactory.create(user), { pinCode: '000000', newPinCode: '012345' }),
      ).rejects.toThrow('Wrong PIN code');
    });
  });

  describe('resetPinCode', () => {
    it('should reset the PIN code', async () => {
      const currentSession = SessionFactory.create();
      const user = UserFactory.create();
      mocks.user.getForPinCode.mockResolvedValue({ pinCode: '123456 (hashed)', password: '' });
      mocks.crypto.compareBcrypt.mockImplementation((a, b) => `${a} (hashed)` === b);
      mocks.session.lockAll.mockResolvedValue(void 0);
      mocks.session.update.mockResolvedValue(currentSession);

      await sut.resetPinCode(AuthFactory.create(user), { pinCode: '123456' });

      expect(mocks.user.update).toHaveBeenCalledWith(user.id, { pinCode: null });
      expect(mocks.session.lockAll).toHaveBeenCalledWith(user.id);
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_session_lock', user.id);
    });

    it('should throw if the PIN code does not match', async () => {
      const user = UserFactory.create();
      mocks.user.getForPinCode.mockResolvedValue({ pinCode: '123456 (hashed)', password: '' });
      mocks.crypto.compareBcrypt.mockImplementation((a, b) => `${a} (hashed)` === b);

      await expect(sut.resetPinCode(AuthFactory.create(user), { pinCode: '000000' })).rejects.toThrow('Wrong PIN code');
    });
  });

  describe('remote access (FL-161)', () => {
    const user = UserFactory.create();
    const sessionRow = () => ({
      id: 'session-1',
      updatedAt: new Date(),
      user,
      pinExpiresAt: null,
      appVersion: null,
      oauthSid: null,
    });
    const sessionRequest = (via: 'lan' | 'wan' | 'relay' | null) => ({
      headers: { authorization: 'Bearer auth_token' },
      queryParams: {},
      metadata: { adminRoute: false, sharedLinkRoute: false, uri: '/api/assets', via },
    });
    const allowPassword = () =>
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(
          (key === SystemMetadataKey.SystemConfig
            ? { frameleafCloud: { remoteAccess: { allowOriginalsOverRelay: false, allowPasswordOverRelay: true } } }
            : null) as never,
        ),
      );
    const refusedWith = async (promise: Promise<unknown>, code: string) => {
      const error = await promise.then(
        () => null,
        (error_: unknown) => error_,
      );
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({ code, statusCode: 403 });
    };
    const signInRequired = (promise: Promise<unknown>) => refusedWith(promise, 'frameleaf_sign_in_required');

    describe('authenticate', () => {
      it.each([null, 'lan'] as const)('never checks a request that arrived %s', async (via) => {
        mocks.session.getByToken.mockResolvedValue(sessionRow());

        await expect(sut.authenticate(sessionRequest(via))).resolves.toMatchObject({ user });
        expect(mocks.frameleafAccount.getSession).not.toHaveBeenCalled();
        expect(mocks.frameleafAccount.getLinkByUser).not.toHaveBeenCalled();
      });

      it.each(['wan', 'relay'] as const)('accepts a Frameleaf session arriving %s', async (via) => {
        mocks.session.getByToken.mockResolvedValue(sessionRow());
        mocks.frameleafAccount.getSession.mockResolvedValue({ sessionId: 'session-1', sub: 'fl-sub' } as never);

        await expect(sut.authenticate(sessionRequest(via))).resolves.toMatchObject({ user });
        expect(mocks.frameleafAccount.getSession).toHaveBeenCalledWith('session-1');
      });

      it.each(['wan', 'relay'] as const)('refuses a password session arriving %s', async (via) => {
        mocks.session.getByToken.mockResolvedValue(sessionRow());
        mocks.frameleafAccount.getSession.mockResolvedValue(undefined);
        mocks.systemMetadata.get.mockResolvedValue(null as never);

        await signInRequired(sut.authenticate(sessionRequest(via)));
      });

      it('accepts a password session over the relay when an administrator allowed passwords there', async () => {
        mocks.session.getByToken.mockResolvedValue(sessionRow());
        mocks.frameleafAccount.getSession.mockResolvedValue(undefined);
        allowPassword();

        await expect(sut.authenticate(sessionRequest('relay'))).resolves.toMatchObject({ user });
      });

      it.each(['wan', 'relay'] as const)('lets a public shared link through %s', async (via) => {
        mocks.sharedLink.getByKey.mockResolvedValue({ ...sharedLinkStub.valid, user } as any);

        await expect(
          sut.authenticate({
            headers: { 'x-immich-share-key': 'key' },
            queryParams: {},
            metadata: { adminRoute: false, sharedLinkRoute: true, uri: '/api/assets', via },
          }),
        ).resolves.toMatchObject({ sharedLink: expect.anything() });
        expect(mocks.frameleafAccount.getSession).not.toHaveBeenCalled();
      });

      it.each(['wan', 'relay'] as const)(
        'accepts an API key %s only when its owner is linked to a Frameleaf account',
        async (via) => {
          const apiKey = ApiKeyFactory.from({ permissions: [Permission.All] })
            .user(user)
            .build();
          mocks.apiKey.getKey.mockResolvedValue(apiKey);
          const request = {
            headers: { 'x-api-key': 'auth_token' },
            queryParams: {},
            metadata: { adminRoute: false, sharedLinkRoute: false, uri: '/api/assets', via },
          };

          mocks.frameleafAccount.getLinkByUser.mockResolvedValueOnce(undefined);
          await signInRequired(sut.authenticate(request));

          mocks.frameleafAccount.getLinkByUser.mockResolvedValueOnce({ userId: user.id, sub: 'fl-sub' } as never);
          await expect(sut.authenticate(request)).resolves.toMatchObject({ user, apiKey: expect.anything() });
          expect(mocks.frameleafAccount.getLinkByUser).toHaveBeenCalledWith(user.id);
        },
      );

      it('does not let an allowed password open API keys of unlinked owners', async () => {
        const apiKey = ApiKeyFactory.from({ permissions: [Permission.All] })
          .user(user)
          .build();
        mocks.apiKey.getKey.mockResolvedValue(apiKey);
        mocks.frameleafAccount.getLinkByUser.mockResolvedValue(undefined);
        allowPassword();

        await signInRequired(
          sut.authenticate({
            headers: { 'x-api-key': 'auth_token' },
            queryParams: {},
            metadata: { adminRoute: false, sharedLinkRoute: false, uri: '/api/assets', via: 'relay' },
          }),
        );
      });
    });

    describe('login', () => {
      it.each(['wan', 'relay'] as const)('refuses a password %s before looking anyone up', async (via) => {
        mocks.systemMetadata.get.mockResolvedValue(null as never);

        await signInRequired(sut.login(dto, { ...loginDetails, via }));
        expect(mocks.user.getByEmail).not.toHaveBeenCalled();
        expect(mocks.crypto.compareBcrypt).not.toHaveBeenCalled();
      });

      it('accepts a password over the relay when an administrator allowed it', async () => {
        const passwordUser = UserFactory.create({ password: 'immich_password' });
        mocks.user.getByEmail.mockResolvedValue(passwordUser);
        mocks.session.create.mockResolvedValue(SessionFactory.create());
        allowPassword();

        await expect(sut.login(dto, { ...loginDetails, via: 'relay' })).resolves.toMatchObject({
          userId: passwordUser.id,
        });
      });

      it.each([null, 'lan'] as const)('keeps password sign-in %s as it was', async (via) => {
        const passwordUser = UserFactory.create({ password: 'immich_password' });
        mocks.user.getByEmail.mockResolvedValue(passwordUser);
        mocks.session.create.mockResolvedValue(SessionFactory.create());

        await expect(sut.login(dto, { ...loginDetails, via })).resolves.toMatchObject({ userId: passwordUser.id });
      });
    });

    describe('requireOriginalTransfer', () => {
      it.each([null, undefined, 'lan', 'wan'] as const)('never refuses a transfer that arrived %s', async (via) => {
        await expect(sut.requireOriginalTransfer(via, '/api/assets/1/original')).resolves.toBeUndefined();
        expect(mocks.systemMetadata.get).not.toHaveBeenCalled();
      });

      it('refuses originals, archives and backups over the relay by default', async () => {
        mocks.systemMetadata.get.mockResolvedValue(null as never);

        await refusedWith(
          sut.requireOriginalTransfer('relay', '/api/download/archive'),
          'frameleaf_relay_originals_refused',
        );
      });

      it('allows them over the relay once an administrator did', async () => {
        mocks.systemMetadata.get.mockResolvedValue({
          frameleafCloud: { remoteAccess: { allowOriginalsOverRelay: true, allowPasswordOverRelay: false } },
        } as never);

        await expect(sut.requireOriginalTransfer('relay', '/api/download/archive')).resolves.toBeUndefined();
      });
    });

    describe('authenticateWebsocket', () => {
      const secret = 'edge-secret-0123456789abcdef';

      beforeEach(() => {
        mocks.config.getEnv.mockReturnValue({
          ...mocks.config.getEnv(),
          frameleafCloud: {
            ...mocks.config.getEnv().frameleafCloud,
            url: 'https://api.frameleaf.cloud',
            edge: { ...mocks.config.getEnv().frameleafCloud.edge, secret },
          },
        });
        mocks.systemMetadata.get.mockImplementation((key) =>
          Promise.resolve(
            (key === SystemMetadataKey.FrameleafCloudLink
              ? {
                  status: 'linked',
                  cloudUrl: 'https://api.frameleaf.cloud',
                  instanceId: 'instance-1',
                  services: { relayOrigin: 'https://r.k3v9.frameleaf-direct.net' },
                }
              : null) as never,
          ),
        );
        mocks.session.getByToken.mockResolvedValue(sessionRow());
        mocks.frameleafAccount.getSession.mockResolvedValue({ sessionId: 'session-1', sub: 'fl-sub' } as never);
      });

      it('refuses a page from another origin before reading the session', async () => {
        await expect(
          sut.authenticateWebsocket({
            host: '192.168.1.10:2283',
            origin: 'https://evil.example',
            authorization: 'Bearer auth_token',
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(mocks.session.getByToken).not.toHaveBeenCalled();
      });

      it('accepts the same origin and the published relay name', async () => {
        await expect(
          sut.authenticateWebsocket({
            host: '192.168.1.10:2283',
            origin: 'http://192.168.1.10:2283',
            authorization: 'Bearer auth_token',
          }),
        ).resolves.toMatchObject({ auth: { user }, via: null });

        await expect(
          sut.authenticateWebsocket({
            host: '127.0.0.1:2283',
            origin: 'https://r.k3v9.frameleaf-direct.net',
            authorization: 'Bearer auth_token',
            'x-frameleaf-via': 'relay',
            'x-frameleaf-via-auth': secret,
          }),
        ).resolves.toMatchObject({ auth: { user }, via: 'relay' });
        expect(mocks.frameleafAccount.getSession).toHaveBeenCalledWith('session-1');
      });

      it('applies the remote rule to a relayed handshake', async () => {
        mocks.frameleafAccount.getSession.mockResolvedValue(undefined);

        await signInRequired(
          sut.authenticateWebsocket({
            host: '127.0.0.1:2283',
            origin: 'https://r.k3v9.frameleaf-direct.net',
            authorization: 'Bearer auth_token',
            'x-frameleaf-via': 'relay',
            'x-frameleaf-via-auth': secret,
          }),
        );
      });

      it('ignores a via header without the edge secret', async () => {
        await expect(
          sut.authenticateWebsocket({
            authorization: 'Bearer auth_token',
            'x-frameleaf-via': 'relay',
            'x-frameleaf-via-auth': 'guess',
          }),
        ).resolves.toMatchObject({ via: null });
        expect(mocks.frameleafAccount.getSession).not.toHaveBeenCalled();
      });

      it('leaves a handshake without an origin (an app) to authentication', async () => {
        await expect(sut.authenticateWebsocket({ authorization: 'Bearer auth_token' })).resolves.toMatchObject({
          auth: { user },
        });
      });
    });
  });
});
