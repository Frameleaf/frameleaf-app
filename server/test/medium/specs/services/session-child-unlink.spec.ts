import { UnauthorizedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { DatabaseLock } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { FrameleafAuthService } from 'src/services/frameleaf-auth.service.js';
import { SessionService } from 'src/services/session.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Unified sign-in: a child session (`POST /sessions`) of a Frameleaf session and unlinking that Frameleaf account
 * share the link authority lock. Whichever runs first, and when they overlap, no child outlives the unlink.
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db.destroy();
});
afterEach(() => vi.restoreAllMocks());

const real = [CryptoRepository, DatabaseRepository, FrameleafAccountRepository, SessionRepository, UserRepository];

const setup = async () => {
  const frameleaf = newMediumService(FrameleafAuthService, {
    database: db,
    real,
    mock: [EventRepository, LoggingRepository, WebsocketRepository],
  });
  frameleaf.ctx.getMock(EventRepository).emit.mockResolvedValue();
  const sessions = newMediumService(SessionService, {
    database: db,
    real,
    mock: [EventRepository, LoggingRepository],
  });
  const { ctx } = frameleaf;
  const { user } = await ctx.newUser();
  const { result: parent } = await ctx.newSession({ userId: user.id });
  const auth = factory.auth({ session: parent, user: { id: user.id } });
  const accounts = ctx.get(FrameleafAccountRepository);
  const sub = `child-${randomUUID()}`;
  await accounts.upsertLink({
    userId: user.id,
    sub,
    email: user.email,
    emailVerified: true,
    role: 'user',
    autoRegistered: false,
  });
  await accounts.tagSession({ sessionId: parent.id, userId: user.id, sub, sid: randomUUID(), authTime: null });
  await db
    .insertInto('session_sign_in')
    .values({ sessionId: parent.id, methods: ['email_code'], level: 'basic', source: 'frameleaf', legacy: false })
    .execute();
  const childSessions = () => db.selectFrom('session').select('id').where('parentId', '=', parent.id).execute();
  return {
    frameleaf: frameleaf.sut,
    sessions: sessions.sut,
    sessionAccounts: sessions.ctx.get(FrameleafAccountRepository),
    locks: { child: sessions.ctx.get(DatabaseRepository), unlink: frameleaf.ctx.get(DatabaseRepository) },
    auth,
    childSessions,
  };
};

it('refuses the child when unlinking came first', async () => {
  const { frameleaf, sessions, auth, childSessions } = await setup();
  await frameleaf.unlink(auth);
  await expect(sessions.create(auth, {})).rejects.toBeInstanceOf(UnauthorizedException);
  await expect(childSessions()).resolves.toEqual([]);
});

it('ends the child when it came first', async () => {
  const { frameleaf, sessions, auth, childSessions } = await setup();
  const child = await sessions.create(auth, {});
  await expect(childSessions()).resolves.toEqual([{ id: child.id }]);
  await frameleaf.unlink(auth);
  await expect(childSessions()).resolves.toEqual([]);
});

it.each(['child', 'unlink'] as const)(
  'leaves no child when they overlap and the %s holds the lock first',
  async (first) => {
    const { frameleaf, sessions, sessionAccounts, locks, auth, childSessions } = await setup();
    const accounts = (frameleaf as unknown as { frameleafAccountRepository: FrameleafAccountRepository })
      .frameleafAccountRepository;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    // pause the first operation inside its locked section, then start the other one
    if (first === 'child') {
      const getLinkByUser = sessionAccounts.getLinkByUser.bind(sessionAccounts);
      vi.spyOn(sessionAccounts, 'getLinkByUser').mockImplementation(async (userId) => {
        entered.resolve();
        await resume.promise;
        return getLinkByUser(userId);
      });
    } else {
      const findSessions = accounts.findSessions.bind(accounts);
      vi.spyOn(accounts, 'findSessions').mockImplementation(async (filter) => {
        entered.resolve();
        await resume.promise;
        return findSessions(filter);
      });
    }
    // the second operation must actually be waiting for the link authority lock before the first one goes on
    const contending = Promise.withResolvers<void>();
    const second = first === 'child' ? locks.unlink : locks.child;
    const withLock = second.withLock.bind(second);
    vi.spyOn(second, 'withLock').mockImplementation((lock, callback) => {
      if (lock === DatabaseLock.FrameleafLinkAuthority) {
        contending.resolve();
      }
      return withLock(lock, callback);
    });
    const firstRun = first === 'child' ? sessions.create(auth, {}) : frameleaf.unlink(auth);
    await entered.promise;
    const secondRun = first === 'child' ? frameleaf.unlink(auth) : sessions.create(auth, {});
    await contending.promise;
    resume.resolve();
    const [firstResult, secondResult] = await Promise.allSettled([firstRun, secondRun]);
    const [childResult, unlinkResult] = first === 'child' ? [firstResult, secondResult] : [secondResult, firstResult];
    // the unlink always completes; the child is either made and then ended, or refused
    expect(unlinkResult.status).toBe('fulfilled');
    if (childResult.status === 'rejected') {
      expect(childResult.reason).toBeInstanceOf(UnauthorizedException);
    }

    await expect(childSessions()).resolves.toEqual([]);
  },
);
