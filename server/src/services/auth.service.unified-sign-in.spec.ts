import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { SystemMetadataKey } from 'src/enum.js';
import { AuthService } from 'src/services/auth.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { totpCode, totpStep } from 'src/utils/two-factor.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { SessionFactory } from 'test/factories/session.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const details = { isSecure: true, clientIp: '127.0.0.1', deviceOS: '', deviceType: '', appVersion: null };
const capable = { ...details, capabilities: ['verification'] };
const PASSWORD_HASH = 'bcrypt-hash';

type Via = 'relay' | 'wan' | null;
type Record_ = { source: 'local' | 'frameleaf'; methods: string[]; level: 'basic' | 'verified'; legacy: boolean };

/** Unified sign-in (spec 2026-11-11), server rule: what each kind of session may do, at home and away. */
describe('AuthService unified sign-in rule', () => {
  let sut: AuthService;
  let mocks: ServiceMocks;
  const user = UserFactory.create({ password: PASSWORD_HASH });
  const admin = UserFactory.create({ isAdmin: true, password: PASSWORD_HASH });
  let secret: string;
  let sealed: string;
  let signIn: Record_ | null = null;
  let who = user;

  const row = () => ({
    id: 'session-1',
    updatedAt: new Date(),
    user: who,
    pinExpiresAt: null,
    appVersion: null,
    oauthSid: null,
    signIn,
  });
  const request = (via: Via, adminRoute = false) => ({
    headers: { authorization: 'Bearer auth_token' },
    queryParams: {},
    metadata: { adminRoute, sharedLinkRoute: false, uri: '/api/x', via },
  });
  const config = (overrides: object = {}) => {
    clearConfigCache();
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve((key === SystemMetadataKey.SystemConfig ? overrides : null) as never),
    );
  };
  const enrol = () =>
    mocks.user.getTwoFactor.mockResolvedValue({
      userId: user.id,
      secret: sealed,
      enabledAt: new Date('2026-11-01T00:00:00Z'),
      pendingSecret: null,
    });
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(ForbiddenException);
    return (error as ForbiddenException).getResponse() as Record<string, unknown>;
  };

  beforeEach(async () => {
    ({ sut, mocks } = newTestService(AuthService));
    signIn = null;
    who = user;
    mocks.crypto.compareBcrypt.mockImplementation((value) => Promise.resolve(value === 'password'));
    mocks.user.getForChangePassword.mockResolvedValue({ id: user.id, password: PASSWORD_HASH });
    mocks.user.getByEmail.mockResolvedValue(user);
    mocks.user.get.mockResolvedValue(user);
    mocks.session.create.mockResolvedValue(SessionFactory.create({ userId: user.id }));
    mocks.session.getByToken.mockImplementation(() => Promise.resolve(row() as never));
    mocks.user.setPendingTwoFactor.mockResolvedValue({ userId: user.id });
    ({ secret } = await sut.setupTwoFactor(AuthFactory.create(user), { password: 'password' }));
    sealed = mocks.user.setPendingTwoFactor.mock.calls[0][1];
    mocks.user.getTwoFactor.mockResolvedValue(undefined);
    mocks.user.useTwoFactorStep.mockResolvedValue(true);
    mocks.session.raiseSignIn.mockResolvedValue();
    // the Frameleaf sign-in's live tag (unlinking removes it)
    mocks.frameleafAccount.getSession.mockResolvedValue({ sessionId: 'session-1', sub: 'fl-sub' } as never);
    config();
  });

  describe('away from home', () => {
    const basicFrameleaf = (): Record_ => ({
      source: 'frameleaf',
      methods: ['email_code'],
      level: 'basic',
      legacy: false,
    });

    it('lets a Basic Frameleaf administrator work as a member and refuses administrator routes', async () => {
      who = admin;
      signIn = basicFrameleaf();
      await expect(sut.authenticate(request('relay'))).resolves.toMatchObject({ user: admin });
      const body = await refusal(sut.authenticate(request('relay', true)));
      expect(body).toMatchObject({
        code: 'verification_required',
        statusCode: 403,
        acr: 'urn:frameleaf:acr:verified',
        maxAge: null,
        methods: ['frameleaf'],
        transaction: expect.any(String),
      });
    });

    it('offers the local authenticator too when the person has one, and a right code lifts the session', async () => {
      signIn = basicFrameleaf();
      enrol();
      const body = await refusal(sut.authenticate(request('relay')));
      expect(body.methods).toEqual(['frameleaf', 'totp', 'recovery_code']);

      const auth = AuthFactory.from(user).session({ id: 'session-1' }).build();
      const code = totpCode(secret, totpStep(new Date()));
      await sut.stepUp(auth, { transaction: body.transaction as string, code }, capable);
      expect(mocks.session.raiseSignIn).toHaveBeenCalledWith('session-1', 'totp');
      await expect(sut.stepUp(auth, { transaction: 'forged', code }, capable)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('refuses a wrong code and a transaction from another session', async () => {
      signIn = basicFrameleaf();
      enrol();
      const { transaction } = await refusal(sut.authenticate(request('relay')));
      const auth = AuthFactory.from(user).session({ id: 'session-1' }).build();
      mocks.user.useTwoFactorStep.mockResolvedValue(false);
      await expect(
        sut.stepUp(auth, { transaction: transaction as string, code: '000000' }, capable),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      const other = AuthFactory.from(user).session({ id: 'session-2' }).build();
      await expect(
        sut.stepUp(other, { transaction: transaction as string, code: '123456' }, capable),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.session.raiseSignIn).not.toHaveBeenCalled();
    });

    it('never treats a Cloud passkey as a local one once unlinking removed the tag', async () => {
      who = admin;
      signIn = { source: 'frameleaf', methods: ['passkey'], level: 'verified', legacy: false };
      mocks.frameleafAccount.getSession.mockResolvedValue(undefined);
      expect(await refusal(sut.authenticate(request('relay', true)))).toMatchObject({
        code: 'frameleaf_sign_in_required',
      });
    });

    it('refuses a Frameleaf session whose tag was removed by unlinking', async () => {
      signIn = basicFrameleaf();
      mocks.frameleafAccount.getSession.mockResolvedValue(undefined);
      expect(await refusal(sut.authenticate(request('relay')))).toMatchObject({ code: 'frameleaf_sign_in_required' });
    });

    it('asks a Verified sign-in for nothing, administrator routes included', async () => {
      who = admin;
      signIn = { ...basicFrameleaf(), level: 'verified' };
      await expect(sut.authenticate(request('wan', true))).resolves.toMatchObject({ user: admin });
    });

    it('accepts a passkey session and refuses a password session', async () => {
      signIn = { source: 'local', methods: ['passkey'], level: 'verified', legacy: false };
      await expect(sut.authenticate(request('relay'))).resolves.toMatchObject({ user });
      signIn = { source: 'local', methods: ['pwd'], level: 'basic', legacy: false };
      expect(await refusal(sut.authenticate(request('relay')))).toMatchObject({ code: 'frameleaf_sign_in_required' });
    });

    it('accepts a password away from home only with the authenticator, when the owner allowed passwords', async () => {
      config({ frameleafCloud: { remoteAccess: { allowPasswordOverRelay: true } } });
      signIn = { source: 'local', methods: ['pwd'], level: 'basic', legacy: false };
      expect(await refusal(sut.authenticate(request('relay')))).toMatchObject({ code: 'frameleaf_sign_in_required' });
      signIn = { source: 'local', methods: ['pwd', 'totp'], level: 'verified', legacy: false };
      await expect(sut.authenticate(request('relay'))).resolves.toMatchObject({ user });
      // and the sign-in itself: a capable client's password without an authenticator is refused
      await expect(
        sut.login({ email: user.email, password: 'password' }, { ...capable, via: 'relay' }),
      ).rejects.toMatchObject({
        response: { code: 'frameleaf_sign_in_required' },
      });
    });

    it('asks everyone for Verified under "everyone away from home"', async () => {
      config({ signInPolicy: { require: 'everyone-away' } });
      signIn = basicFrameleaf();
      expect(await refusal(sut.authenticate(request('relay')))).toMatchObject({ code: 'verification_required' });
    });
  });

  describe('at home', () => {
    it('never skips a local authenticator after a Basic Frameleaf sign-in, and asks nothing after a Verified one', async () => {
      enrol();
      signIn = { source: 'frameleaf', methods: ['email_code'], level: 'basic', legacy: false };
      expect(await refusal(sut.authenticate(request(null)))).toMatchObject({ code: 'verification_required' });
      signIn = { source: 'frameleaf', methods: ['email_code', 'totp'], level: 'verified', legacy: false };
      await expect(sut.authenticate(request(null))).resolves.toMatchObject({ user });
    });

    it('keeps a local password or passkey working with no Frameleaf Cloud at all', async () => {
      for (const record of [
        { source: 'local', methods: ['pwd'], level: 'basic', legacy: false },
        { source: 'local', methods: ['passkey'], level: 'verified', legacy: false },
      ] as Record_[]) {
        signIn = record;
        await expect(sut.authenticate(request(null, false))).resolves.toMatchObject({ user });
      }
    });

    it('asks for the authenticator, not setup, under "everyone, everywhere" when the person has one', async () => {
      config({ signInPolicy: { require: 'everyone' } });
      enrol();
      signIn = { source: 'local', methods: ['pwd'], level: 'basic', legacy: false };
      expect(await refusal(sut.authenticate(request(null)))).toMatchObject({
        code: 'verification_required',
        methods: ['totp', 'recovery_code'],
      });
    });

    it('sends a password-only person to authenticator setup under "everyone, everywhere"', async () => {
      config({ signInPolicy: { require: 'everyone' } });
      signIn = { source: 'local', methods: ['pwd'], level: 'basic', legacy: false };
      expect(await refusal(sut.authenticate(request(null)))).toMatchObject({ code: 'two_factor_setup_required' });
    });
  });

  describe('older apps', () => {
    it('judge a session with no record by the owner’s policy once "Apply to older apps too" is on', async () => {
      signIn = null;
      await expect(sut.authenticate(request(null))).resolves.toMatchObject({ user });
      config({ signInPolicy: { require: 'everyone', applyToOlderApps: true } });
      mocks.frameleafAccount.getSession.mockResolvedValue(undefined);
      mocks.passkey.isPasskeySession.mockResolvedValue(false);
      expect(await refusal(sut.authenticate(request(null)))).toMatchObject({ code: 'two_factor_setup_required' });
    });

    it('keep today’s rights until the owner turns on "Apply to older apps too"', async () => {
      who = admin;
      enrol();
      signIn = { source: 'frameleaf', methods: [], level: 'basic', legacy: true };
      await expect(sut.authenticate(request('relay', true))).resolves.toMatchObject({ user: admin });
      config({ signInPolicy: { applyToOlderApps: true } });
      expect(await refusal(sut.authenticate(request('relay', true)))).toMatchObject({ code: 'verification_required' });
    });

    it('record a session from a client without the capability as legacy, and one with it as not', async () => {
      await sut.login({ email: user.email, password: 'password' }, details);
      expect(mocks.session.create).toHaveBeenLastCalledWith(
        expect.anything(),
        PASSWORD_HASH,
        expect.objectContaining({ legacy: true }),
      );
      await sut.login({ email: user.email, password: 'password' }, capable);
      expect(mocks.session.create).toHaveBeenLastCalledWith(
        expect.anything(),
        PASSWORD_HASH,
        expect.objectContaining({ legacy: false }),
      );
    });

    it('get exactly today’s login answer without `steps`: no status, no transaction', async () => {
      const response = await sut.login({ email: user.email, password: 'password' }, details);
      expect(Object.keys(response).toSorted()).toEqual([
        'accessToken',
        'isAdmin',
        'isOnboarded',
        'name',
        'profileImagePath',
        'shouldChangePassword',
        'userEmail',
        'userId',
      ]);
      enrol();
      await expect(sut.login({ email: user.email, password: 'password' }, details)).rejects.toMatchObject({
        status: 403,
        response: { code: 'two_factor_required' },
      });
      const next = await sut.login({ email: user.email, password: 'password', twoFactor: true }, details);
      expect(next).toMatchObject({ twoFactorRequired: true, accessToken: '' });
      expect(next).not.toHaveProperty('status');
    });
  });

  describe('sign in in steps (Contract B)', () => {
    it('answers next with the two-factor token as the transaction, then done', async () => {
      enrol();
      const next = await sut.login({ email: user.email, password: 'password', steps: true }, details);
      expect(next).toMatchObject({
        status: 'next',
        transaction: next.twoFactorToken,
        methods: ['totp', 'recovery_code'],
        accessToken: '',
      });
      const done = await sut.loginTwoFactor(
        { twoFactorToken: next.transaction!, code: totpCode(secret, totpStep(new Date())), steps: true },
        details,
      );
      expect(done.response).toMatchObject({ status: 'done', userId: user.id });
    });

    it('answers done when no second step is needed', async () => {
      const done = await sut.login({ email: user.email, password: 'password', steps: true }, details);
      expect(done).toMatchObject({ status: 'done', userId: user.id });
    });
  });

  describe('confirmed recently', () => {
    const sessionAuth = (record: Record_ & { authTime?: Date }) => {
      const auth = AuthFactory.from(user).session({ id: 'session-1' }).build();
      return { ...auth, session: { ...auth.session!, signIn: record } };
    };
    const password: Record_ = { source: 'local', methods: ['pwd'], level: 'basic', legacy: false };

    it('lets a session that predates the rule through, until "Apply to older apps too"', async () => {
      await expect(
        sut.requireConfirmedRecently(sessionAuth({ ...password, legacy: true }), undefined, details),
      ).resolves.toBeUndefined();
      config({ signInPolicy: { applyToOlderApps: true } });
      expect(
        await refusal(sut.requireConfirmedRecently(sessionAuth({ ...password, legacy: true }), undefined, details)),
      ).toMatchObject({ code: 'confirmation_required' });
    });

    it('accepts a recent Frameleaf or passkey sign-in with nothing more, and a typed password otherwise', async () => {
      const fresh = {
        source: 'frameleaf' as const,
        methods: [],
        level: 'basic' as const,
        legacy: false,
        authTime: new Date(),
      };
      await expect(sut.requireConfirmedRecently(sessionAuth(fresh), undefined, capable)).resolves.toBeUndefined();
      const stale = { ...fresh, authTime: new Date(Date.now() - 11 * 60_000) };
      expect(await refusal(sut.requireConfirmedRecently(sessionAuth(stale), undefined, capable))).toMatchObject({
        code: 'confirmation_required',
      });
      await expect(
        sut.requireConfirmedRecently(sessionAuth(stale), { password: 'password' }, capable),
      ).resolves.toBeUndefined();
      await expect(
        sut.requireConfirmedRecently(sessionAuth(stale), { password: 'wrong' }, capable),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('asks for the authenticator code too when the person has one, and never counts a trusted browser', async () => {
      enrol();
      const trusted = { ...password, methods: ['pwd', 'totp'], level: 'verified' as const, authTime: new Date() };
      expect(
        await refusal(sut.requireConfirmedRecently(sessionAuth(trusted), { password: 'password' }, capable)),
      ).toMatchObject({
        code: 'confirmation_required',
      });
      await sut.requireConfirmedRecently(
        sessionAuth(trusted),
        { password: 'password', code: totpCode(secret, totpStep(new Date())) },
        capable,
      );
    });

    it('asks a session with no record to confirm once "Apply to older apps too" is on', async () => {
      const auth = AuthFactory.from(user).session({ id: 'session-1' }).build();
      await expect(sut.requireConfirmedRecently(auth, undefined, capable)).resolves.toBeUndefined();
      config({ signInPolicy: { applyToOlderApps: true } });
      expect(await refusal(sut.requireConfirmedRecently(auth, undefined, capable))).toMatchObject({
        code: 'confirmation_required',
      });
    });

    it('lets an account with no password set up two-step within 10 minutes of any sign-in', async () => {
      mocks.user.getForChangePassword.mockResolvedValue({ id: user.id, password: '' });
      const oauth = { source: 'local' as const, methods: [], level: 'basic' as const, legacy: false };
      await expect(sut.setupTwoFactor(sessionAuth({ ...oauth, authTime: new Date() }), {})).resolves.toMatchObject({
        secret: expect.any(String),
      });
      expect(
        await refusal(sut.setupTwoFactor(sessionAuth({ ...oauth, authTime: new Date(Date.now() - 11 * 60_000) }), {})),
      ).toMatchObject({ code: 'confirmation_required' });
    });

    it('lets two-step changes skip the password within 10 minutes of a Frameleaf sign-in', async () => {
      const fresh = {
        source: 'frameleaf' as const,
        methods: [],
        level: 'basic' as const,
        legacy: false,
        authTime: new Date(),
      };
      await expect(sut.setupTwoFactor(sessionAuth(fresh), {})).resolves.toMatchObject({ secret: expect.any(String) });
      expect(await refusal(sut.setupTwoFactor(sessionAuth(password), {}))).toMatchObject({
        code: 'confirmation_required',
      });
    });
  });
});
