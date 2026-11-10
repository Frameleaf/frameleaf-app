import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AuthChallengePurpose } from 'src/repositories/passkey.repository.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { AccountEventAction, SystemMetadataKey } from 'src/enum.js';
import { PasskeyService } from 'src/services/passkey.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { SessionFactory } from 'test/factories/session.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';
import { SoftPasskey } from 'test/webauthn.js';

const ORIGIN = 'https://photos.example.com';
const PASSWORD_HASH = 'bcrypt-hash';
const details: LoginDetails = {
  isSecure: true,
  clientIp: '203.0.113.9',
  deviceType: 'Chrome',
  deviceOS: 'macOS',
  browserFamily: 'Chrome',
  deviceOSFamily: 'macOS',
  appVersion: null,
};
const headers = (origin = ORIGIN) => ({ origin, host: new URL(origin).host });

type Challenge = {
  purpose: AuthChallengePurpose;
  challenge: string;
  userId?: string | null;
  sessionId?: string | null;
  origin?: string | null;
  rpId?: string | null;
  expiresAt: Date;
};
type Row = {
  id: string;
  userId: string;
  credentialId: Buffer;
  publicKey: Buffer;
  counter: string;
  transports: string[];
  name: string;
  rpId: string;
  aaguid: string | null;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
};

describe(PasskeyService.name, () => {
  let sut: PasskeyService;
  let mocks: ServiceMocks;
  let challenges: Challenge[];
  let passkeys: Row[];
  let sessionLinks: Array<{ sessionId: string; passkeyId: string }>;
  const user = UserFactory.create({ password: PASSWORD_HASH });
  const other = UserFactory.create({ password: PASSWORD_HASH });
  let auth: AuthDto;

  /** An in-memory passkey store, behaving like PasskeyRepository. */
  const fakeRepository = () => {
    const repo = mocks.passkey;
    repo.createChallenge.mockImplementation((challenge) => {
      challenges = challenges.filter(({ expiresAt }) => expiresAt > new Date());
      challenges.push(challenge as Challenge);
      return Promise.resolve();
    });
    repo.takeChallenge.mockImplementation((purpose, value) => {
      const found = challenges.find(
        (row) => row.purpose === purpose && row.challenge === value && row.expiresAt > new Date(),
      );
      challenges = challenges.filter((row) => row !== found);
      return Promise.resolve(
        found
          ? {
              userId: found.userId ?? null,
              sessionId: found.sessionId ?? null,
              origin: found.origin ?? null,
              rpId: found.rpId ?? null,
            }
          : undefined,
      );
    });
    repo.hasPasswordProof.mockImplementation((sessionId) =>
      Promise.resolve(
        challenges.some(
          (row) => row.purpose === 'password-proof' && row.sessionId === sessionId && row.expiresAt > new Date(),
        ),
      ),
    );
    repo.getByUser.mockImplementation((userId) => Promise.resolve(passkeys.filter((row) => row.userId === userId)));
    repo.countByUser.mockImplementation((userId) =>
      Promise.resolve(passkeys.filter((row) => row.userId === userId).length),
    );
    repo.getByCredentialId.mockImplementation((id) =>
      Promise.resolve(passkeys.find((row) => row.credentialId.equals(id))),
    );
    repo.create.mockImplementation((value) => {
      if (passkeys.some((row) => row.credentialId.equals(value.credentialId as Buffer))) {
        return Promise.resolve(undefined);
      }
      const row = {
        id: `0190a0b0-0000-7000-8000-00000000000${passkeys.length}`,
        counter: '0',
        transports: [],
        aaguid: null,
        backedUp: false,
        createdAt: new Date(),
        lastUsedAt: null,
        ...value,
      } as Row;
      passkeys.push(row);
      return Promise.resolve(row as never);
    });
    repo.recordUse.mockImplementation((id, counter, newCounter) => {
      const row = passkeys.find((passkey) => passkey.id === id && passkey.counter === String(counter));
      if (row) {
        row.counter = String(newCounter);
        row.lastUsedAt = new Date();
      }
      return Promise.resolve(!!row);
    });
    repo.delete.mockImplementation((userId, id, keepSessionId) => {
      const row = passkeys.find((passkey) => passkey.id === id && passkey.userId === userId);
      if (!row) {
        return Promise.resolve(undefined);
      }
      passkeys = passkeys.filter((passkey) => passkey !== row);
      const sessionIds = sessionLinks
        .filter((link) => link.passkeyId === id && link.sessionId !== keepSessionId)
        .map(({ sessionId }) => sessionId);
      return Promise.resolve({ name: row.name, count: 1, sessionIds });
    });
    repo.linkSession.mockImplementation((sessionId, passkeyId) => {
      if (passkeys.every((passkey) => passkey.id !== passkeyId)) {
        return Promise.resolve(false);
      }
      sessionLinks.push({ sessionId, passkeyId });
      return Promise.resolve(true);
    });
  };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PasskeyService));
    challenges = [];
    passkeys = [];
    sessionLinks = [];
    auth = AuthFactory.from(user).session().build();
    clearConfigCache();
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve(
        key === SystemMetadataKey.SystemConfig ? ({ server: { externalDomain: ORIGIN } } as never) : null,
      ),
    );
    mocks.crypto.compareBcrypt.mockImplementation((value) => Promise.resolve(value === 'password'));
    mocks.crypto.randomBytesAsText.mockImplementation(() => `random-${Math.random()}`);
    mocks.user.getForChangePassword.mockResolvedValue({ id: user.id, password: PASSWORD_HASH });
    mocks.user.get.mockImplementation((id) =>
      Promise.resolve((id === user.id ? user : id === other.id ? other : undefined) as never),
    );
    mocks.session.create.mockImplementation((dto) =>
      Promise.resolve(SessionFactory.create({ userId: dto.userId }) as never),
    );
    fakeRepository();
  });

  /** Adds a passkey the way the web does: options with the password, then the browser's answer. */
  const addPasskey = async (forAuth = auth, origin = ORIGIN) => {
    const passkey = new SoftPasskey({ origin });
    const { options } = await sut.getRegistrationOptions(forAuth, { password: 'password' }, headers(origin), details);
    const saved = await sut.register(forAuth, { credential: passkey.register(options!) }, details);
    return { passkey, saved };
  };

  const signIn = async (passkey: SoftPasskey, options?: { origin?: string; counter?: number }) => {
    const { options: loginOptions } = await sut.getLoginOptions(headers(), details);
    return sut.login({ credential: passkey.signIn(loginOptions!, options) }, details);
  };

  describe('where passkeys work', () => {
    it('says why not over plain http on a home address, and makes no challenge', async () => {
      await expect(sut.getLoginOptions(headers('http://192.168.1.20:2283'), details)).resolves.toEqual({
        passkeysAvailable: false,
        reason: 'insecure',
        options: null,
      });
      await expect(
        sut.getRegistrationOptions(auth, { password: 'password' }, headers('http://192.168.1.20:2283'), details),
      ).resolves.toMatchObject({ passkeysAvailable: false, reason: 'insecure' });
      expect(mocks.passkey.createChallenge).not.toHaveBeenCalled();
    });

    it('refuses an https address that is not the server’s own', async () => {
      await expect(sut.getLoginOptions(headers('https://photos.evil.test'), details)).resolves.toMatchObject({
        passkeysAvailable: false,
        reason: 'address',
      });
    });

    it('works on localhost and on the external domain', async () => {
      await expect(sut.getLoginOptions(headers('http://localhost:2283'), details)).resolves.toMatchObject({
        passkeysAvailable: true,
        options: { rpId: 'localhost', userVerification: 'required' },
      });
      await expect(sut.getStatus(auth, headers(), true)).resolves.toEqual({
        passkeysAvailable: true,
        hasPasskeys: false,
      });
    });
  });

  describe('secure transport (FL-836 review)', () => {
    it('refuses a plain http request that claims an https origin', async () => {
      await expect(sut.getLoginOptions(headers(), { ...details, isSecure: false })).resolves.toMatchObject({
        passkeysAvailable: false,
        reason: 'insecure',
      });
      await expect(sut.getStatus(auth, headers(), false)).resolves.toMatchObject({ passkeysAvailable: false });
    });

    it('refuses to finish a sign-in over plain http', async () => {
      const { passkey } = await addPasskey();
      const { options } = await sut.getLoginOptions(headers(), details);
      await expect(
        sut.login({ credential: passkey.signIn(options!) }, { ...details, isSecure: false }),
      ).rejects.toMatchObject({ response: { code: 'passkey_insecure' } });
      expect(mocks.session.create).not.toHaveBeenCalled();
    });

    it('still answers the auth status when the server’s addresses can’t be read', async () => {
      mocks.systemMetadata.get.mockRejectedValue(new Error('database busy'));
      clearConfigCache();
      await expect(sut.getStatus(auth, headers(), true)).resolves.toEqual({
        passkeysAvailable: false,
        hasPasskeys: false,
      });
    });
  });

  describe('adding a passkey', () => {
    it('needs a password check, then remembers it in the session for 10 minutes', async () => {
      await expect(sut.getRegistrationOptions(auth, {}, headers(), details)).rejects.toMatchObject({
        status: 403,
        response: { code: 'passkey_password_required' },
      });
      await expect(sut.getRegistrationOptions(auth, { password: 'wrong' }, headers(), details)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      await sut.getRegistrationOptions(auth, { password: 'password' }, headers(), details);
      await expect(sut.getRegistrationOptions(auth, {}, headers(), details)).resolves.toMatchObject({
        passkeysAvailable: true,
      });
      // another session of the same account must check the password itself
      const otherSession = AuthFactory.from(user).session().build();
      await expect(sut.getRegistrationOptions(otherSession, {}, headers(), details)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('counts a Frameleaf sign-in as the check only by when the person signed in, not when the session was made', async () => {
      const old = new Date(Date.now() - 60 * 60 * 1000);
      mocks.frameleafAccount.getSession.mockResolvedValue({
        sessionId: auth.session!.id,
        userId: user.id,
        sid: null,
        sub: 'sub',
        authTime: old,
        createdAt: new Date(),
        handoffCodeHash: null,
        handoffExpiresAt: null,
      });
      await expect(sut.getRegistrationOptions(auth, {}, headers(), details)).rejects.toBeInstanceOf(ForbiddenException);
      mocks.frameleafAccount.getSession.mockResolvedValue({
        sessionId: auth.session!.id,
        userId: user.id,
        sid: null,
        sub: 'sub',
        authTime: new Date(),
        createdAt: new Date(),
        handoffCodeHash: null,
        handoffExpiresAt: null,
      });
      await expect(sut.getRegistrationOptions(auth, {}, headers(), details)).resolves.toMatchObject({
        passkeysAvailable: true,
      });
    });

    it('is refused with an API key', async () => {
      const apiKey = AuthFactory.from(user).apiKey().build();
      await expect(
        sut.getRegistrationOptions(apiKey, { password: 'password' }, headers(), details),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('saves the passkey with a name from the browser, lists the account’s passkeys and records it', async () => {
      const { passkey, saved } = await addPasskey();
      expect(saved).toMatchObject({ name: 'Chrome on Mac', rpId: 'photos.example.com', lastUsedAt: null });
      expect(passkeys[0].credentialId.equals(passkey.credentialId)).toBe(true);
      await expect(sut.getAll(auth)).resolves.toEqual([saved]);
      expect(mocks.accountEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, action: AccountEventAction.PasskeyAdded, subject: 'Chrome on Mac' }),
      );
    });

    it('excludes passkeys already saved, so the browser says it already has one', async () => {
      const { passkey } = await addPasskey();
      const { options } = await sut.getRegistrationOptions(auth, {}, headers(), details);
      expect(options?.excludeCredentials).toEqual([expect.objectContaining({ id: passkey.id })]);
    });

    it('refuses an answer to another session’s challenge, or one used twice', async () => {
      const passkey = new SoftPasskey({ origin: ORIGIN });
      const { options } = await sut.getRegistrationOptions(auth, { password: 'password' }, headers(), details);
      const credential = passkey.register(options!);
      const otherSession = AuthFactory.from(user).session().build();
      await expect(sut.register(otherSession, { credential }, details)).rejects.toBeInstanceOf(BadRequestException);
      // the challenge was taken by that try: it answers only once
      await expect(sut.register(auth, { credential }, details)).rejects.toBeInstanceOf(BadRequestException);
      expect(passkeys).toHaveLength(0);
    });

    it('refuses an answer made at another address or without verifying the person', async () => {
      const elsewhere = new SoftPasskey({ origin: 'https://photos.evil.test' });
      const first = await sut.getRegistrationOptions(auth, { password: 'password' }, headers(), details);
      await expect(sut.register(auth, { credential: elsewhere.register(first.options!) }, details)).rejects.toThrow(
        'didn’t make a passkey',
      );

      const unverified = new SoftPasskey({ origin: ORIGIN, userVerified: false });
      const second = await sut.getRegistrationOptions(auth, {}, headers(), details);
      await expect(sut.register(auth, { credential: unverified.register(second.options!) }, details)).rejects.toThrow(
        'didn’t make a passkey',
      );
      expect(passkeys).toHaveLength(0);
    });
  });

  describe('signing in with a passkey', () => {
    it('signs in, moves the counter on and links the session to the passkey', async () => {
      const { passkey } = await addPasskey();
      const { response } = await signIn(passkey);
      expect(response).toMatchObject({ userId: user.id, accessToken: expect.any(String) });
      expect(passkeys[0].counter).toBe('1');
      expect(passkeys[0].lastUsedAt).toBeInstanceOf(Date);
      expect(sessionLinks).toEqual([{ sessionId: expect.any(String), passkeyId: passkeys[0].id }]);
      expect(mocks.accountEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: AccountEventAction.SignedIn, detail: 'passkey' }),
      );
      expect(mocks.signInSecurity.signedIn).toHaveBeenCalledWith(user, details);
    });

    it('refuses a replayed answer', async () => {
      const { passkey } = await addPasskey();
      const { options } = await sut.getLoginOptions(headers(), details);
      const credential = passkey.signIn(options!);
      await sut.login({ credential }, details);
      await expect(sut.login({ credential }, details)).rejects.toThrow('took too long');
      expect(mocks.session.create).toHaveBeenCalledTimes(1);
    });

    it('refuses a counter that went backwards (a cloned passkey)', async () => {
      const { passkey } = await addPasskey();
      await signIn(passkey, { counter: 5 });
      await expect(signIn(passkey, { counter: 3 })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.accountEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: AccountEventAction.SignInFailed, detail: 'passkey' }),
      );
      expect(mocks.signInSecurity.failed).toHaveBeenCalled();
    });

    it('refuses a passkey that was removed, or one presenting another account’s user handle', async () => {
      const { passkey, saved } = await addPasskey();
      const { passkey: theirs } = await addPasskey(AuthFactory.from(other).session().build());
      theirs.userHandle = passkey.userHandle;
      await expect(signIn(theirs)).rejects.toThrow('isn’t set up for this server');

      await sut.remove(auth, saved.id);
      await expect(signIn(passkey)).rejects.toThrow('isn’t set up for this server');
    });

    it('gives no session when the passkey was removed while the sign-in was checked', async () => {
      const { passkey } = await addPasskey();
      const { options } = await sut.getLoginOptions(headers(), details);
      mocks.passkey.linkSession.mockResolvedValueOnce(false);
      mocks.session.delete.mockResolvedValue();
      await expect(sut.login({ credential: passkey.signIn(options!) }, details)).rejects.toMatchObject({
        response: { code: 'passkey_not_recognised' },
      });
      expect(mocks.session.delete).toHaveBeenCalled();
    });

    it('refuses an answer signed at another address', async () => {
      const { passkey } = await addPasskey();
      await expect(signIn(passkey, { origin: 'https://photos.evil.test' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('is refused when password sign-in is turned off', async () => {
      const { passkey } = await addPasskey();
      const { options } = await sut.getLoginOptions(headers(), details);
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(
          key === SystemMetadataKey.SystemConfig
            ? ({ server: { externalDomain: ORIGIN }, passwordLogin: { enabled: false } } as never)
            : null,
        ),
      );
      clearConfigCache();
      await expect(sut.login({ credential: passkey.signIn(options!) }, details)).rejects.toThrow('turned off');
    });
  });

  describe('renaming and removing', () => {
    it('renames only the account’s own passkeys', async () => {
      const { saved } = await addPasskey();
      mocks.passkey.rename.mockImplementation((userId, id, name) => {
        const row = passkeys.find((passkey) => passkey.id === id && passkey.userId === userId);
        if (row) {
          row.name = name;
        }
        return Promise.resolve(row as never);
      });
      await expect(sut.update(auth, saved.id, { name: '  Work   laptop ' })).resolves.toMatchObject({
        name: 'Work laptop',
      });
      await expect(
        sut.update(AuthFactory.from(other).session().build(), saved.id, { name: 'Mine' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('signs out the sessions a removed passkey started and records it', async () => {
      const { passkey, saved } = await addPasskey();
      await signIn(passkey);
      await sut.remove(auth, saved.id);
      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: sessionLinks[0].sessionId });
      expect(mocks.accountEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: AccountEventAction.PasskeyRemoved, subject: 'Chrome on Mac' }),
      );
      await expect(sut.remove(auth, saved.id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
