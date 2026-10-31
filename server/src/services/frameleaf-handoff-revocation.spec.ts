import { UnauthorizedException } from '@nestjs/common';
import { FrameleafAuthService } from 'src/services/frameleaf-auth.service.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { newTestService } from 'test/utils.js';

const details = { isSecure: true, clientIp: '127.0.0.1', deviceOS: '', deviceType: '', appVersion: null };
afterEach(() => vi.useRealTimers());

it.each([
  'parent-session',
  'parent-tag',
  'account-link',
  'changed-subject',
  'revocation',
  'removed-user',
  'session-expiry',
  'code-expiry',
  'proof-error',
] as const)('removes a new handoff session when %s changes before tagging finishes', async (phase) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const now = Date.now();
  const { sut, mocks } = newTestService(FrameleafAuthService);
  const user = UserFactory.create();
  const parent = {
    sessionId: 'parent',
    userId: user.id,
    sub: 'subject',
    sid: 'sid',
    authTime: new Date(now - 60_000),
    createdAt: new Date(now - 1000),
    handoffExpiresAt: new Date(now + 60_000),
  };
  mocks.frameleafAccount.takeHandoff.mockResolvedValue(parent as never);
  mocks.session.get.mockResolvedValue({
    id: 'parent',
    expiresAt: phase === 'session-expiry' ? new Date(now + 10_000) : null,
  } as never);
  mocks.user.get.mockResolvedValue(user);
  mocks.session.create.mockResolvedValue({ id: 'child' } as never);
  mocks.crypto.randomBytesAsText.mockReturnValue('synthetic-child-token');
  mocks.frameleafAccount.getSession.mockResolvedValue(parent as never);
  mocks.frameleafAccount.getLinkByUser.mockResolvedValue({ sub: parent.sub } as never);
  mocks.frameleafAccount.isSignInRevoked.mockResolvedValue(false);
  mocks.session.delete.mockResolvedValue();
  mocks.frameleafAccount.deleteSessions.mockResolvedValue();
  mocks.frameleafAccount.tagSession.mockImplementation(() => {
    switch (phase) {
      case 'parent-session': {
        mocks.session.get.mockResolvedValue(undefined);
        break;
      }
      case 'parent-tag': {
        mocks.frameleafAccount.getSession.mockResolvedValue(undefined);
        break;
      }
      case 'account-link': {
        mocks.frameleafAccount.getLinkByUser.mockResolvedValue(undefined);
        break;
      }
      case 'changed-subject': {
        mocks.frameleafAccount.getLinkByUser.mockResolvedValue({ sub: 'replacement' } as never);
        break;
      }
      case 'revocation': {
        mocks.frameleafAccount.isSignInRevoked.mockResolvedValue(true);
        break;
      }
      case 'removed-user': {
        mocks.user.get.mockResolvedValue(undefined);
        break;
      }
      case 'session-expiry': {
        vi.setSystemTime(now + 10_000);
        break;
      }
      case 'code-expiry': {
        vi.setSystemTime(now + 60_000);
        break;
      }
      case 'proof-error': {
        mocks.frameleafAccount.isSignInRevoked.mockRejectedValue(new Error('proof unavailable'));
        break;
      }
      // No default
    }
    return Promise.resolve();
  });
  const outcome = sut.redeemHandoff({ code: 'synthetic-code' }, details);
  if (phase === 'proof-error') await expect(outcome).rejects.toThrow('proof unavailable');
  else await expect(outcome).rejects.toBeInstanceOf(UnauthorizedException);
  expect(mocks.session.delete).toHaveBeenCalledExactlyOnceWith('child');
  expect(mocks.frameleafAccount.deleteSessions).toHaveBeenCalledWith(['child']);
  expect(mocks.frameleafAccount.isSignInRevoked).toHaveBeenCalledWith({
    sub: parent.sub,
    sid: parent.sid,
    issuedAt: parent.createdAt,
  });
});
