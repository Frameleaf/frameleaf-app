import { UnauthorizedException } from '@nestjs/common';
import type { CryptoRepository } from 'src/repositories/crypto.repository.js';
import type { SessionRepository } from 'src/repositories/session.repository.js';
import { createSession } from 'src/utils/session.js';
import { UserFactory } from 'test/factories/user.factory.js';

const details = { isSecure: true, clientIp: '127.0.0.1', deviceOS: '', deviceType: '', appVersion: null };
describe('shared session issuance for imported accounts', () => {
  const setup = () => {
    const session = { create: vi.fn().mockResolvedValue({ id: 'destination-session' }) };
    const crypto = {
      randomBytesAsText: vi.fn().mockReturnValue('destination-token'),
      hashSha256: vi.fn().mockReturnValue(Buffer.alloc(32)),
    };
    return {
      session,
      crypto,
      deps: {
        sessionRepository: session as unknown as SessionRepository,
        cryptoRepository: crypto as unknown as CryptoRepository,
      },
    };
  };
  it('refuses a pending claim before creating any token or session', async () => {
    const { deps, session, crypto } = setup();
    const user = Object.assign(UserFactory.create(), { importClaimPending: true });
    await expect(createSession(deps, user, details)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(crypto.randomBytesAsText).not.toHaveBeenCalled();
    expect(session.create).not.toHaveBeenCalled();
  });
  it('preserves ordinary password-bound session issuance', async () => {
    const { deps, session } = setup();
    const user = UserFactory.create();
    await createSession(deps, user, details, {}, 'destination-password-hash');
    expect(session.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.id }),
      'destination-password-hash',
    );
  });
});
