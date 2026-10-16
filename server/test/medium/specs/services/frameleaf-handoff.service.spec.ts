import { UnauthorizedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { FrameleafAuthService } from 'src/services/frameleaf-auth.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db.destroy();
});
afterEach(() => vi.restoreAllMocks());

it.each(['logout', 'unlink'] as const)('refuses a child tagged after the %s lookup missed it', async (phase) => {
  const { sut, ctx } = newMediumService(FrameleafAuthService, {
    database: db,
    real: [CryptoRepository, FrameleafAccountRepository, SessionRepository, UserRepository],
    mock: [EventRepository, LoggingRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  const { user } = await ctx.newUser();
  const { result: parent } = await ctx.newSession({ userId: user.id });
  const auth = factory.auth({ session: parent, user: { id: user.id } });
  const repository = ctx.get(FrameleafAccountRepository);
  const sub = `handoff-${randomUUID()}`;
  const sid = randomUUID();
  await repository.upsertLink({
    userId: user.id,
    sub,
    email: user.email,
    emailVerified: true,
    role: 'user',
    autoRegistered: false,
  });
  await repository.tagSession({ sessionId: parent.id, userId: user.id, sub, sid, authTime: null });
  const { code } = await sut.createHandoff(auth);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const tag = repository.tagSession.bind(repository);
  let childId: string | undefined;
  vi.spyOn(repository, 'tagSession').mockImplementation(async (row) => {
    childId = row.sessionId;
    entered.resolve();
    await resume.promise;
    return tag(row);
  });
  const redemption = sut.redeemHandoff(
    { code },
    { isSecure: true, clientIp: '127.0.0.1', deviceOS: '', deviceType: '', appVersion: null },
  );
  const refused = expect(redemption).rejects.toBeInstanceOf(UnauthorizedException);
  try {
    await Promise.race([
      entered.promise,
      refused.then(() => {
        throw new Error('Handoff failed before child tagging');
      }),
    ]);
    if (phase === 'logout') await repository.revokeSignIns({ sub, sid }, new Date(Date.now() + 120_000));
    else await repository.deleteLink(user.id);
    const captured = await repository.findSessions({ sub });
    expect(captured.map((row) => row.sessionId)).toEqual([parent.id]);
    // Parent cleanup has not started yet; only the committed revocation/link state refuses the child.
    resume.resolve();
    await refused;
    expect(await db.selectFrom('session').select('id').where('id', '=', childId!).executeTakeFirst()).toBeUndefined();
    expect(await repository.getSession(childId!)).toBeUndefined();
    expect(await ctx.get(SessionRepository).get(parent.id)).toBeDefined();
  } finally {
    resume.resolve();
    await Promise.allSettled([redemption, refused]);
  }
});
