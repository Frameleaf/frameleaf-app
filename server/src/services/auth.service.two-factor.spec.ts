import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from 'src/services/auth.service.js';
import { hashRecoveryCode, totpCode, totpStep } from 'src/utils/two-factor.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { SessionFactory } from 'test/factories/session.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const loginDetails = { isSecure: true, clientIp: '127.0.0.1', deviceOS: '', deviceType: '', appVersion: null };
const PASSWORD_HASH = 'bcrypt-hash';

describe('AuthService two-step sign-in (FL-793)', () => {
  let sut: AuthService;
  let mocks: ServiceMocks;
  const user = UserFactory.create({ password: PASSWORD_HASH });
  const enabledAt = new Date('2026-11-01T00:00:00Z');
  let secret: string;
  let sealed: string;

  beforeEach(async () => {
    ({ sut, mocks } = newTestService(AuthService));
    mocks.crypto.compareBcrypt.mockImplementation((value) => Promise.resolve(value === 'password'));
    mocks.user.getForChangePassword.mockResolvedValue({ id: user.id, password: PASSWORD_HASH });
    mocks.user.getByEmail.mockResolvedValue(user);
    mocks.user.get.mockResolvedValue(user);
    mocks.session.create.mockResolvedValue(SessionFactory.create({ userId: user.id }));

    // a real setup, so the stored secret is sealed exactly as the server seals it
    mocks.user.setPendingTwoFactor.mockResolvedValue({ userId: user.id });
    ({ secret } = await sut.setupTwoFactor(AuthFactory.create(user), { password: 'password' }));
    sealed = mocks.user.setPendingTwoFactor.mock.calls[0][1];
    mocks.user.getTwoFactor.mockResolvedValue({ userId: user.id, secret: sealed, enabledAt });
    mocks.user.useTwoFactorStep.mockResolvedValue(true);
  });

  const challenge = async (trustToken?: string) => {
    const response = await sut.login({ email: user.email, password: 'password' }, loginDetails, trustToken);
    expect(response).toMatchObject({ twoFactorRequired: true, accessToken: '' });
    return response.twoFactorToken!;
  };
  const currentCode = () => totpCode(secret, totpStep(new Date()));

  it('asks for a code after the right password and creates no session', async () => {
    await challenge();
    expect(mocks.session.create).not.toHaveBeenCalled();
  });

  it('signs in with the right code, remembering the first step’s rememberMe', async () => {
    const twoFactorToken = await challenge();
    const result = await sut.loginTwoFactor({ twoFactorToken, code: currentCode() }, loginDetails);
    expect(result.response.accessToken).not.toBe('');
    expect(result.rememberMe).toBe(true);
    expect(result.trustToken).toBeUndefined();
    expect(mocks.session.create).toHaveBeenCalledWith(expect.objectContaining({ userId: user.id }), PASSWORD_HASH);
  });

  it('refuses a wrong code and a code already used, with 401 so the rate limit counts it', async () => {
    const twoFactorToken = await challenge();
    const wrong = currentCode() === '000000' ? '111111' : '000000';
    await expect(sut.loginTwoFactor({ twoFactorToken, code: wrong }, loginDetails)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    mocks.user.useTwoFactorStep.mockResolvedValue(false);
    await expect(sut.loginTwoFactor({ twoFactorToken, code: currentCode() }, loginDetails)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(mocks.session.create).not.toHaveBeenCalled();
  });

  it('spends a recovery code', async () => {
    const twoFactorToken = await challenge();
    mocks.user.useRecoveryCode.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await sut.loginTwoFactor({ twoFactorToken, recoveryCode: 'ABCDE-FGHJK' }, loginDetails);
    expect(mocks.user.useRecoveryCode).toHaveBeenCalledWith(user.id, hashRecoveryCode('abcdefghjk'));
    await expect(
      sut.loginTwoFactor({ twoFactorToken, recoveryCode: 'abcde-fghjk' }, loginDetails),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a sign-in whose password changed, that expired, or that was forged', async () => {
    const twoFactorToken = await challenge();
    mocks.user.getForChangePassword.mockResolvedValueOnce({ id: user.id, password: 'new-hash' });
    await expect(sut.loginTwoFactor({ twoFactorToken, code: currentCode() }, loginDetails)).rejects.toThrow(
      'This sign-in expired',
    );

    vi.useFakeTimers({ now: Date.now() + 6 * 60 * 1000, toFake: ['Date'] });
    try {
      await expect(sut.loginTwoFactor({ twoFactorToken, code: currentCode() }, loginDetails)).rejects.toThrow(
        'This sign-in expired',
      );
    } finally {
      vi.useRealTimers();
    }

    await expect(sut.loginTwoFactor({ twoFactorToken: 'not-a-token', code: '123456' }, loginDetails)).rejects.toThrow(
      'This sign-in expired',
    );
  });

  it('skips the code in a trusted browser until two-step sign-in is turned off and on again', async () => {
    const twoFactorToken = await challenge();
    const { trustToken } = await sut.loginTwoFactor(
      { twoFactorToken, code: currentCode(), trustDevice: true },
      loginDetails,
    );
    expect(trustToken).toBeDefined();

    const trusted = await sut.login({ email: user.email, password: 'password' }, loginDetails, trustToken);
    expect(trusted.twoFactorRequired).toBeUndefined();
    expect(trusted.accessToken).not.toBe('');

    mocks.user.getTwoFactor.mockResolvedValue({ userId: user.id, secret: sealed, enabledAt: new Date() });
    await challenge(trustToken);
  });

  it('turns on with a right code and returns ten recovery codes stored as hashes', async () => {
    mocks.user.getTwoFactor.mockResolvedValue({ userId: user.id, secret: sealed, enabledAt: null });
    await expect(sut.enableTwoFactor(AuthFactory.create(user), { code: '000000' })).rejects.toBeInstanceOf(
      currentCode() === '000000' ? Error : BadRequestException,
    );

    mocks.user.enableTwoFactor.mockResolvedValue(true);
    const { recoveryCodes } = await sut.enableTwoFactor(AuthFactory.create(user), { code: currentCode() });
    expect(recoveryCodes).toHaveLength(10);
    const [, step, hashes] = mocks.user.enableTwoFactor.mock.calls[0];
    expect(step).toBe(totpStep(new Date()));
    expect(hashes).toEqual(recoveryCodes.map((code) => hashRecoveryCode(code)));
  });

  it('needs the password to set up and the password plus a code to turn off', async () => {
    await expect(sut.setupTwoFactor(AuthFactory.create(user), { password: 'wrong' })).rejects.toThrow('Wrong password');

    await expect(sut.disableTwoFactor(AuthFactory.create(user), { password: 'password' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mocks.user.deleteTwoFactor).not.toHaveBeenCalled();

    await sut.disableTwoFactor(AuthFactory.create(user), { password: 'password', code: currentCode() });
    expect(mocks.user.deleteTwoFactor).toHaveBeenCalledWith(user.id);
  });

  it('reports two-step sign-in and the recovery codes left in the auth status', async () => {
    mocks.user.getForPinCode.mockResolvedValue({ pinCode: null, password: PASSWORD_HASH });
    mocks.user.countRecoveryCodes.mockResolvedValue(7);
    await expect(sut.getAuthStatus(AuthFactory.create(user))).resolves.toMatchObject({
      twoFactorEnabled: true,
      recoveryCodesRemaining: 7,
    });
  });
});
